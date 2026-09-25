/**
 * Link a bank transaction to an already-posted journal entry without creating
 * new bookkeeping. Optionally settle a customer invoice in the same call by
 * inserting an invoice_payments row pointing at the existing JE and flipping
 * the invoice status with an optimistic-lock pattern.
 *
 * Shared between two callers:
 *   - REST: app/api/transactions/[id]/link-journal-entry/route.ts
 *     (duplicate-payment UI: user confirms the suggested existing voucher)
 *   - MCP commit handler: lib/pending-operations/commit.ts
 *     (nordklart_link_transaction_to_journal_entry — agent-staged operation)
 *
 * NEVER creates a new journal entry. The match log records
 * 'linked_to_existing_voucher' for audit on success.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events/bus'
import { logMatchEvent } from '@/lib/invoices/match-log'
import type { Invoice, Transaction } from '@/types'


// Codes returned by linkTransactionToJournalEntry. All map to entries in
// lib/errors/structured-errors.ts so both callers (REST route, MCP commit
// handler) can surface the right HTTP status and the localized message.
// The TX-not-found case reuses the shared TX_CATEGORIZE_TX_NOT_FOUND code
// rather than a link-specific one — it predates this route and is the
// canonical "bank tx not found in this company" envelope.
export type LinkTransactionJournalEntryErrorCode =
  | 'TX_CATEGORIZE_TX_NOT_FOUND'
  | 'LINK_TX_TX_ALREADY_LINKED'
  | 'LINK_TX_JE_NOT_FOUND'
  | 'LINK_TX_JE_NOT_POSTED'
  | 'LINK_TX_INVOICE_NOT_FOUND'
  | 'LINK_TX_INVOICE_NOT_OPEN'
  | 'LINK_TX_INVOICE_CURRENCY_MISMATCH'
  | 'LINK_TX_INVOICE_RACE'
  | 'MATCH_INVOICE_RECORD_PAYMENT_FAILED'
  | 'LINK_TX_DB_ERROR'

export interface LinkTransactionJournalEntryParams {
  transactionId: string
  journalEntryId: string
  invoiceId?: string
}

export interface LinkTransactionJournalEntryResult {
  transactionId: string
  journalEntryId: string
  voucherLabel: string
  invoiceId: string | null
  invoiceStatus: 'paid' | 'partially_paid' | null
  paidAmount: number | null
  remainingAmount: number | null
}

export type LinkTransactionJournalEntryOutcome =
  | { ok: true; result: LinkTransactionJournalEntryResult }
  | { ok: false; code: LinkTransactionJournalEntryErrorCode; details?: Record<string, unknown> }

/**
 * Canonical verifikat-label format: `${series}-${number}` (e.g. "A-12").
 * Centralised so the MCP staging preview and the committed result can't
 * diverge — divergence is a BFL 5 kap 7§ traceability hazard because the
 * verifikationsserie label that ends up in the audit trail must match the
 * label the user saw at approval time.
 *
 * Fallbacks ('A' series, empty number) are defensive only; in practice a
 * posted verifikat always has both. Callers should never construct this
 * string inline — import this helper instead.
 */
export function formatVoucherLabel(
  voucherSeries: string | null | undefined,
  voucherNumber: number | string | null | undefined,
): string {
  const series = voucherSeries ?? 'A'
  const num = voucherNumber ?? ''
  return num === '' ? series : `${series}-${num}`
}

export async function linkTransactionToJournalEntry(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: LinkTransactionJournalEntryParams
): Promise<LinkTransactionJournalEntryOutcome> {
  const { transactionId, journalEntryId, invoiceId } = params

  // Data minimization (GDPR Art.5(1)(c)): pull only the columns needed for
  // validation, optimistic-lock invoice update, invoice_payments insert, and
  // the compensating-rollback path. No select('*').
  const { data: transaction, error: fetchTxError } = await supabase
    .from('transactions')
    .select(
      'id, date, amount, currency, exchange_rate, journal_entry_id, invoice_id, is_business, potential_invoice_id, potential_supplier_invoice_id'
    )
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .single()

  if (fetchTxError || !transaction) {
    return { ok: false, code: 'TX_CATEGORIZE_TX_NOT_FOUND' }
  }

  if (transaction.journal_entry_id) {
    return {
      ok: false,
      code: 'LINK_TX_TX_ALREADY_LINKED',
      details: { existingJournalEntryId: transaction.journal_entry_id as string },
    }
  }

  const { data: journalEntry, error: fetchJeError } = await supabase
    .from('journal_entries')
    .select('id, status, voucher_series, voucher_number, entry_date')
    .eq('id', journalEntryId)
    .eq('company_id', companyId)
    .single()

  if (fetchJeError || !journalEntry) {
    return { ok: false, code: 'LINK_TX_JE_NOT_FOUND' }
  }

  if (journalEntry.status !== 'posted') {
    return {
      ok: false,
      code: 'LINK_TX_JE_NOT_POSTED',
      details: { currentStatus: journalEntry.status as string },
    }
  }

  type FetchedInvoice = Pick<
    Invoice,
    | 'id'
    | 'status'
    | 'total'
    | 'paid_amount'
    | 'remaining_amount'
    | 'currency'
    | 'exchange_rate'
    | 'paid_at'
    | 'invoice_number'
  > & { customer?: { name?: string } | null }
  let invoice: FetchedInvoice | null = null
  let newPaidAmount = 0
  let newRemaining = 0
  let isFullyPaid = false
  let newStatus: 'paid' | 'partially_paid' = 'paid'

  if (invoiceId) {
    // Data minimization (GDPR Art.5(1)(c) / SOC 2 CC6.1): explicit column
    // list rather than select('*, customer:customers(name)'). Adding new
    // PII columns to invoices won't silently widen this fetch.
    const { data: invoiceRow, error: fetchInvError } = await supabase
      .from('invoices')
      .select(
        'id, status, total, paid_amount, remaining_amount, currency, exchange_rate, paid_at, invoice_number, customer:customers(name)'
      )
      .eq('id', invoiceId)
      .eq('company_id', companyId)
      .single()

    if (fetchInvError || !invoiceRow) {
      return { ok: false, code: 'LINK_TX_INVOICE_NOT_FOUND' }
    }

    if (
      invoiceRow.status !== 'sent' &&
      invoiceRow.status !== 'overdue' &&
      invoiceRow.status !== 'partially_paid'
    ) {
      return {
        ok: false,
        code: 'LINK_TX_INVOICE_NOT_OPEN',
        details: { currentStatus: invoiceRow.status as string },
      }
    }

    invoice = invoiceRow as unknown as FetchedInvoice

    // BFL 5 kap 2§ + currency-integrity guard: invoices.paid_amount and
    // remaining_amount are stored in the INVOICE'S currency. Mixing a
    // foreign-currency tx.amount into those columns silently corrupts the
    // ledger (a 230 SEK payment would record "230 USD paid" on a USD
    // invoice). This link path is for the same-currency case only;
    // cross-currency payments must go through /api/transactions/[id]/match-
    // invoice which routes through buildInvoicePaymentClearingLines and
    // posts the FX diff on 3960/7960. Reject here to keep the contract clear.
    if (transaction.currency !== invoice.currency) {
      return {
        ok: false,
        code: 'LINK_TX_INVOICE_CURRENCY_MISMATCH',
        details: {
          transactionCurrency: transaction.currency as string,
          invoiceCurrency: invoice.currency,
        },
      }
    }

    const paidAmount = transaction.amount as number
    newPaidAmount = Math.round(((invoice.paid_amount || 0) + paidAmount) * 100) / 100
    const currentRemaining =
      invoice.remaining_amount ?? invoice.total - (invoice.paid_amount || 0)
    newRemaining = Math.max(0, Math.round((currentRemaining - paidAmount) * 100) / 100)
    isFullyPaid = newRemaining <= 0
    newStatus = isFullyPaid ? 'paid' : 'partially_paid'
  }

  // The transaction link, the invoice's paid/remaining amounts and the
  // invoice_payments row are written in ONE transaction, under row locks on
  // the transaction and the invoice (link_transaction_to_existing_voucher).
  // The function re-checks every precondition above under those locks and
  // computes the amounts itself; nothing needs rolling back by hand.
  const { data: linkResult, error: linkError } = await supabase.rpc('link_transaction_to_existing_voucher', {
    p_company_id: companyId,
    p_user_id: userId,
    p_transaction_id: transactionId,
    p_journal_entry_id: journalEntryId,
    p_invoice_id: invoiceId ?? null,
  })

  if (linkError) {
    if (linkError.code === '23505') {
      return { ok: false, code: 'MATCH_INVOICE_RECORD_PAYMENT_FAILED', details: { reason: 'payment_already_recorded' } }
    }
    return { ok: false, code: 'LINK_TX_DB_ERROR', details: { reason: linkError.message } }
  }
  const outcome = linkResult as {
    ok: boolean
    code?: LinkTransactionJournalEntryErrorCode
    details?: Record<string, unknown>
    invoiceStatus?: 'paid' | 'partially_paid' | null
    paidAmount?: number | null
    remainingAmount?: number | null
  } | null
  if (!outcome?.ok) {
    return { ok: false, code: outcome?.code ?? 'LINK_TX_DB_ERROR', ...(outcome?.details ? { details: outcome.details } : {}) }
  }
  if (invoice) {
    newStatus = outcome.invoiceStatus ?? newStatus
    newPaidAmount = Number(outcome.paidAmount ?? newPaidAmount)
    newRemaining = Number(outcome.remainingAmount ?? newRemaining)
  }

  logMatchEvent(supabase, userId, transactionId, 'linked_to_existing_voucher', {
    invoiceId,
    newState: {
      journal_entry_id: journalEntryId,
      invoice_id: invoiceId ?? null,
      invoice_status: invoice ? newStatus : null,
    },
  })

  if (invoice && invoiceId) {
    try {
      eventBus.emit({
        type: 'invoice.match_confirmed',
        payload: {
          invoice: invoice as Invoice,
          transaction: transaction as Transaction,
          userId,
          companyId,
        },
      })
    } catch {
      /* non-critical */
    }
  }

  const voucherLabel = formatVoucherLabel(
    journalEntry.voucher_series as string | null,
    journalEntry.voucher_number as number | null,
  )

  return {
    ok: true,
    result: {
      transactionId,
      journalEntryId,
      voucherLabel,
      invoiceId: invoiceId ?? null,
      invoiceStatus: invoice ? newStatus : null,
      paidAmount: invoice ? newPaidAmount : null,
      remainingAmount: invoice ? newRemaining : null,
    },
  }
}
