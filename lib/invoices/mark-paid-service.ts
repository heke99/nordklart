/**
 * Shared customer-invoice payment orchestration ("mark paid").
 *
 * ONE implementation of the full settlement flow — used by the dashboard
 * route, the v1 API route and the pending-operation executor so partial
 * payments, overpayment→customer credit, underpayment ledger rows,
 * invoice_payments bookkeeping, race handling and event emission cannot
 * drift between entry points.
 *
 * Journal shapes:
 *   - Custom lines (partial payment dialogs)        → createJournalEntry
 *   - Overpayment                                   → payment + 2893/2440-style
 *                                                     customer-credit lines
 *   - Kontantmetoden (invoice never booked)         → createInvoiceCashEntry
 *   - Faktureringsmetoden (invoice booked at send)  → createInvoicePaymentJournalEntry
 *
 * The JE shape is driven by the INVOICE's booking state, not the company's
 * current accounting_method — an invoice booked at send must clear 1510 at
 * payment even if the company has since flipped to kontantmetoden.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  createInvoiceCashEntry,
  createInvoicePaymentJournalEntry,
} from '@/lib/bookkeeping/invoice-entries'
import { createJournalEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { buildInvoicePaymentWithCustomerCreditLines } from '@/lib/bookkeeping/customer-overpayment-lines'
import { planInvoiceCustomerPayment } from '@/lib/invoices/customer-payment-allocation'
import {
  recordCustomerOverpayment,
  recordInvoiceUnderpayment,
} from '@/lib/invoices/customer-credit-recording'
import { eventBus } from '@/lib/events'
import { computePreviousAttributes } from '@/lib/webhooks/diff'
import { createLogger } from '@/lib/logger'
import type { CreateJournalEntryInput, EntityType, Invoice } from '@/types'

const log = createLogger('invoices/mark-paid')

export interface MarkPaidCustomLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  line_description?: string
}

export interface MarkPaidRequest {
  invoiceId: string
  /** ISO date; defaults to today. */
  paymentDate?: string
  /**
   * Explicit payment amount (invoice currency). Defaults to the custom-lines
   * debit total when lines are supplied, else the invoice's remaining amount.
   */
  paymentAmount?: number
  /** SEK adjustment for foreign-currency invoices. */
  exchangeRateDifference?: number
  customLines?: MarkPaidCustomLine[]
  notes?: string
  /** Bank transaction to link on the invoice_payments row, when applicable. */
  transactionId?: string | null
}

export interface MarkPaidWarning {
  code: string
  message: string
}

export type MarkPaidFailure = {
  ok: false
  code:
    | 'INVOICE_PAID_NOT_FOUND'
    | 'INVOICE_PAID_NOT_PAYABLE'
    | 'INVOICE_PAID_LINES_UNBALANCED'
    | 'INVOICE_PAID_NO_FISCAL_PERIOD'
    | 'INVOICE_PAID_BOOK_FAILED'
    | 'INVOICE_PAID_RACE'
    | 'VALIDATION_ERROR'
  details?: Record<string, unknown>
  /** Set when the engine threw a typed bookkeeping error (period lock etc.). */
  bookkeepingError?: unknown
}

export interface MarkPaidSuccess {
  ok: true
  invoice: Invoice
  journalEntryId: string | null
  paymentId: string | null
  appliedAmount: number
  overpaymentAmount: number
  newStatus: 'paid' | 'partially_paid'
  newPaidAmount: number
  newRemaining: number
  customerCreditId: string | null
  warnings: MarkPaidWarning[]
}

export type MarkPaidResult = MarkPaidSuccess | MarkPaidFailure

type LoadedInvoice = Invoice & {
  customer?: { id?: string; name?: string } | null
  items?: unknown[]
}

/**
 * Preflight: load + verify the invoice and plan the allocation. Shared by
 * the commit path and callers that need a dry-run preview.
 */
export async function prepareMarkInvoicePaid(
  supabase: SupabaseClient,
  companyId: string,
  request: MarkPaidRequest,
): Promise<
  | {
      ok: true
      invoice: LoadedInvoice
      paymentDate: string
      paymentAmount: number
      allocation: ReturnType<typeof planInvoiceCustomerPayment>
      accountingMethod: string
      entityType: EntityType
      useCashEntry: boolean
      isRealInvoice: boolean
    }
  | MarkPaidFailure
> {
  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .eq('id', request.invoiceId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (invoiceError || !invoice) {
    return { ok: false, code: 'INVOICE_PAID_NOT_FOUND' }
  }
  const typed = invoice as LoadedInvoice

  if (typed.document_type === 'delivery_note') {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { field: 'document_type', message: 'Följesedlar har ingen betalningslivscykel.' },
    }
  }
  if (typed.credited_invoice_id) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      details: {
        field: 'credited_invoice_id',
        message: 'Kreditfakturor kan inte markeras som betalda.',
      },
    }
  }
  if (typed.status !== 'sent' && typed.status !== 'overdue' && typed.status !== 'partially_paid') {
    return {
      ok: false,
      code: 'INVOICE_PAID_NOT_PAYABLE',
      details: { current_status: typed.status },
    }
  }

  if (request.customLines) {
    const totalDebit = request.customLines.reduce((s, l) => s + l.debit_amount, 0)
    const totalCredit = request.customLines.reduce((s, l) => s + l.credit_amount, 0)
    if (Math.round((totalDebit - totalCredit) * 100) !== 0 || totalDebit <= 0) {
      return {
        ok: false,
        code: 'INVOICE_PAID_LINES_UNBALANCED',
        details: { total_debit: totalDebit, total_credit: totalCredit },
      }
    }
  }

  const paymentDate = request.paymentDate || new Date().toISOString().split('T')[0]

  const { data: settings } = await supabase
    .from('company_settings')
    .select('accounting_method, entity_type')
    .eq('company_id', companyId)
    .maybeSingle()
  const accountingMethod =
    (settings as { accounting_method?: string } | null)?.accounting_method ?? 'accrual'
  const entityType = ((settings as { entity_type?: string } | null)?.entity_type ??
    'enskild_firma') as EntityType

  const invoiceAlreadyBooked = !!(typed as { journal_entry_id?: string | null }).journal_entry_id
  const useCashEntryCandidate = !invoiceAlreadyBooked && accountingMethod === 'cash'

  // Default path uses remaining_amount, not total — protects against
  // over-crediting AR when a concurrent partial payment slipped past the
  // pre-flight (the race-guard UPDATE later still protects the status flip).
  const paymentAmount =
    request.paymentAmount ??
    (request.customLines
      ? request.customLines.reduce((sum, line) => sum + line.debit_amount, 0)
      : (typed.remaining_amount ?? typed.total))

  const allocation = planInvoiceCustomerPayment(typed, paymentAmount)

  if (allocation.overpaymentAmount > 0 && request.customLines) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      details: {
        field: 'lines',
        message:
          'Överbetalningar med egna rader måste bokas som manuell verifikation; utelämna raderna så bokförs kundsaldot automatiskt.',
        overpayment_amount: allocation.overpaymentAmount,
      },
    }
  }
  if (allocation.overpaymentAmount > 0 && useCashEntryCandidate) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      details: {
        field: 'amount',
        message:
          'Överbetalning på kontantmetodsfaktura utan tidigare verifikation kräver manuella bokföringsrader.',
        overpayment_amount: allocation.overpaymentAmount,
      },
    }
  }

  const useCashEntry =
    useCashEntryCandidate && allocation.isFullyPaid && allocation.overpaymentAmount === 0
  const isRealInvoice = !typed.document_type || typed.document_type === 'invoice'

  return {
    ok: true,
    invoice: typed,
    paymentDate,
    paymentAmount,
    allocation,
    accountingMethod,
    entityType,
    useCashEntry,
    isRealInvoice,
  }
}

/**
 * Full settlement: preflight + journal entry + invoice update (race-guarded)
 * + invoice_payments row + over/underpayment ledger + invoice.paid event.
 *
 * On a lost race AFTER the journal entry was posted, the orphaned entry is
 * cancelled and a voucher-gap explanation recorded (BFNAR 2013:2).
 */
export async function markInvoicePaid(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  request: MarkPaidRequest,
): Promise<MarkPaidResult> {
  const prepared = await prepareMarkInvoicePaid(supabase, companyId, request)
  if (!prepared.ok) return prepared

  const {
    invoice: typed,
    paymentDate,
    paymentAmount,
    allocation,
    entityType,
    useCashEntry,
    isRealInvoice,
  } = prepared
  const { appliedAmount, overpaymentAmount, newPaidAmount, newRemaining, newStatus } = allocation
  const warnings: MarkPaidWarning[] = []
  const invoiceId = typed.id

  // ── Step 1: journal entry ──────────────────────────────────────────────────
  let journalEntryId: string | null = null
  if (isRealInvoice) {
    try {
      if (request.customLines) {
        const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, paymentDate)
        if (!fiscalPeriodId) {
          return {
            ok: false,
            code: 'INVOICE_PAID_NO_FISCAL_PERIOD',
            details: { payment_date: paymentDate },
          }
        }
        const input: CreateJournalEntryInput = {
          fiscal_period_id: fiscalPeriodId,
          entry_date: paymentDate,
          description: typed.customer?.name
            ? `Inbetalning kundfaktura ${typed.invoice_number}, ${typed.customer.name}`
            : `Inbetalning kundfaktura ${typed.invoice_number}`,
          source_type: useCashEntry ? 'invoice_cash_payment' : 'invoice_paid',
          source_id: invoiceId,
          lines: request.customLines.map((l) => ({
            account_number: l.account_number,
            debit_amount: l.debit_amount,
            credit_amount: l.credit_amount,
            line_description: l.line_description ?? undefined,
          })),
        }
        const entry = await createJournalEntry(supabase, companyId, userId, input)
        journalEntryId = entry?.id ?? null
      } else if (overpaymentAmount > 0) {
        const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, paymentDate)
        if (!fiscalPeriodId) {
          return {
            ok: false,
            code: 'INVOICE_PAID_NO_FISCAL_PERIOD',
            details: { payment_date: paymentDate },
          }
        }
        const desc = typed.customer?.name
          ? `Inbetalning kundfaktura ${typed.invoice_number}, ${typed.customer.name}`
          : `Inbetalning kundfaktura ${typed.invoice_number}`
        const entry = await createJournalEntry(supabase, companyId, userId, {
          fiscal_period_id: fiscalPeriodId,
          entry_date: paymentDate,
          description: `${desc} med överbetalning`,
          source_type: 'invoice_paid',
          source_id: invoiceId,
          lines: buildInvoicePaymentWithCustomerCreditLines({
            bankAmount: paymentAmount,
            invoiceSettlementAmount: appliedAmount,
            customerCreditAmount: overpaymentAmount,
            description: desc,
          }),
        })
        journalEntryId = entry?.id ?? null
      } else if (useCashEntry) {
        const entry = await createInvoiceCashEntry(
          supabase,
          companyId,
          userId,
          typed as Invoice,
          paymentDate,
          entityType,
          typed.customer?.name,
        )
        journalEntryId = entry?.id ?? null
      } else {
        const entry = await createInvoicePaymentJournalEntry(
          supabase,
          companyId,
          userId,
          typed as Invoice,
          paymentDate,
          request.exchangeRateDifference,
          typed.customer?.name,
          appliedAmount,
        )
        journalEntryId = entry?.id ?? null
      }

      if (!journalEntryId) {
        warnings.push({
          code: 'JOURNAL_ENTRY_NOT_POSTED',
          message:
            'Betalningsverifikationen kunde inte skapas (troligen saknas öppen räkenskapsperiod). Kontrollera perioden och bokför manuellt vid behov.',
        })
      }
    } catch (err) {
      if (isBookkeepingError(err)) {
        return {
          ok: false,
          code: 'INVOICE_PAID_BOOK_FAILED',
          details: { reason: err instanceof Error ? err.message : 'unknown' },
          bookkeepingError: err,
        }
      }
      log.error('mark-paid: journal entry creation failed', err as Error, {
        invoiceId,
        companyId,
      })
      return {
        ok: false,
        code: 'INVOICE_PAID_BOOK_FAILED',
        details: { reason: err instanceof Error ? err.message : 'unknown' },
      }
    }
  }

  // ── Step 2: race-guarded invoice update ────────────────────────────────────
  const updatePayload: Record<string, unknown> = {
    status: newStatus,
    remaining_amount: newRemaining,
    paid_amount: newPaidAmount,
    updated_at: new Date().toISOString(),
  }
  if (newStatus === 'paid') updatePayload.paid_at = paymentDate
  if (journalEntryId) updatePayload.journal_entry_id = journalEntryId

  const { data: updated, error: updateErr } = await supabase
    .from('invoices')
    .update(updatePayload)
    .eq('company_id', companyId)
    .eq('id', invoiceId)
    .in('status', ['sent', 'overdue', 'partially_paid'])
    .select('*')
    .maybeSingle()

  if (updateErr) {
    log.error('mark-paid: invoice update failed', updateErr as Error, { invoiceId, companyId })
    return { ok: false, code: 'INVOICE_PAID_BOOK_FAILED' }
  }
  if (!updated) {
    // Race: status transitioned between read and write. Cancel the orphaned
    // JE and document the voucher gap (BFNAR 2013:2) before reporting back.
    if (journalEntryId) {
      try {
        const { data: orphan } = await supabase
          .from('journal_entries')
          .select('fiscal_period_id, voucher_series, voucher_number')
          .eq('id', journalEntryId)
          .single()

        await supabase
          .from('journal_entries')
          .update({ status: 'cancelled' })
          .eq('id', journalEntryId)

        if (orphan) {
          await supabase.from('voucher_gap_explanations').insert({
            company_id: companyId,
            fiscal_period_id: orphan.fiscal_period_id,
            voucher_series: orphan.voucher_series || 'A',
            gap_number: orphan.voucher_number,
            explanation:
              'Automatiskt makulerad: dubblettbokning förhindrad av samtidighetsskydd',
            created_by: userId,
          })
        }
      } catch (cleanupErr) {
        log.error('mark-paid: orphaned JE cleanup failed', cleanupErr as Error, {
          invoiceId,
          journalEntryId,
        })
      }
    }
    return { ok: false, code: 'INVOICE_PAID_RACE' }
  }

  // ── Step 3: invoice_payments row + AR adjustment ledger ────────────────────
  let paymentId: string | null = null
  const { data: paymentRow, error: paymentInsertErr } = await supabase
    .from('invoice_payments')
    .insert({
      user_id: userId,
      company_id: companyId,
      invoice_id: invoiceId,
      payment_date: paymentDate,
      amount: appliedAmount,
      currency: typed.currency,
      exchange_rate: typed.exchange_rate,
      exchange_rate_difference: request.exchangeRateDifference ?? 0,
      journal_entry_id: journalEntryId,
      transaction_id: request.transactionId ?? null,
      notes: request.notes ?? null,
    })
    .select('id')
    .single()

  if (paymentInsertErr) {
    log.error('mark-paid: invoice payment row insert failed', paymentInsertErr as Error, {
      invoiceId,
      companyId,
    })
    warnings.push({
      code: 'PAYMENT_ROW_NOT_RECORDED',
      message:
        'Betalningen bokfördes men betalningsraden kunde inte sparas. Kontrollera kundreskontran.',
    })
  } else {
    paymentId = (paymentRow as { id?: string } | null)?.id ?? null
  }

  let customerCreditId: string | null = null
  try {
    if (overpaymentAmount > 0) {
      const result = await recordCustomerOverpayment(supabase, {
        userId,
        companyId,
        customerId: typed.customer_id ?? null,
        invoiceId,
        paymentId,
        journalEntryId,
        amount: overpaymentAmount,
        currency: typed.currency,
        notes: `Överbetalning ${overpaymentAmount} ${typed.currency} på faktura ${typed.invoice_number}.`,
      })
      customerCreditId = result.creditId
    } else if (newRemaining > 0) {
      await recordInvoiceUnderpayment(supabase, {
        userId,
        companyId,
        invoiceId,
        paymentId,
        journalEntryId,
        amount: newRemaining,
        currency: typed.currency,
        notes: `Restbelopp ${newRemaining} ${typed.currency} kvar efter delbetalning.`,
      })
    }
  } catch (adjustmentErr) {
    log.error('mark-paid: payment adjustment ledger write failed', adjustmentErr as Error, {
      invoiceId,
      companyId,
    })
    warnings.push({
      code: 'PAYMENT_ADJUSTMENT_NOT_RECORDED',
      message:
        'Betalningen bokfördes men justeringsraden i reskontran kunde inte skapas. Kontrollera kundsaldot manuellt.',
    })
  }

  // ── Step 4: emit invoice.paid (best effort) ────────────────────────────────
  try {
    await eventBus.emit({
      type: 'invoice.paid',
      payload: {
        invoice: updated as unknown as Invoice,
        companyId,
        userId,
        paymentAmount: appliedAmount,
        paymentDate,
        // Stripe-style diff: prior values of the fields the payment changed
        // (status, paid_amount, remaining_amount, paid_at). Delivered in the
        // webhook row's previous_attributes column.
        previousAttributes: computePreviousAttributes(
          typed as unknown as Record<string, unknown>,
          updated as unknown as Record<string, unknown>,
        ),
      },
    })
  } catch (err) {
    log.error('invoice.paid emit failed', err as Error, { invoiceId, companyId })
    warnings.push({
      code: 'EVENT_EMIT_FAILED',
      message: 'invoice.paid-händelsen nådde inte händelsebussen.',
    })
  }

  return {
    ok: true,
    invoice: updated as unknown as Invoice,
    journalEntryId,
    paymentId,
    appliedAmount,
    overpaymentAmount,
    newStatus,
    newPaidAmount,
    newRemaining,
    customerCreditId,
    warnings,
  }
}
