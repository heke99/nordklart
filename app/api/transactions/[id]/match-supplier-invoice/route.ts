import { withRouteContext } from '@/lib/api/with-route-context'
import { roundOre } from '@/lib/money'
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
          // How far over, so the caller can route the excess through the
          // split-payment flow without recomputing it.
          excess: roundOre(paymentAmount - Number(invoice.remaining_amount)),
        },
      })
    }

    // Rate on the invoice row, if any. `?? 1` would silently treat a missing
    // rate as parity and book a 25 USD payable as 25 SEK, so the absence is
    // kept explicit and handled below.
    const invoiceRate = invoice.exchange_rate != null ? Number(invoice.exchange_rate) : null
    const bankSek = transactionCurrency === 'SEK'
      ? transactionAmount
      : (transaction.amount_sek != null ? Math.abs(Number(transaction.amount_sek)) : null)
    const bookedSek = invoiceCurrency === 'SEK'
      ? paymentAmount
      : invoiceRate != null
        ? roundOre(paymentAmount * invoiceRate)
        // No rate on file: the AP-booked SEK cannot be derived, so settle at
        // what actually left the bank rather than inventing a parity rate.
        : (bankSek ?? paymentAmount)
    const actualBankSek = bankSek ?? bookedSek
    // The residual is the difference between what the payable was booked at and
    // what actually left the bank, in SEK. Keying it off the INVOICE currency
    // dropped a real realised difference in the reverse case: a SEK invoice
    // settled from a foreign-currency account, where amount_sek differs from the
    // booked amount. Paying a 1 000 SEK payable with a card movement worth
    // 1 063 SEK is a 63 SEK realised loss that must reach 7960/3960 rather than
    // vanish. When both sides are SEK the two figures are equal and this is 0,
    // and the entry builder only emits an FX line for a non-zero difference.
    // With no rate on file the booked amount IS the bank amount, so there is no
    // difference to attribute; every other case compares the two directly.
    const exchangeRateDifference = roundOre(bookedSek - actualBankSek)

    const { data: settings } = await supabase
      .from('company_settings')
      .select('accounting_method')
      .eq('company_id', companyId)
      .maybeSingle()
    const unbookedCashInvoice = !invoice.registration_journal_entry_id
      && settings?.accounting_method === 'cash'
    // Kontantmetoden books the whole invoice as one verifikat at the
    // payment-date rate (BFL 5 kap; ÅRL 4 kap 6 §). createSupplierInvoiceCashEntry
    // derives that rate from the SEK that actually settled the invoice
    // (settledBankSek / invoice.total), which only holds when the payment
    // settles the invoice in FULL — a partial bank amount cannot pin a
    // whole-invoice entry. So a full foreign settlement is allowed and pinned
    // to the bank movement; a partial one is refused with its own code rather
    // than blocking every foreign cash payment.
    const isFullSettlement =
      paymentAmount >= Number(invoice.remaining_amount) - 0.005
    const settledBankSek = !customLines && unbookedCashInvoice && invoiceCurrency !== 'SEK'
      // No independent bank figure (foreign transaction without amount_sek):
      // leave it unset so the builder falls back to the invoice's stored rate
      // instead of pinning to a bogus number.
      ? (bankSek ?? undefined)
      : undefined
    if (!customLines && unbookedCashInvoice && invoiceCurrency !== 'SEK' && !isFullSettlement) {
      return errorResponseFromCode('MATCH_SI_CASH_FX_UNSUPPORTED', txLog, {
        requestId,
        details: {
          field: 'amount',
          payment_amount: paymentAmount,
          remaining_amount: Number(invoice.remaining_amount),
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
        settledBankSek,
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
