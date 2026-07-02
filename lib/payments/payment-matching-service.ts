/**
 * Unified payment-matching service.
 *
 * ONE scored API for "which customer/supplier invoice does this bank
 * transaction settle?" — used by the ingest pipeline, the automation engine,
 * the dashboard preview endpoints and the v1 API so the verification rules
 * cannot drift between entry points.
 *
 * The service only MATCHES and VERIFIES — it never writes. What happens with
 * a match (suggest / pending operation / auto-settle) is decided by the
 * automation engine (lib/automation/bank-transaction-automation.ts) or by an
 * explicit user action, and the actual settlement runs through the payment
 * orchestration services.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { findMatchingInvoices, type InvoiceMatch } from '@/lib/invoices/invoice-matching'
import {
  findSupplierInvoiceMatches,
  type SupplierInvoiceMatch,
} from '@/lib/invoices/supplier-invoice-matching'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { createLogger } from '@/lib/logger'
import type { Transaction, Invoice, Customer, SupplierInvoice } from '@/types'

const log = createLogger('payments/matching')

export type PaymentCandidateType = 'customer_invoice' | 'supplier_invoice'

export type PaymentClassification =
  | 'exact'
  | 'partial'
  | 'overpayment'
  | 'underpayment'
  | 'unknown'

export type RecommendedAction = 'auto_settle' | 'suggest' | 'review' | 'block'

export interface PaymentMatchCandidate {
  candidateType: PaymentCandidateType
  candidateId: string
  /** 0–100 */
  score: number
  reasonCodes: string[]
  blockingReasons: string[]
  ambiguous: boolean
  recommendedAction: RecommendedAction
  classification: PaymentClassification
  /** Signed difference tx − remaining, in the invoice's currency (when computable). */
  amountDifference: number | null
  invoice?: Invoice & { customer?: Customer }
  supplierInvoice?: SupplierInvoice
}

export interface PaymentMatchResult {
  candidates: PaymentMatchCandidate[]
  best: PaymentMatchCandidate | null
  /** True when the top two candidates are too close to trust automatically. */
  ambiguous: boolean
}

/** Two candidates within this score gap = ambiguous. */
const AMBIGUITY_SCORE_GAP = 10
/** Underpayment band: within 1% or 5 SEK below remaining = "underpayment", else partial. */
const UNDERPAYMENT_ABS_TOLERANCE = 5
const UNDERPAYMENT_REL_TOLERANCE = 0.01

function classifyPayment(paid: number, remaining: number): PaymentClassification {
  if (!Number.isFinite(paid) || !Number.isFinite(remaining) || remaining <= 0) return 'unknown'
  const diff = paid - remaining
  if (Math.abs(diff) < 0.005) return 'exact'
  if (diff > 0) return 'overpayment'
  const shortfall = -diff
  if (shortfall <= Math.max(UNDERPAYMENT_ABS_TOLERANCE, remaining * UNDERPAYMENT_REL_TOLERANCE)) {
    return 'underpayment'
  }
  return 'partial'
}

function buildCustomerCandidate(
  transaction: Transaction,
  match: InvoiceMatch,
): PaymentMatchCandidate {
  const invoice = match.invoice
  const remaining = invoice.remaining_amount ?? invoice.total
  const sameCurrency = invoice.currency === transaction.currency
  const classification = sameCurrency
    ? classifyPayment(transaction.amount, remaining)
    : 'unknown'

  const reasonCodes: string[] = [match.matchReason]
  const blockingReasons: string[] = []

  if (!sameCurrency) blockingReasons.push('cross_currency')
  if (invoice.status === 'disputed') blockingReasons.push('invoice_disputed')
  if (classification === 'overpayment') blockingReasons.push('overpayment_requires_credit')
  if (classification === 'partial' || classification === 'underpayment') {
    blockingReasons.push('not_exact_payment')
  }

  return {
    candidateType: 'customer_invoice',
    candidateId: invoice.id,
    score: Math.round(Math.max(0, Math.min(1, match.confidence)) * 100),
    reasonCodes,
    blockingReasons,
    ambiguous: false,
    recommendedAction: 'suggest',
    classification,
    amountDifference: sameCurrency ? Math.round((transaction.amount - remaining) * 100) / 100 : null,
    invoice,
  }
}

function buildSupplierCandidate(
  transaction: Transaction,
  match: SupplierInvoiceMatch,
): PaymentMatchCandidate {
  const supplierInvoice = match.supplierInvoice
  const remaining = supplierInvoice.remaining_amount ?? supplierInvoice.total
  const sameCurrency = supplierInvoice.currency === transaction.currency
  const paidAbs = Math.abs(transaction.amount)
  const classification = sameCurrency ? classifyPayment(paidAbs, remaining) : 'unknown'

  const reasonCodes: string[] = [match.matchMethod]
  const blockingReasons: string[] = []

  if (transaction.amount >= 0) blockingReasons.push('wrong_amount_direction')
  if (!sameCurrency) blockingReasons.push('cross_currency')
  if (supplierInvoice.status === 'disputed') blockingReasons.push('supplier_invoice_disputed')
  if (supplierInvoice.paid_at || (supplierInvoice.remaining_amount ?? supplierInvoice.total) <= 0) {
    blockingReasons.push('supplier_invoice_already_paid')
  }
  if (classification === 'overpayment') blockingReasons.push('overpayment_requires_review')
  if (classification === 'partial' || classification === 'underpayment') {
    blockingReasons.push('not_exact_payment')
  }

  return {
    candidateType: 'supplier_invoice',
    candidateId: supplierInvoice.id,
    score: Math.round(Math.max(0, Math.min(1, match.confidence)) * 100),
    reasonCodes,
    blockingReasons,
    ambiguous: false,
    recommendedAction: 'suggest',
    classification,
    amountDifference: sameCurrency ? Math.round((paidAbs - remaining) * 100) / 100 : null,
    supplierInvoice,
  }
}

function finalizeRecommendations(candidates: PaymentMatchCandidate[]): PaymentMatchResult {
  const sorted = [...candidates].sort((a, b) => b.score - a.score)
  const best = sorted[0] ?? null
  const runnerUp = sorted[1] ?? null

  const ambiguous =
    !!best &&
    !!runnerUp &&
    best.score - runnerUp.score < AMBIGUITY_SCORE_GAP &&
    (best.candidateId !== runnerUp.candidateId || best.candidateType !== runnerUp.candidateType)

  for (const candidate of sorted) {
    candidate.ambiguous = ambiguous && candidate === best
    if (candidate.blockingReasons.some((r) => r.endsWith('_disputed') || r === 'wrong_amount_direction' || r === 'supplier_invoice_already_paid')) {
      candidate.recommendedAction = 'block'
    } else if (
      candidate.blockingReasons.length > 0 ||
      (ambiguous && candidate === best)
    ) {
      candidate.recommendedAction = 'review'
    } else if (candidate.score >= 95 && candidate.classification === 'exact') {
      candidate.recommendedAction = 'auto_settle'
    } else {
      candidate.recommendedAction = 'suggest'
    }
  }

  return { candidates: sorted, best, ambiguous }
}

export interface MatchTransactionOptions {
  /**
   * Pre-fetched supplier-invoice pool (with supplier relation). Callers in a
   * batch loop (ingest) pass this to avoid N+1 queries; when omitted the
   * service fetches open supplier invoices itself.
   */
  unpaidSupplierInvoices?: SupplierInvoice[]
  /** Minimum confidence (0–1) for customer-invoice candidates. Default 0.5. */
  minConfidence?: number
}

/**
 * Score all customer-invoice and supplier-invoice candidates for one bank
 * transaction. Income transactions match customer invoices; expense
 * transactions match supplier invoices.
 */
export async function matchTransactionToPayments(
  supabase: SupabaseClient,
  companyId: string,
  transaction: Transaction,
  options: MatchTransactionOptions = {},
): Promise<PaymentMatchResult> {
  const candidates: PaymentMatchCandidate[] = []
  const minConfidence = options.minConfidence ?? 0.5

  // Already settled/linked transactions have no candidates.
  if (transaction.invoice_id || transaction.supplier_invoice_id) {
    return { candidates: [], best: null, ambiguous: false }
  }

  if (transaction.amount > 0) {
    try {
      const matches = await findMatchingInvoices(supabase, companyId, transaction)
      for (const match of matches) {
        if (match.confidence < minConfidence) continue
        candidates.push(buildCustomerCandidate(transaction, match))
      }
    } catch (err) {
      log.warn('customer invoice matching failed', {
        companyId,
        transactionId: transaction.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  } else if (transaction.amount < 0) {
    try {
      let pool = options.unpaidSupplierInvoices
      if (!pool) {
        pool = await fetchAllRows<SupplierInvoice>(({ from, to }) =>
          supabase
            .from('supplier_invoices')
            .select('*, supplier:suppliers(*)')
            .eq('company_id', companyId)
            .in('status', ['registered', 'approved'])
            .gt('remaining_amount', 0)
            .range(from, to),
        )
      }
      const matches = findSupplierInvoiceMatches(transaction, pool)
      for (const match of matches) {
        if (match.confidence < minConfidence) continue
        candidates.push(buildSupplierCandidate(transaction, match))
      }
    } catch (err) {
      log.warn('supplier invoice matching failed', {
        companyId,
        transactionId: transaction.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return finalizeRecommendations(candidates)
}
