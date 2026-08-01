/**
 * POST /api/v1/companies/{companyId}/transactions/{id}/match-supplier-invoice
 *
 * Thin bank adapter around settleSupplierInvoiceAtomic. No compensation
 * reversal or independent invoice/payment writes are permitted here.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { MatchSupplierInvoiceSchema } from '@/lib/api/schemas'
import { settleSupplierInvoiceAtomic } from '@/lib/supplier-invoices/mark-paid-service'
import { logMatchEvent } from '@/lib/invoices/match-log'
import { eventBus } from '@/lib/events/bus'
import type { SupplierInvoice, SupplierInvoiceItem, Transaction } from '@/types'

const MatchSIResponse = z.object({
  success: z.boolean(),
  invoice_status: z.string(),
  paid_amount: z.number(),
  remaining_amount: z.number(),
  journal_entry_id: z.string().uuid().nullable(),
})

registerEndpoint({
  operation: 'transactions.match-supplier-invoice',
  method: 'POST',
  path: '/api/v1/companies/:companyId/transactions/:id/match-supplier-invoice',
  summary: 'Match a negative bank transaction to a supplier invoice.',
  description:
    'Atomically posts the payment voucher, supplier allocation, invoice balance, bank link, audit and durable outbox event. Existing posted categorisations must be explicitly reversed first.',
  useWhen: 'You have a negative bank payment and a known open supplier invoice.',
  doNotUseFor:
    'Direct expense categorisation, customer receipts, or implicit reversal of an existing posted voucher.',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'Supplier overpayments are rejected.',
    'Foreign cash-basis payments require explicit balanced lines at the payment-date SEK rate.',
    'A bank transaction with an existing voucher is rejected rather than compensated through several independent writes.',
  ],
  example: {
    request: { supplier_invoice_id: 'si_…' },
    response: {
      data: {
        success: true,
        invoice_status: 'paid',
        paid_amount: 5000,
        remaining_amount: 0,
        journal_entry_id: 'je_…',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'transactions:write',
  risk: 'high',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  request: { body: MatchSupplierInvoiceSchema },
  response: { success: MatchSIResponse },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'transactions.match-supplier-invoice',
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
    const parsed = MatchSupplierInvoiceSchema.safeParse(rawBody)
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

    const { supplier_invoice_id, lines: customLines } = parsed.data
    const txLog = ctx.log.child({ transactionId: txId, supplierInvoiceId: supplier_invoice_id })
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
    if (transaction.amount >= 0) {
      return v1ErrorResponseFromCode('MATCH_SI_NOT_EXPENSE', txLog, {
        requestId: ctx.requestId,
        details: { amount: transaction.amount },
      })
    }
    if (transaction.supplier_invoice_id && transaction.supplier_invoice_id !== supplier_invoice_id) {
      return v1ErrorResponseFromCode('MATCH_SI_TX_ALREADY_LINKED', txLog, {
        requestId: ctx.requestId,
        details: { existingSupplierInvoiceId: transaction.supplier_invoice_id },
      })
    }
    const isCommittedReplay = transaction.supplier_invoice_id === supplier_invoice_id
    if (transaction.journal_entry_id && !isCommittedReplay) {
      return v1ErrorResponseFromCode('BANK_TRANSACTION_ALREADY_ALLOCATED', txLog, {
        requestId: ctx.requestId,
        details: { action: 'reverse_existing_voucher_first' },
      })
    }

    const { data: invoice, error: invoiceError } = await ctx.supabase
      .from('supplier_invoices')
      .select('*, supplier:suppliers(*), items:supplier_invoice_items(*)')
      .eq('id', supplier_invoice_id)
      .eq('company_id', ctx.companyId!)
      .single()
    if (invoiceError || !invoice) {
      return v1ErrorResponseFromCode('MATCH_SI_NOT_FOUND', txLog, {
        requestId: ctx.requestId,
      })
    }

    const txAmount = Math.abs(Number(transaction.amount))
    const transactionCurrency = transaction.currency ?? 'SEK'
    const invoiceCurrency = invoice.currency ?? 'SEK'
    const paymentAmountInvoiceCurrency = transactionCurrency === invoiceCurrency
      ? txAmount
      : Number(invoice.remaining_amount)
    const bookedSek = invoiceCurrency === 'SEK'
      ? paymentAmountInvoiceCurrency
      : Math.round(paymentAmountInvoiceCurrency * Number(invoice.exchange_rate ?? 1) * 100) / 100
    const actualBankSek = transactionCurrency === 'SEK'
      ? txAmount
      : Number(transaction.amount_sek != null ? Math.abs(transaction.amount_sek) : bookedSek)
    const exchangeRateDifference = invoiceCurrency === 'SEK'
      ? 0
      : Math.round((bookedSek - actualBankSek) * 100) / 100

    const { data: settings } = await ctx.supabase
      .from('company_settings')
      .select('accounting_method')
      .eq('company_id', ctx.companyId!)
      .maybeSingle()
    const isUnbookedCashInvoice = !invoice.registration_journal_entry_id
      && settings?.accounting_method === 'cash'
    if (!customLines && isUnbookedCashInvoice && invoiceCurrency !== 'SEK') {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', txLog, {
        requestId: ctx.requestId,
        details: {
          field: 'lines',
          message: 'Foreign cash-basis payments require balanced SEK lines at the payment-date rate.',
        },
      })
    }

    const supplierRow = Array.isArray(invoice.supplier)
      ? (invoice.supplier[0] ?? null)
      : invoice.supplier
    const result = await settleSupplierInvoiceAtomic(
      ctx.supabase,
      ctx.companyId!,
      ctx.userId,
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
        paymentAmount: paymentAmountInvoiceCurrency,
        ledgerPaymentAmount: bookedSek,
        exchangeRateDifference,
        customLines,
        transactionId: txId,
        paymentReference: transaction.reference ?? null,
        idempotencyKey: `transactions.match-supplier-invoice:${ctx.idempotencyKey!}`,
        requestId: ctx.requestId,
      },
    )
    if (!result.ok) {
      if (result.bookkeepingError) {
        return v1ErrorResponse(result.bookkeepingError, txLog, { requestId: ctx.requestId })
      }
      const mappedCode = result.code === 'SI_NOT_FOUND'
        ? 'MATCH_SI_NOT_FOUND'
        : result.code === 'SI_PAID_NOT_PAYABLE'
          ? 'MATCH_SI_NOT_OPEN'
          : result.code
      return v1ErrorResponseFromCode(mappedCode, txLog, {
        requestId: ctx.requestId,
        details: result.details,
      })
    }

    logMatchEvent(ctx.supabase, ctx.userId, txId, 'matched', {
      supplierInvoiceId: supplier_invoice_id,
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
          userId: ctx.userId,
          companyId: ctx.companyId!,
        },
      })
    } catch (error) {
      txLog.warn('match confirmation event dispatch failed; durable payment outbox retained', error as Error)
    }

    return ok({
      success: true,
      invoice_status: result.status,
      paid_amount: result.paidAmount,
      remaining_amount: result.remainingAmount,
      journal_entry_id: result.journalEntryId,
    }, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
