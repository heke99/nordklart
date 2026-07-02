import { NextResponse } from 'next/server'
import { MarkInvoicePaidSchema } from '@/lib/api/schemas'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { findDuplicatePaymentCandidatesForInvoice } from '@/lib/invoices/duplicate-payment-candidates'
import { markInvoicePaid } from '@/lib/invoices/mark-paid-service'
import type { Invoice } from '@/types'

ensureInitialized()

/**
 * POST /api/invoices/[id]/mark-paid
 *
 * Manually marks an invoice as paid (for payments received outside bank
 * sync). Delegates the settlement to the shared mark-paid service — the same
 * orchestration the v1 API and the pending-operation executor use — so
 * partial payments, overpayment→kundsaldo, invoice_payments rows and race
 * handling behave identically across entry points.
 */
export const POST = withRouteContext(
  'invoice.mark_paid',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ invoiceId: id })

    const { data: invoice, error: invoiceError } = await supabase
      .from('invoices')
      .select('*, customer:customers(*)')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (invoiceError || !invoice) {
      return errorResponseFromCode('INVOICE_PAID_NOT_FOUND', opLog, { requestId })
    }

    if (
      invoice.status !== 'sent' &&
      invoice.status !== 'overdue' &&
      invoice.status !== 'partially_paid'
    ) {
      return errorResponseFromCode('INVOICE_PAID_NOT_PAYABLE', opLog, {
        requestId,
        details: { currentStatus: invoice.status },
      })
    }

    // Optional body. Backwards-compat: callers may POST with no body.
    let exchangeRateDifference: number | undefined
    let bodyPaymentDate: string | undefined
    let customLines: { account_number: string; debit_amount: number; credit_amount: number; line_description?: string }[] | undefined
    let force = false
    let rawBody: unknown
    try {
      const text = await request.text()
      if (text) rawBody = JSON.parse(text)
    } catch {
      // Empty / invalid body — fall through to defaults.
    }

    if (rawBody) {
      const parsed = MarkInvoicePaidSchema.safeParse(rawBody)
      if (!parsed.success) {
        opLog.warn('mark-paid validation failed', {
          issueCount: parsed.error.issues.length,
        })
        return NextResponse.json(
          { error: 'Ogiltig förfrågan', details: parsed.error.flatten() },
          { status: 400 },
        )
      }
      exchangeRateDifference = parsed.data.exchange_rate_difference
      bodyPaymentDate = parsed.data.payment_date
      customLines = parsed.data.lines
      force = parsed.data.force === true
    }

    const now = new Date().toISOString()
    const paymentDate = bodyPaymentDate || now.split('T')[0]

    // Duplicate-payment guard: surface a likely-matching unlinked inbound bank
    // transaction before booking. Skipped on partial payments (explicit,
    // deliberate action), on force=true, and on invoices without a resolved
    // customer name. Mirrors the supplier-side guard at
    // /api/supplier-invoices/[id]/mark-paid.
    const remainingAmount =
      (invoice as Invoice & { remaining_amount?: number }).remaining_amount ?? invoice.total
    const paymentAmount = customLines
      ? customLines.reduce((s, l) => s + l.debit_amount, 0)
      : remainingAmount
    const paidRounded = Math.round(paymentAmount * 100) / 100
    const remainingRounded = Math.round(remainingAmount * 100) / 100
    if (!force && paidRounded >= remainingRounded) {
      const customerName = (invoice as Invoice & { customer?: { name?: string } }).customer?.name
      if (!customerName) {
        opLog.warn('duplicate-payment guard skipped', {
          reason: 'missing_customer_name',
          invoiceId: id,
        })
      } else {
        const candidates = await findDuplicatePaymentCandidatesForInvoice(supabase, {
          companyId: companyId!,
          invoice: { invoice_number: invoice.invoice_number, customer_name: customerName },
          paymentAmount,
          paymentDate,
        })
        if (candidates.length > 0) {
          return errorResponseFromCode('INVOICE_PAID_LIKELY_DUPLICATE', opLog, {
            requestId,
            details: { candidates },
          })
        }
      }
    } else if (force) {
      opLog.warn('duplicate-payment guard bypassed', {
        reason: 'force=true',
        invoiceId: id,
        userId: user.id,
        paymentAmount,
      })
    }

    const result = await markInvoicePaid(supabase, companyId!, user.id, {
      invoiceId: id,
      paymentDate,
      exchangeRateDifference,
      customLines,
    })

    if (!result.ok) {
      if (result.bookkeepingError) {
        return errorResponse(result.bookkeepingError, opLog, { requestId })
      }
      return errorResponseFromCode(result.code, opLog, {
        requestId,
        details: result.details,
      })
    }

    return NextResponse.json({
      success: true,
      status: result.newStatus,
      paid_at: result.newStatus === 'paid' ? paymentDate : null,
      paid_amount: result.newPaidAmount,
      remaining_amount: result.newRemaining,
      applied_amount: result.appliedAmount,
      overpayment_amount: result.overpaymentAmount,
      customer_credit_id: result.customerCreditId,
      journal_entry_id: result.journalEntryId,
      ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    })
  },
  { requireWrite: true },
)
