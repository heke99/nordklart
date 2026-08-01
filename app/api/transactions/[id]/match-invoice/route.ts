import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { MatchInvoiceSchema } from '@/lib/api/schemas'
import { markInvoicePaid } from '@/lib/invoices/mark-paid-service'
import { detectDuplicatePaymentVoucher } from '@/lib/invoices/duplicate-payment-detection'
import { logMatchEvent } from '@/lib/invoices/match-log'
import { eventBus } from '@/lib/events/bus'
import { ensureInitialized } from '@/lib/init'
import type { Currency, Invoice, Transaction } from '@/types'

ensureInitialized()

/**
 * Match a positive bank transaction to a customer invoice.
 *
 * This route deliberately contains no direct ledger, invoice-payment or
 * invoice-balance writes. The canonical settlement service stages an
 * unposted draft and commits posting, allocation, bank link, invoice state,
 * audit and outbox in one PostgreSQL transaction.
 */
export const POST = withRouteContext(
  'transaction.match_invoice',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id: transactionId } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, MatchInvoiceSchema, {
      log,
      operation: 'transaction.match_invoice',
    })
    if (!validation.success) return validation.response

    const {
      invoice_id: invoiceId,
      lines: customLines,
      manual_exchange_rate: manualExchangeRate,
      force,
    } = validation.data
    const txLog = log.child({ transactionId, invoiceId })

    const { data: transaction, error: transactionError } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', transactionId)
      .eq('company_id', companyId)
      .single()
    if (transactionError || !transaction) {
      return errorResponseFromCode('TX_CATEGORIZE_TX_NOT_FOUND', txLog, { requestId })
    }
    if (Number(transaction.amount) <= 0) {
      return errorResponseFromCode('MATCH_INVOICE_NOT_INCOME', txLog, {
        requestId,
        details: { amount: transaction.amount },
      })
    }
    if (transaction.invoice_id && transaction.invoice_id !== invoiceId) {
      return errorResponseFromCode('MATCH_INVOICE_TX_ALREADY_LINKED', txLog, {
        requestId,
        details: { existingInvoiceId: transaction.invoice_id },
      })
    }

    const committedReplay = transaction.invoice_id === invoiceId
    if (transaction.journal_entry_id && !committedReplay) {
      return errorResponseFromCode('BANK_TRANSACTION_ALREADY_ALLOCATED', txLog, {
        requestId,
        details: { action: 'reverse_existing_voucher_first' },
      })
    }

    const { data: invoice, error: invoiceError } = await supabase
      .from('invoices')
      .select('*, customer:customers(*), items:invoice_items(*)')
      .eq('id', invoiceId)
      .eq('company_id', companyId)
      .single()
    if (invoiceError || !invoice) {
      return errorResponseFromCode('MATCH_INVOICE_NOT_FOUND', txLog, { requestId })
    }
    if ((invoice.document_type ?? 'invoice') !== 'invoice') {
      return errorResponseFromCode('MATCH_INVOICE_NOT_INVOICE_TYPE', txLog, {
        requestId,
        details: { documentType: invoice.document_type },
      })
    }

    const { data: settings } = await supabase
      .from('company_settings')
      .select('accounting_method')
      .eq('company_id', companyId)
      .maybeSingle()
    const unbookedCashInvoice = !invoice.journal_entry_id && settings?.accounting_method === 'cash'

    const transactionCurrency = (transaction.currency ?? 'SEK') as Currency
    const invoiceCurrency = (invoice.currency ?? 'SEK') as Currency
    const transactionAmount = Math.abs(Number(transaction.amount))
    const transactionSek = transactionCurrency === 'SEK'
      ? transactionAmount
      : Number(transaction.amount_sek ?? transactionAmount * Number(transaction.exchange_rate ?? 1))

    let paymentAmount = transactionAmount
    if (transactionCurrency !== invoiceCurrency) {
      if (invoiceCurrency === 'SEK') {
        paymentAmount = transactionSek
      } else {
        let paymentRate = manualExchangeRate ?? null
        if (paymentRate == null) {
          const rateInfo = await fetchExchangeRate(invoiceCurrency, new Date(transaction.date))
          paymentRate = rateInfo?.rate ?? null
        }
        if (paymentRate == null || paymentRate <= 0) {
          return errorResponseFromCode('MATCH_INVOICE_FX_RATE_UNAVAILABLE', txLog, {
            requestId,
            details: {
              transactionCurrency,
              invoiceCurrency,
              paymentDate: transaction.date,
            },
          })
        }
        paymentAmount = Math.round((transactionSek / paymentRate) * 10000) / 10000
      }
    }

    if (!committedReplay && transactionCurrency !== invoiceCurrency
        && paymentAmount > Number(invoice.remaining_amount) + 0.005) {
      return errorResponseFromCode('VALIDATION_ERROR', txLog, {
        requestId,
        details: {
          field: 'amount',
          message: 'Överbetalning i annan valuta kräver manuell granskning.',
        },
      })
    }
    if (!customLines && unbookedCashInvoice && invoiceCurrency !== 'SEK') {
      return errorResponseFromCode('VALIDATION_ERROR', txLog, {
        requestId,
        details: {
          field: 'lines',
          message: 'Betalning av utländsk kontantmetodsfaktura kräver balanserade SEK-rader med betalningsdagens kurs.',
        },
      })
    }

    if (!committedReplay) {
      try {
        const candidate = await detectDuplicatePaymentVoucher(supabase, {
          companyId,
          transactionId,
          transactionDate: transaction.date,
          transactionAmount: transaction.amount,
        })
        if (candidate) {
          return errorResponseFromCode('MATCH_INVOICE_POSSIBLE_DUPLICATE', txLog, {
            requestId,
            details: { candidate, forceIgnored: Boolean(force) },
          })
        }
      } catch (error) {
        txLog.error('duplicate-payment detection failed closed', error as Error)
        return errorResponseFromCode('INVOICE_PAID_BOOK_FAILED', txLog, { requestId })
      }
    }

    const bookedSek = invoiceCurrency === 'SEK'
      ? paymentAmount
      : Math.round(paymentAmount * Number(invoice.exchange_rate ?? 1) * 100) / 100
    const exchangeRateDifference = invoiceCurrency === 'SEK'
      ? 0
      : Math.round((transactionSek - bookedSek) * 100) / 100

    const result = await markInvoicePaid(supabase, companyId, user.id, {
      invoiceId,
      paymentDate: transaction.date,
      paymentAmount,
      exchangeRateDifference,
      customLines,
      transactionId,
      paymentReference: transaction.reference ?? null,
      idempotencyKey: `bank-match:customer:${transactionId}:${invoiceId}`,
      requestId,
    })
    if (!result.ok) {
      if (result.bookkeepingError) {
        return errorResponse(result.bookkeepingError, txLog, { requestId })
      }
      const mappedCode = result.code === 'INVOICE_PAID_NOT_FOUND'
        ? 'MATCH_INVOICE_NOT_FOUND'
        : result.code === 'INVOICE_PAID_NOT_PAYABLE'
          ? 'MATCH_INVOICE_NOT_OPEN'
          : result.code
      return errorResponseFromCode(mappedCode, txLog, {
        requestId,
        details: result.details,
      })
    }

    logMatchEvent(supabase, user.id, transactionId, 'matched', {
      invoiceId,
      matchConfidence: 1,
      matchMethod: 'manual_confirm_atomic',
      newState: {
        status: result.newStatus,
        paid_amount: result.newPaidAmount,
        remaining_amount: result.newRemaining,
        journal_entry_id: result.journalEntryId,
      },
    })
    try {
      eventBus.emit({
        type: 'invoice.match_confirmed',
        payload: {
          invoice: result.invoice as Invoice,
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
      invoice_status: result.newStatus,
      paid_at: result.invoice.paid_at ?? null,
      paid_amount: result.newPaidAmount,
      remaining_amount: result.newRemaining,
      applied_amount: result.appliedAmount,
      overpayment_amount: result.overpaymentAmount,
      customer_credit_id: result.customerCreditId,
      journal_entry_id: result.journalEntryId,
      category: transaction.category ?? null,
      request_id: requestId,
    })
  },
  { requireWrite: true },
)
