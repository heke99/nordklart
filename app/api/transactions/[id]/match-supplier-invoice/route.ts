import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { MatchSupplierInvoiceSchema } from '@/lib/api/schemas'
import { settleSupplierInvoiceAtomic } from '@/lib/supplier-invoices/mark-paid-service'
import { logMatchEvent } from '@/lib/invoices/match-log'
import { eventBus } from '@/lib/events/bus'
import { ensureInitialized } from '@/lib/init'
import type { SupplierInvoice, SupplierInvoiceItem, Transaction } from '@/types'

ensureInitialized()

/**
 * Match a negative bank transaction to a supplier invoice through the
 * canonical PostgreSQL-owned settlement transaction.
 */
export const POST = withRouteContext(
  'transaction.match_supplier_invoice',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id: transactionId } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, MatchSupplierInvoiceSchema, {
      log,
      operation: 'transaction.match_supplier_invoice',
    })
    if (!validation.success) return validation.response
    const { supplier_invoice_id: supplierInvoiceId, lines: customLines } = validation.data
    const txLog = log.child({ transactionId, supplierInvoiceId })

    const { data: transaction, error: transactionError } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', transactionId)
      .eq('company_id', companyId)
      .single()
    if (transactionError || !transaction) {
      return errorResponseFromCode('TX_CATEGORIZE_TX_NOT_FOUND', txLog, { requestId })
    }
    if (Number(transaction.amount) >= 0) {
      return errorResponseFromCode('MATCH_SI_NOT_EXPENSE', txLog, {
        requestId,
        details: { amount: transaction.amount },
      })
    }
    if (transaction.supplier_invoice_id && transaction.supplier_invoice_id !== supplierInvoiceId) {
      return errorResponseFromCode('MATCH_SI_TX_ALREADY_LINKED', txLog, {
        requestId,
        details: { existingSupplierInvoiceId: transaction.supplier_invoice_id },
      })
    }

    const committedReplay = transaction.supplier_invoice_id === supplierInvoiceId
    if (transaction.journal_entry_id && !committedReplay) {
      return errorResponseFromCode('BANK_TRANSACTION_ALREADY_ALLOCATED', txLog, {
        requestId,
        details: { action: 'reverse_existing_voucher_first' },
      })
    }

    const { data: invoice, error: invoiceError } = await supabase
      .from('supplier_invoices')
      .select('*, supplier:suppliers(*), items:supplier_invoice_items(*)')
      .eq('id', supplierInvoiceId)
      .eq('company_id', companyId)
      .single()
    if (invoiceError || !invoice) {
      return errorResponseFromCode('MATCH_SI_NOT_FOUND', txLog, { requestId })
    }

    const transactionAmount = Math.abs(Number(transaction.amount))
    const transactionCurrency = transaction.currency ?? 'SEK'
    const invoiceCurrency = invoice.currency ?? 'SEK'
    const paymentAmount = transactionCurrency === invoiceCurrency
      ? transactionAmount
      : Number(invoice.remaining_amount)
    if (!committedReplay && paymentAmount > Number(invoice.remaining_amount) + 0.005) {
      return errorResponseFromCode('MATCH_SI_AMOUNT_EXCEEDS_REMAINING', txLog, {
        requestId,
        details: {
          transaction_amount: paymentAmount,
          remaining_amount: Number(invoice.remaining_amount),
        },
      })
    }

    const bookedSek = invoiceCurrency === 'SEK'
      ? paymentAmount
      : Math.round(paymentAmount * Number(invoice.exchange_rate ?? 1) * 100) / 100
    const actualBankSek = transactionCurrency === 'SEK'
      ? transactionAmount
      : Number(transaction.amount_sek != null ? Math.abs(transaction.amount_sek) : bookedSek)
    const exchangeRateDifference = invoiceCurrency === 'SEK'
      ? 0
      : Math.round((bookedSek - actualBankSek) * 100) / 100

    const { data: settings } = await supabase
      .from('company_settings')
      .select('accounting_method')
      .eq('company_id', companyId)
      .maybeSingle()
    const unbookedCashInvoice = !invoice.registration_journal_entry_id
      && settings?.accounting_method === 'cash'
    if (!customLines && unbookedCashInvoice && invoiceCurrency !== 'SEK') {
      return errorResponseFromCode('VALIDATION_ERROR', txLog, {
        requestId,
        details: {
          field: 'lines',
          message: 'Betalning av utländsk kontantmetodsfaktura kräver balanserade SEK-rader med betalningsdagens kurs.',
        },
      })
    }

    const supplierRow = Array.isArray(invoice.supplier)
      ? (invoice.supplier[0] ?? null)
      : invoice.supplier
    const result = await settleSupplierInvoiceAtomic(
      supabase,
      companyId,
      user.id,
      {
        invoice: {
          ...invoice,
          supplier: supplierRow,
          items: (invoice.items ?? []) as SupplierInvoiceItem[],
        } as SupplierInvoice & {
          supplier?: { id?: string; name?: string; supplier_type?: string } | null
          items?: SupplierInvoiceItem[]
        },
        paymentDate: transaction.date,
        paymentAmount,
        ledgerPaymentAmount: bookedSek,
        exchangeRateDifference,
        customLines,
        transactionId,
        paymentReference: transaction.reference ?? null,
        idempotencyKey: `bank-match:supplier:${transactionId}:${supplierInvoiceId}`,
        requestId,
      },
    )
    if (!result.ok) {
      if (result.bookkeepingError) {
        return errorResponse(result.bookkeepingError, txLog, { requestId })
      }
      const mappedCode = result.code === 'SI_NOT_FOUND'
        ? 'MATCH_SI_NOT_FOUND'
        : result.code === 'SI_PAID_NOT_PAYABLE'
          ? 'MATCH_SI_NOT_OPEN'
          : result.code
      return errorResponseFromCode(mappedCode, txLog, {
        requestId,
        details: result.details,
      })
    }

    logMatchEvent(supabase, user.id, transactionId, 'matched', {
      supplierInvoiceId,
      matchConfidence: 1,
      matchMethod: 'manual_confirm_atomic',
      newState: {
        status: result.status,
        paid_amount: result.paidAmount,
        remaining_amount: result.remainingAmount,
        journal_entry_id: result.journalEntryId,
      },
    })
    try {
      eventBus.emit({
        type: 'supplier_invoice.match_confirmed',
        payload: {
          supplierInvoice: invoice as SupplierInvoice,
          transaction: transaction as Transaction,
          userId: user.id,
          companyId,
        },
      })
    } catch (error) {
      txLog.warn('match confirmation event dispatch failed; durable payment outbox retained', error as Error)
    }

    return Response.json({
      success: true,
      invoice_status: result.status,
      paid_amount: result.paidAmount,
      remaining_amount: result.remainingAmount,
      journal_entry_id: result.journalEntryId,
      request_id: requestId,
    })
  },
  { requireWrite: true },
)
