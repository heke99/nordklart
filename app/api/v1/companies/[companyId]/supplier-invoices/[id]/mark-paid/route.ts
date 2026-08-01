/**
 * POST /api/v1/companies/{companyId}/supplier-invoices/{id}/mark-paid
 *
 * Records a supplier payment through the canonical database-owned settlement
 * transaction. Journal posting, payment allocation, AP balance, bank linkage,
 * audit and outbox either commit together or roll back together.
 *
 * Idempotent (mandatory Idempotency-Key). Dry-runnable.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { MarkSupplierInvoicePaidSchema } from '@/lib/api/schemas'
import { settleSupplierInvoiceAtomic } from '@/lib/supplier-invoices/mark-paid-service'

const PAYABLE_STATUSES = ['registered', 'approved', 'partially_paid', 'overdue'] as const

const SupplierInvoicePaidResponse = z.object({
  id: z.string().uuid(),
  status: z.enum(['paid', 'partially_paid']),
  total: z.number(),
  paid_amount: z.number(),
  remaining_amount: z.number(),
  paid_at: z.string().nullable(),
  payment_journal_entry_id: z.string().uuid().nullable(),
})

registerEndpoint({
  operation: 'supplier-invoices.mark-paid',
  method: 'POST',
  path: '/api/v1/companies/:companyId/supplier-invoices/:id/mark-paid',
  summary: 'Record a payment against a supplier invoice.',
  description:
    'Atomically posts the payment journal entry (Debit 2440 / Credit 1930 under accrual, or cash-basis expense/VAT recognition), creates the allocation and updates AP. The database transaction owns all economic writes. Idempotent and dry-runnable.',
  useWhen:
    'You paid a registered or approved leverantörsfaktura through a channel other than the synced bank flow. For bank-matched payments use POST /transactions/{id}/match-supplier-invoice instead — that path also reconciles the bank line.',
  doNotUseFor:
    'Refunding a payment (the public API does not expose unmark-paid; credit the SI instead). Paying a credited or already-paid SI (returns 409 SI_PAID_ALREADY).',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'payment_date must fall in an open fiscal period — locked period returns 400 PERIOD_LOCKED.',
    'exchange_rate_difference (SEK delta vs the booked rate at registration) is required for foreign-currency SIs to book the FX gain/loss to 3960 / 7960. Omitting it on a non-SEK SI under accrual mis-books FX.',
    'A failure in posting, allocation, AP update, bank linkage, audit or outbox rolls back the entire settlement.',
    'Cash basis (kontantmetoden) recognizes the expense + ingående moms HERE, not at :create.',
  ],
  example: {
    request: { payment_date: '2026-05-13' },
    response: {
      data: {
        id: '0e9c…',
        status: 'paid',
        total: 1250,
        paid_amount: 1250,
        remaining_amount: 0,
        paid_at: '2026-05-13',
        payment_journal_entry_id: '7b3a…',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'suppliers:write',
  risk: 'medium',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  request: { body: MarkSupplierInvoicePaidSchema },
  response: { success: SupplierInvoicePaidResponse },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'supplier-invoices.mark-paid',
  async (request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Supplier-invoice id must be a UUID.' },
      })
    }
    const invoiceId = idParse.data

    // Body is optional — empty POST = pay the full remaining_amount today.
    let rawBody: unknown = null
    try {
      const text = await request.text()
      if (text.trim()) rawBody = JSON.parse(text)
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }

    let bodyAmount: number | undefined
    let bodyPaymentDate: string | undefined
    let exchangeRateDifference: number | undefined
    let bodyNotes: string | undefined
    let customLines:
      | Array<{ account_number: string; debit_amount: number; credit_amount: number; line_description?: string }>
      | undefined
    if (rawBody) {
      const parsed = MarkSupplierInvoicePaidSchema.safeParse(rawBody)
      if (!parsed.success) {
        return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
          requestId: ctx.requestId,
          details: {
            issues: parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              message: i.message,
            })),
          },
        })
      }
      bodyAmount = parsed.data.amount
      bodyPaymentDate = parsed.data.payment_date
      exchangeRateDifference = parsed.data.exchange_rate_difference
      bodyNotes = parsed.data.notes
      customLines = parsed.data.lines
    }

    const today = new Date().toISOString().split('T')[0]
    const paymentDate = bodyPaymentDate || today

    // Reject future payment_date at the schema layer. BFL 5 kap 2 §
    // requires bokföring to follow real cash movement; a payment booked
    // in the future is a scheduling artefact, not an affärshändelse.
    // No legitimate v1 workflow needs to backstamp tomorrow; if the user
    // wants to schedule, that's a different surface.
    if (paymentDate > today) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'payment_date',
          message: 'payment_date cannot be in the future.',
          attempted: paymentDate,
          today,
        },
      })
    }

    // Fetch SI with supplier + items (needed by the engine for cash-basis).
    const { data: invoice, error: fetchErr } = await ctx.supabase
      .from('supplier_invoices')
      .select(`
        id, supplier_id, status, currency, exchange_rate, total, paid_amount, remaining_amount,
        supplier_invoice_number, arrival_number, invoice_date, vat_treatment, reverse_charge,
        subtotal, subtotal_sek, vat_amount, vat_amount_sek, total_sek, due_date, received_date,
        is_credit_note, credited_invoice_id, registration_journal_entry_id, payment_journal_entry_id,
        supplier:suppliers(id, name, supplier_type),
        items:supplier_invoice_items(id, sort_order, description, quantity, unit, unit_price, line_total, account_number, vat_code, vat_rate, vat_amount, reverse_charge_rate)
      `)
      .eq('company_id', ctx.companyId!)
      .eq('id', invoiceId)
      .maybeSingle()

    if (fetchErr) {
      return v1ErrorResponse(fetchErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!invoice) {
      return v1ErrorResponseFromCode('SI_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    }

    type SupplierObj = { id: string; name: string; supplier_type: string }
    type SI = {
      id: string
      supplier_id: string
      status: string
      currency: string
      total: number
      paid_amount: number
      remaining_amount: number
      supplier_invoice_number: string
      arrival_number: number
      invoice_date: string
      is_credit_note: boolean
      registration_journal_entry_id?: string | null
      supplier: SupplierObj | SupplierObj[] | null
      items?: unknown[]
    } & Record<string, unknown>

    const typed = invoice as unknown as SI

    if (typed.is_credit_note) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Credit notes cannot be marked paid.' },
      })
    }

    if (!PAYABLE_STATUSES.includes(typed.status as (typeof PAYABLE_STATUSES)[number])) {
      const code = typed.status === 'paid' || typed.status === 'credited' || typed.status === 'reversed'
        ? 'SI_PAID_ALREADY'
        : 'SI_PAID_NOT_PAYABLE'
      return v1ErrorResponseFromCode(code, ctx.log, {
        requestId: ctx.requestId,
        details: { current_status: typed.status },
      })
    }

    // Application-layer period-lock pre-check.
    const lockVerdict = await checkPeriodLock(ctx.supabase, ctx.companyId!, paymentDate)
    if (lockVerdict.locked) {
      return v1ErrorResponseFromCode('SI_PAID_PERIOD_LOCKED', ctx.log, {
        requestId: ctx.requestId,
        details: {
          reason: lockVerdict.reason,
          fiscal_period_id: lockVerdict.fiscal_period_id,
          payment_date: paymentDate,
        },
      })
    }

    const paymentAmount = bodyAmount != null
      ? Math.round(bodyAmount * 100) / 100
      : Math.round(typed.remaining_amount * 100) / 100

    if (paymentAmount <= 0) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'amount', message: 'amount must be positive.' },
      })
    }

    // Reject overpayment up front. Without this, the silent `Math.max(0, ...)`
    // clamp below would book the full payment_amount in the JE but only
    // reduce the SI balance to 0 — the difference would be an unnordklart
    // overpayment on the 2440 ledger. If a refund is genuinely due, the
    // caller credits the SI (which reverses the obligation) and books the
    // refund as a separate bank transaction. Half-öre tolerance allows
    // legitimate rounding artefacts from FX-difference adjustments.
    if (paymentAmount > typed.remaining_amount + 0.005) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'amount',
          message:
            'amount exceeds remaining_amount. Issue a credit note via :credit for over-billing, or book the refund through the transactions endpoints.',
          attempted: paymentAmount,
          remaining_amount: typed.remaining_amount,
        },
      })
    }

    const newRemaining = Math.max(
      0,
      Math.round((typed.remaining_amount - paymentAmount) * 100) / 100,
    )
    // Half-öre epsilon — same convention as v1 invoices.mark-paid.
    const newStatus: 'paid' | 'partially_paid' = newRemaining <= 0.005 ? 'paid' : 'partially_paid'
    const newPaidAmount = Math.round((typed.paid_amount + paymentAmount) * 100) / 100

    // Settings fetch hoisted ahead of the dry-run branch so the FX-required
    // check below fires in both preview and commit modes (and so dry-run can
    // surface the requirement before a caller learns it the hard way).
    const { data: settings } = await ctx.supabase
      .from('company_settings')
      .select('accounting_method')
      .eq('company_id', ctx.companyId!)
      .maybeSingle()
    const accountingMethod = (settings as { accounting_method?: string } | null)?.accounting_method ?? 'accrual'

    // Route on the supplier invoice's actual booking state — if 2440 was
    // posted at receipt, payment must clear 2440 regardless of the current
    // accounting_method.
    const siAlreadyBooked = !!(typed as { registration_journal_entry_id?: string | null }).registration_journal_entry_id
    const useCashEntry = !siAlreadyBooked && accountingMethod === 'cash'

    // FX-required validation. Whenever the registration JE used the invoice's
    // exchange rate to compute subtotal_sek (i.e. the SI was booked under
    // accrual or migrated from accrual), the payment JE has to book any rate
    // delta to 3960 / 7960 or AP will carry a stranded 2440 balance after the
    // bank line clears. Gated on the booking state, not the current setting.
    if (
      typed.currency !== 'SEK' &&
      !useCashEntry &&
      exchangeRateDifference === undefined
    ) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: [{
            field: 'exchange_rate_difference',
            message:
              'exchange_rate_difference (SEK delta vs the registration rate) is required when paying a non-SEK supplier invoice under faktureringsmetoden. Use 0 if there is no rate movement.',
          }],
          invoice_currency: typed.currency,
        },
      })
    }

    if (ctx.dryRun) {
      // paid_at: the live UPDATE writes `new Date().toISOString()` (a full UTC
      // timestamp). Mirror that shape here so callers validating dry-run vs
      // live against the same regex don't see surprises. payment_date stays
      // ISO date because it represents the user-supplied calendar date.
      return dryRunPreview(
        {
          ...typed,
          status: newStatus,
          paid_amount: newPaidAmount,
          remaining_amount: newRemaining,
          paid_at: newStatus === 'paid' ? new Date().toISOString() : null,
          payment_date: paymentDate,
          payment_amount: paymentAmount,
          would_create_payment_journal_entry: true,
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    const supplierRow = Array.isArray(typed.supplier)
      ? (typed.supplier[0] ?? null)
      : typed.supplier

    const result = await settleSupplierInvoiceAtomic(
      ctx.supabase,
      ctx.companyId!,
      ctx.userId,
      {
        invoice: {
          ...typed,
          supplier: supplierRow,
          items: (typed.items ?? []) as never,
        } as never,
        paymentDate,
        paymentAmount,
        exchangeRateDifference,
        customLines,
        notes: bodyNotes,
        idempotencyKey: ctx.idempotencyKey!,
        requestId: ctx.requestId,
      },
    )

    if (!result.ok) {
      if (result.bookkeepingError) {
        return v1ErrorResponse(result.bookkeepingError, ctx.log, { requestId: ctx.requestId })
      }
      return v1ErrorResponseFromCode(result.code, ctx.log, {
        requestId: ctx.requestId,
        details: result.details,
      })
    }

    return ok(
      {
        id: typed.id,
        supplier_id: typed.supplier_id,
        arrival_number: typed.arrival_number,
        supplier_invoice_number: typed.supplier_invoice_number,
        status: result.status,
        currency: typed.currency,
        total: typed.total,
        paid_amount: result.paidAmount,
        remaining_amount: result.remainingAmount,
        paid_at: result.paidAt,
        payment_journal_entry_id: result.journalEntryId,
      },
      { requestId: ctx.requestId },
    )
  },
  { requireIdempotencyKey: true },
)
