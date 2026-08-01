import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { MarkSupplierInvoicePaidSchema } from '@/lib/api/schemas'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { settleSupplierInvoiceAtomic } from '@/lib/supplier-invoices/mark-paid-service'
import {
  DUPLICATE_AMOUNT_TOLERANCE_PCT,
  DUPLICATE_DATE_WINDOW_DAYS,
  escapeLikePattern,
} from '@/lib/invoices/duplicate-payment-guard'
import type { SupplierInvoice } from '@/types'

ensureInitialized()

export const POST = withRouteContext(
  'supplier_invoice.mark_paid',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ supplierInvoiceId: id })

    const validation = await validateBody(request, MarkSupplierInvoicePaidSchema, {
      log: opLog,
      operation: 'supplier_invoice.mark_paid',
    })
    if (!validation.success) return validation.response
    const body = validation.data

    const { data: invoice, error: fetchError } = await supabase
      .from('supplier_invoices')
      .select('*, supplier:suppliers(*), items:supplier_invoice_items(*)')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (fetchError || !invoice) {
      return errorResponseFromCode('SI_NOT_FOUND', opLog, { requestId })
    }

    if (!['registered', 'approved', 'partially_paid', 'overdue'].includes(invoice.status)) {
      return errorResponseFromCode('SI_PAID_NOT_PAYABLE', opLog, {
        requestId,
        details: { currentStatus: invoice.status },
      })
    }

    const paymentDate = body.payment_date || new Date().toISOString().split('T')[0]
    const paymentAmount = body.amount || invoice.remaining_amount

    if (body.force) {
      opLog.warn('duplicate-payment guard bypassed', {
        reason: 'force=true',
        paymentAmount,
        paymentDate,
      })
    }

    // Duplicate-payment guard: if a likely-matching unlinked bank transaction
    // exists for this supplier, surface it before booking a new payment entry.
    // Caller can override with `force: true`. Skipped on partial payments —
    // those are an explicit, deliberate action.
    const paidRounded = Math.round(paymentAmount * 100) / 100
    const remainingRounded = Math.round(invoice.remaining_amount * 100) / 100
    if (!body.force && paidRounded >= remainingRounded) {
      const supplierName = (invoice as SupplierInvoice & { supplier?: { name?: string } })
        .supplier?.name
      if (!supplierName) {
        // An invoice without a resolved supplier name is arguably *higher* risk
        // for duplicate booking, not lower (BFL 5 kap 7 § — motpart should be
        // identifiable). Log the skip so the gap is visible in audit.
        opLog.warn('duplicate-payment guard skipped', {
          reason: 'missing_supplier_name',
          supplierInvoiceId: id,
        })
      }
      if (supplierName) {
        const windowLow = Math.round(paymentAmount * (1 - DUPLICATE_AMOUNT_TOLERANCE_PCT) * 100) / 100
        const windowHigh = Math.round(paymentAmount * (1 + DUPLICATE_AMOUNT_TOLERANCE_PCT) * 100) / 100
        const dateMs = new Date(paymentDate).getTime()
        const dateLow = new Date(dateMs - DUPLICATE_DATE_WINDOW_DAYS * 24 * 3600 * 1000).toISOString().split('T')[0]
        const dateHigh = new Date(dateMs + DUPLICATE_DATE_WINDOW_DAYS * 24 * 3600 * 1000).toISOString().split('T')[0]
        const escapedSupplierName = escapeLikePattern(supplierName)

        const { data: candidates } = await supabase
          .from('transactions')
          .select('id, date, amount, description, merchant_name')
          .eq('company_id', companyId!)
          .eq('is_business', true)
          .is('supplier_invoice_id', null)
          .is('invoice_id', null)
          .lt('amount', 0)
          .gte('amount', -windowHigh)
          .lte('amount', -windowLow)
          .gte('date', dateLow)
          .lte('date', dateHigh)
          .ilike('merchant_name', `%${escapedSupplierName}%`)
          .order('date', { ascending: false })
          .limit(5)

        if (candidates && candidates.length > 0) {
          return errorResponseFromCode('SI_PAID_LIKELY_DUPLICATE', opLog, {
            requestId,
            details: {
              candidates: candidates.map((c) => ({
                id: c.id,
                date: c.date,
                amount: c.amount,
                description: c.description,
                merchant_name: c.merchant_name,
              })),
            },
          })
        }
      }
    }

    const { data: settings } = await supabase
      .from('company_settings')
      .select('last_supplier_payment_account')
      .eq('company_id', companyId)
      .maybeSingle()

    const paymentAccount = body.payment_account || undefined
    const result = await settleSupplierInvoiceAtomic(supabase, companyId!, user.id, {
      invoice: invoice as never,
      paymentDate,
      paymentAmount,
      exchangeRateDifference: body.exchange_rate_difference,
      paymentAccount,
      customLines: body.lines,
      notes: body.notes,
      idempotencyKey: request.headers.get('idempotency-key') || requestId,
      requestId,
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

    // User preference is deliberately outside the economic transaction. A
    // failure here cannot alter the already-committed supplier settlement.
    if (paymentAccount && paymentAccount !== settings?.last_supplier_payment_account) {
      const { error: settingsError } = await supabase
        .from('company_settings')
        .update({ last_supplier_payment_account: paymentAccount })
        .eq('company_id', companyId)
      if (settingsError) opLog.warn('failed to persist last_supplier_payment_account', settingsError)
    }

    return NextResponse.json({
      success: true,
      status: result.status,
      paid_amount: result.paidAmount,
      remaining_amount: result.remainingAmount,
      journal_entry_id: result.journalEntryId,
      payment_id: result.paymentId,
    })
  },
  { requireWrite: true },
)
