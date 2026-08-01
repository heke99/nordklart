/**
 * POST /api/v1/companies/{companyId}/transactions/{id}/match-invoice
 *
 * Bank matching is a thin adapter around the canonical atomic customer
 * settlement. A previously posted categorisation is never reversed here:
 * callers must reverse it explicitly before the bank row can be allocated.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { MatchInvoiceSchema } from '@/lib/api/schemas'
import { markInvoicePaid } from '@/lib/invoices/mark-paid-service'
import { detectDuplicatePaymentVoucher } from '@/lib/invoices/duplicate-payment-detection'
import { logMatchEvent } from '@/lib/invoices/match-log'
import { eventBus } from '@/lib/events/bus'
import type { Invoice, Transaction } from '@/types'

const MatchInvoiceResponse = z.object({
  success: z.boolean(),
  invoice_status: z.string(),
  paid_at: z.string().nullable(),
  paid_amount: z.number(),
  remaining_amount: z.number(),
  journal_entry_id: z.string().uuid().nullable(),
  category: z.string().nullable(),
  applied_amount: z.number().optional(),
  overpayment_amount: z.number().optional(),
  customer_credit_id: z.string().uuid().nullable().optional(),
})

registerEndpoint({
  operation: 'transactions.match-invoice',
  method: 'POST',
  path: '/api/v1/companies/:companyId/transactions/:id/match-invoice',
  summary: 'Match a positive bank transaction to a customer invoice.',
  description:
    'Atomically posts the payment voucher, payment allocation, invoice balance, bank link, audit and durable outbox event. A transaction with an existing voucher must be explicitly reversed first.',
  useWhen: 'You have a positive bank receipt and a known open customer invoice.',
  doNotUseFor:
    'Categorizing a transaction without an invoice, matching supplier payments, or replacing a posted categorisation without an explicit reversal.',
  pitfalls: [
    'Only customer invoices can be matched.',
    'Idempotency-Key is mandatory.',
    'A bank transaction already linked to a posted voucher is rejected; this endpoint never performs a multi-call compensation reversal.',
    'Foreign cash-basis invoices require explicit balanced lines because the payment-date SEK rate must be authoritative.',
  ],
  example: {
    request: { invoice_id: 'inv_…' },
    response: {
      data: {
        success: true,
        invoice_status: 'paid',
        paid_amount: 12500,
        remaining_amount: 0,
        journal_entry_id: 'je_…',
        category: null,
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'transactions:write',
  risk: 'high',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  request: { body: MatchInvoiceSchema },
  response: { success: MatchInvoiceResponse },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'transactions.match-invoice',
  async (request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Transaction id must be a UUID.' },
      })
    }
    const txId = idParse.data

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }
    const parsed = MatchInvoiceSchema.safeParse(rawBody)
    if (!parsed.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: parsed.error.issues.map((issue) => ({
            field: issue.path.join('.'),
            message: issue.message,
          })),
        },
      })
    }

    const { invoice_id, lines: customLines } = parsed.data
    const txLog = ctx.log.child({ transactionId: txId, invoiceId: invoice_id })
    const { data: transaction, error: txError } = await ctx.supabase
      .from('transactions')
      .select('*')
      .eq('id', txId)
      .eq('company_id', ctx.companyId!)
      .single()
    if (txError || !transaction) {
      return v1ErrorResponseFromCode('TX_CATEGORIZE_TX_NOT_FOUND', txLog, {
        requestId: ctx.requestId,
      })
    }
    if (transaction.amount <= 0) {
      return v1ErrorResponseFromCode('MATCH_INVOICE_NOT_INCOME', txLog, {
        requestId: ctx.requestId,
        details: { amount: transaction.amount },
      })
    }
    if (transaction.invoice_id && transaction.invoice_id !== invoice_id) {
      return v1ErrorResponseFromCode('MATCH_INVOICE_TX_ALREADY_LINKED', txLog, {
        requestId: ctx.requestId,
        details: { existingInvoiceId: transaction.invoice_id },
      })
    }
    const isCommittedReplay = transaction.invoice_id === invoice_id
    if (transaction.journal_entry_id && !isCommittedReplay) {
      return v1ErrorResponseFromCode('BANK_TRANSACTION_ALREADY_ALLOCATED', txLog, {
        requestId: ctx.requestId,
        details: { action: 'reverse_existing_voucher_first' },
      })
    }

    const { data: invoice, error: invoiceError } = await ctx.supabase
      .from('invoices')
      .select('id, company_id, currency, exchange_rate, remaining_amount, journal_entry_id, document_type')
      .eq('id', invoice_id)
      .eq('company_id', ctx.companyId!)
      .single()
    if (invoiceError || !invoice) {
      return v1ErrorResponseFromCode('MATCH_INVOICE_NOT_FOUND', txLog, {
        requestId: ctx.requestId,
      })
    }
    if ((invoice.document_type ?? 'invoice') !== 'invoice') {
      return v1ErrorResponseFromCode('MATCH_INVOICE_NOT_INVOICE_TYPE', txLog, {
        requestId: ctx.requestId,
        details: { documentType: invoice.document_type },
      })
    }

    const { data: settings } = await ctx.supabase
      .from('company_settings')
      .select('accounting_method')
      .eq('company_id', ctx.companyId!)
      .maybeSingle()
    const isUnbookedCashInvoice = !invoice.journal_entry_id && settings?.accounting_method === 'cash'

    const transactionCurrency = transaction.currency ?? 'SEK'
    const invoiceCurrency = invoice.currency ?? 'SEK'
    const paymentAmount = transactionCurrency === invoiceCurrency
      ? Number(transaction.amount)
      : Number(invoice.remaining_amount)

    if (!isCommittedReplay && paymentAmount > Number(invoice.remaining_amount) + 0.005
        && (transactionCurrency !== 'SEK' || invoiceCurrency !== 'SEK')) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', txLog, {
        requestId: ctx.requestId,
        details: {
          field: 'amount',
          message: 'Foreign-currency overpayments require manual review.',
        },
      })
    }
    if (!customLines && isUnbookedCashInvoice && invoiceCurrency !== 'SEK') {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', txLog, {
        requestId: ctx.requestId,
        details: {
          field: 'lines',
          message: 'Foreign cash-basis payments require balanced SEK lines at the payment-date rate.',
        },
      })
    }

    if (!isCommittedReplay) {
      try {
        const candidate = await detectDuplicatePaymentVoucher(ctx.supabase, {
          companyId: ctx.companyId!,
          transactionId: txId,
          transactionDate: transaction.date,
          transactionAmount: transaction.amount,
        })
        if (candidate) {
          return v1ErrorResponseFromCode('MATCH_INVOICE_POSSIBLE_DUPLICATE', txLog, {
            requestId: ctx.requestId,
            details: { candidate },
          })
        }
      } catch (error) {
        txLog.error('duplicate-payment detection failed closed', error as Error)
        return v1ErrorResponseFromCode('INVOICE_PAID_BOOK_FAILED', txLog, {
          requestId: ctx.requestId,
        })
      }
    }

    const bookedSek = invoiceCurrency === 'SEK'
      ? paymentAmount
      : Math.round(paymentAmount * Number(invoice.exchange_rate ?? 1) * 100) / 100
    const actualBankSek = transactionCurrency === 'SEK'
      ? Number(transaction.amount)
      : Number(transaction.amount_sek ?? bookedSek)
    const exchangeRateDifference = invoiceCurrency === 'SEK'
      ? 0
      : Math.round((actualBankSek - bookedSek) * 100) / 100

    const result = await markInvoicePaid(ctx.supabase, ctx.companyId!, ctx.userId, {
      invoiceId: invoice_id,
      paymentDate: transaction.date,
      paymentAmount,
      exchangeRateDifference,
      customLines,
      transactionId: txId,
      paymentReference: transaction.reference ?? null,
      idempotencyKey: `transactions.match-invoice:${ctx.idempotencyKey!}`,
      requestId: ctx.requestId,
    })
    if (!result.ok) {
      if (result.bookkeepingError) {
        return v1ErrorResponse(result.bookkeepingError, txLog, { requestId: ctx.requestId })
      }
      const mappedCode = result.code === 'INVOICE_PAID_NOT_FOUND'
        ? 'MATCH_INVOICE_NOT_FOUND'
        : result.code === 'INVOICE_PAID_NOT_PAYABLE'
          ? 'MATCH_INVOICE_NOT_OPEN'
          : result.code
      return v1ErrorResponseFromCode(mappedCode, txLog, {
        requestId: ctx.requestId,
        details: result.details,
      })
    }

    const existingTxCategory = (transaction as { category?: string | null }).category ?? null
    logMatchEvent(ctx.supabase, ctx.userId, txId, 'matched', {
      invoiceId: invoice_id,
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
          userId: ctx.userId,
          companyId: ctx.companyId!,
        },
      })
    } catch (error) {
      txLog.warn('match confirmation event dispatch failed; durable payment outbox retained', error as Error)
    }

    return ok({
      success: true,
      invoice_status: result.newStatus,
      paid_at: result.invoice.paid_at ?? null,
      paid_amount: result.newPaidAmount,
      remaining_amount: result.newRemaining,
      applied_amount: result.appliedAmount,
      overpayment_amount: result.overpaymentAmount,
      customer_credit_id: result.customerCreditId,
      journal_entry_id: result.journalEntryId,
      category: existingTxCategory,
    }, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
