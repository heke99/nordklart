import type { SupabaseClient } from '@supabase/supabase-js'
import { evaluateMappingRules } from '@/lib/bookkeeping/mapping-engine'
import { createTransactionJournalEntry } from '@/lib/bookkeeping/transaction-entries'
import { upsertCounterpartyTemplate } from '@/lib/bookkeeping/counterparty-templates'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { resolvePeriodStatusForDate } from '@/lib/core/bookkeeping/period-service'
import { commitPendingOperation } from '@/lib/pending-operations/commit'
import { logMatchEvent } from '@/lib/invoices/match-log'
import { createLogger } from '@/lib/logger'
import type {
  Transaction,
  Invoice,
  Customer,
  SupplierInvoice,
  MappingResult,
  PendingOperation,
} from '@/types'

const log = createLogger('automation/bank-transaction')

// ── Settings ─────────────────────────────────────────────────────────────────

export type AutomationMode = 'off' | 'suggest' | 'auto_safe' | 'auto_full'
export type AfterSyncMode = 'off' | 'suggest_only' | 'process_pending' | 'auto_safe'

export interface CompanyAutomationSettings {
  bankTransactionMode: AutomationMode
  invoicePaymentMatchingMode: AutomationMode
  supplierInvoiceMatchingMode: AutomationMode
  bankImportAfterSyncMode: AfterSyncMode
  /** 0–1. Below this, nothing is auto-committed. */
  minAutoConfidence: number
  /** 0–1. Below this, not even a suggestion is recorded. */
  minSuggestionConfidence: number
  /** SEK cap for any single auto-booked transaction. null = no cap. */
  maxAutoBookAmount: number | null
  allowAutoCustomerInvoiceSettlement: boolean
  allowAutoSupplierInvoiceSettlement: boolean
  allowAutoBankFeeBooking: boolean
  allowAutoCategoryBooking: boolean
  allowAutoTaxPaymentBooking: boolean
  allowAutoSalaryPaymentBooking: boolean
}

/**
 * Conservative defaults for companies without a company_automation_settings
 * row: suggestions + pending operations, never silent booking.
 */
export const DEFAULT_AUTOMATION_SETTINGS: CompanyAutomationSettings = {
  bankTransactionMode: 'suggest',
  invoicePaymentMatchingMode: 'auto_safe',
  supplierInvoiceMatchingMode: 'suggest',
  bankImportAfterSyncMode: 'process_pending',
  minAutoConfidence: 0.95,
  minSuggestionConfidence: 0.7,
  maxAutoBookAmount: null,
  allowAutoCustomerInvoiceSettlement: true,
  allowAutoSupplierInvoiceSettlement: false,
  allowAutoBankFeeBooking: true,
  allowAutoCategoryBooking: false,
  allowAutoTaxPaymentBooking: false,
  allowAutoSalaryPaymentBooking: false,
}

interface AutomationSettingsRow {
  bank_transaction_mode: AutomationMode
  invoice_payment_matching_mode: AutomationMode
  supplier_invoice_matching_mode: AutomationMode
  bank_import_after_sync_mode: AfterSyncMode
  min_auto_confidence: number | string
  min_suggestion_confidence: number | string
  max_auto_book_amount: number | string | null
  allow_auto_customer_invoice_settlement: boolean
  allow_auto_supplier_invoice_settlement: boolean
  allow_auto_bank_fee_booking: boolean
  allow_auto_category_booking: boolean
  allow_auto_tax_payment_booking: boolean
  allow_auto_salary_payment_booking: boolean
}

function toNumber(value: number | string | null | undefined, fallback: number): number {
  if (value === null || value === undefined) return fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export async function loadAutomationSettings(
  supabase: SupabaseClient,
  companyId: string,
): Promise<CompanyAutomationSettings> {
  try {
    const { data } = await supabase
      .from('company_automation_settings')
      .select('*')
      .eq('company_id', companyId)
      .maybeSingle()

    if (!data) return DEFAULT_AUTOMATION_SETTINGS
    const row = data as AutomationSettingsRow
    return {
      bankTransactionMode: row.bank_transaction_mode ?? DEFAULT_AUTOMATION_SETTINGS.bankTransactionMode,
      invoicePaymentMatchingMode:
        row.invoice_payment_matching_mode ?? DEFAULT_AUTOMATION_SETTINGS.invoicePaymentMatchingMode,
      supplierInvoiceMatchingMode:
        row.supplier_invoice_matching_mode ?? DEFAULT_AUTOMATION_SETTINGS.supplierInvoiceMatchingMode,
      bankImportAfterSyncMode:
        row.bank_import_after_sync_mode ?? DEFAULT_AUTOMATION_SETTINGS.bankImportAfterSyncMode,
      minAutoConfidence: toNumber(row.min_auto_confidence, DEFAULT_AUTOMATION_SETTINGS.minAutoConfidence),
      minSuggestionConfidence: toNumber(
        row.min_suggestion_confidence,
        DEFAULT_AUTOMATION_SETTINGS.minSuggestionConfidence,
      ),
      maxAutoBookAmount:
        row.max_auto_book_amount === null || row.max_auto_book_amount === undefined
          ? null
          : toNumber(row.max_auto_book_amount, Number.POSITIVE_INFINITY),
      allowAutoCustomerInvoiceSettlement: row.allow_auto_customer_invoice_settlement ?? true,
      allowAutoSupplierInvoiceSettlement: row.allow_auto_supplier_invoice_settlement ?? false,
      allowAutoBankFeeBooking: row.allow_auto_bank_fee_booking ?? true,
      allowAutoCategoryBooking: row.allow_auto_category_booking ?? false,
      allowAutoTaxPaymentBooking: row.allow_auto_tax_payment_booking ?? false,
      allowAutoSalaryPaymentBooking: row.allow_auto_salary_payment_booking ?? false,
    }
  } catch {
    // Fail SAFE — unknown settings must never enable automation.
    return { ...DEFAULT_AUTOMATION_SETTINGS, bankTransactionMode: 'suggest' }
  }
}

// ── Candidates & decisions ───────────────────────────────────────────────────

export type AutomationCandidateType =
  | 'customer_invoice'
  | 'supplier_invoice'
  | 'bank_fee'
  | 'tax_payment'
  | 'salary'
  | 'own_transfer'
  | 'manual_rule'
  | 'unknown'

export interface AutomationCandidate {
  type: AutomationCandidateType
  candidateId: string | null
  /** 0–100 */
  score: number
  reasonCodes: string[]
  proposedAccount: string | null
  metadata: Record<string, unknown>
}

export type AutomationDecisionKind =
  | 'ignored'
  | 'suggested'
  | 'pending_operation_created'
  | 'auto_committed'
  | 'blocked'

export interface AutomationOutcome {
  decision: AutomationDecisionKind
  /** 0–1 confidence of the selected candidate (0 when none). */
  confidence: number
  candidate: AutomationCandidate | null
  reasonCodes: string[]
  riskLevel: 'low' | 'normal' | 'high'
  journalEntryId: string | null
  pendingOperationId: string | null
  decisionId: string | null
  /** True when the outcome was replayed from a previously stored decision. */
  replayed: boolean
}

export interface CustomerInvoiceMatchInput {
  invoice: Invoice & { customer?: Customer }
  confidence: number
  matchReason: string
}

export interface SupplierInvoiceMatchInput {
  supplierInvoice: SupplierInvoice
  confidence: number
  matchMethod: string
}

export interface ProcessTransactionInput {
  transaction: Transaction
  settings: CompanyAutomationSettings
  /** True when a completed SIE import overlaps the import window. */
  sieOverlap: boolean
  settlementAccount?: string
  /** Precomputed candidate matches (from the shared matching layer). */
  invoiceMatch?: CustomerInvoiceMatchInput | null
  supplierMatch?: SupplierInvoiceMatchInput | null
  /**
   * Ambiguity flag from the payment-matching service — true when another
   * invoice was a close runner-up. Blocks auto-commits.
   */
  matchAmbiguous?: boolean
  /** Blocking reasons from the payment-matching service for the best match. */
  matchBlockingReasons?: string[]
  /** Legacy skip flag from IngestOptions (SIE overlap paths set it). */
  skipAutoCategorization?: boolean
}

const AMBIGUITY_SCORE_GAP = 10

function riskFromMapping(mapping: MappingResult): 'low' | 'normal' | 'high' {
  const level = String(mapping.risk_level ?? '').toUpperCase()
  if (level === 'LOW') return 'low'
  if (level === 'HIGH') return 'high'
  return 'normal'
}

function isCashAccount(account: string | null | undefined): boolean {
  return !!account && /^19\d{2}$/.test(account)
}

const BANK_FEE_ACCOUNT = '6570'
const BANK_FEE_TEXT = /avgift|bankavgift|månadsavgift|kortavgift|pris\s+bank|serviceavgift/i
const TAX_PAYMENT_TEXT = /skatteverket|skattekonto|bg\s*5050-?1055/i
/** Bank fees above this are not "safe" to silently book (SEK). */
const BANK_FEE_SAFE_MAX_SEK = 2000

function classifyMappingCandidate(
  transaction: Transaction,
  mapping: MappingResult,
): AutomationCandidate {
  const reasonCodes: string[] = []
  let type: AutomationCandidateType = 'unknown'

  const debit = mapping.debit_account
  const credit = mapping.credit_account

  if (isCashAccount(debit) && isCashAccount(credit)) {
    type = 'own_transfer'
    reasonCodes.push('own_account_transfer_detected')
  } else if (
    transaction.amount < 0 &&
    debit === BANK_FEE_ACCOUNT &&
    BANK_FEE_TEXT.test(transaction.description ?? '')
  ) {
    type = 'bank_fee'
    reasonCodes.push('bank_fee_pattern')
  } else if (transaction.amount < 0 && TAX_PAYMENT_TEXT.test(transaction.description ?? '')) {
    type = 'tax_payment'
    reasonCodes.push('tax_payment_pattern')
  } else if (mapping.rule || mapping.template_id) {
    type = 'manual_rule'
    reasonCodes.push(mapping.rule ? 'mapping_rule_match' : 'booking_template_match')
  } else if (mapping.confidence >= 0.3) {
    type = 'manual_rule'
    reasonCodes.push('counterparty_template_match')
  } else {
    reasonCodes.push('no_confident_mapping')
  }

  if (mapping.requires_review) reasonCodes.push('mapping_requires_review')

  return {
    type,
    candidateId: mapping.rule?.id ?? null,
    score: Math.round(Math.max(0, Math.min(1, mapping.confidence)) * 100),
    reasonCodes,
    proposedAccount: transaction.amount < 0 ? debit : credit,
    metadata: {
      debit_account: debit,
      credit_account: credit,
      description: mapping.description,
      requires_review: mapping.requires_review,
      risk_level: mapping.risk_level,
    },
  }
}

/** Absolute SEK amount for cap checks — falls back to the raw amount for SEK rows. */
function absAmountSek(transaction: Transaction): number {
  const sek = transaction.amount_sek ?? (transaction.currency === 'SEK' ? transaction.amount : null)
  return sek === null ? Math.abs(transaction.amount) : Math.abs(sek)
}

function invoiceRemaining(invoice: Invoice): number {
  return invoice.remaining_amount ?? invoice.total
}

function isExactPayment(transaction: Transaction, invoice: Invoice): boolean {
  return Math.abs(transaction.amount - invoiceRemaining(invoice)) < 0.005
}

// ── Evaluation ───────────────────────────────────────────────────────────────

interface EvaluationResult {
  candidates: AutomationCandidate[]
  selected: AutomationCandidate | null
  mapping: MappingResult | null
  action:
    | { kind: 'none'; reasonCodes: string[] }
    | { kind: 'suggest'; reasonCodes: string[] }
    | { kind: 'pending_op'; reasonCodes: string[] }
    | { kind: 'auto_book_mapping'; reasonCodes: string[] }
    | { kind: 'auto_settle_invoice'; reasonCodes: string[] }
    | { kind: 'auto_link_supplier'; reasonCodes: string[] }
  riskLevel: 'low' | 'normal' | 'high'
}

async function evaluateTransaction(
  supabase: SupabaseClient,
  companyId: string,
  input: ProcessTransactionInput,
): Promise<EvaluationResult> {
  const { transaction, settings, sieOverlap, invoiceMatch, supplierMatch } = input
  const candidates: AutomationCandidate[] = []
  const blocking: string[] = []

  // Global guard: already linked/booked/reconciled rows are never re-decided.
  if (
    transaction.journal_entry_id ||
    transaction.invoice_id ||
    transaction.supplier_invoice_id ||
    transaction.reconciliation_method
  ) {
    return {
      candidates,
      selected: null,
      mapping: null,
      action: { kind: 'none', reasonCodes: ['already_linked'] },
      riskLevel: 'low',
    }
  }

  // Candidate: customer invoice (income only)
  if (invoiceMatch && transaction.amount > 0) {
    const invoice = invoiceMatch.invoice
    const reasonCodes = [invoiceMatch.matchReason]
    if (isExactPayment(transaction, invoice)) reasonCodes.push('exact_amount')
    else reasonCodes.push('partial_or_over_payment')
    if (invoice.currency !== transaction.currency) reasonCodes.push('cross_currency')
    candidates.push({
      type: 'customer_invoice',
      candidateId: invoice.id,
      score: Math.round(Math.max(0, Math.min(1, invoiceMatch.confidence)) * 100),
      reasonCodes,
      proposedAccount: null,
      metadata: {
        invoice_number: invoice.invoice_number,
        invoice_status: invoice.status,
        remaining_amount: invoiceRemaining(invoice),
        currency: invoice.currency,
      },
    })
  }

  // Candidate: supplier invoice (expense only)
  if (supplierMatch && transaction.amount < 0) {
    candidates.push({
      type: 'supplier_invoice',
      candidateId: supplierMatch.supplierInvoice.id,
      score: Math.round(Math.max(0, Math.min(1, supplierMatch.confidence)) * 100),
      reasonCodes: [supplierMatch.matchMethod],
      proposedAccount: null,
      metadata: {
        supplier_invoice_number: supplierMatch.supplierInvoice.supplier_invoice_number,
        supplier_invoice_status: supplierMatch.supplierInvoice.status,
        remaining_amount: supplierMatch.supplierInvoice.remaining_amount,
      },
    })
  }

  // Candidate: mapping rule / template / own transfer / bank fee / tax payment
  let mapping: MappingResult | null = null
  try {
    mapping = await evaluateMappingRules(
      supabase,
      companyId,
      transaction,
      undefined,
      input.settlementAccount,
    )
    candidates.push(classifyMappingCandidate(transaction, mapping))
  } catch (err) {
    log.warn('mapping evaluation failed during automation', {
      companyId,
      transactionId: transaction.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  const sorted = [...candidates].sort((a, b) => b.score - a.score)
  const selected = sorted[0] ?? null
  const runnerUp = sorted[1] ?? null

  const minSuggestScore = Math.round(settings.minSuggestionConfidence * 100)
  const minAutoScore = Math.round(settings.minAutoConfidence * 100)

  if (!selected || selected.score < minSuggestScore) {
    return {
      candidates,
      selected,
      mapping,
      action: { kind: 'none', reasonCodes: ['below_suggestion_threshold'] },
      riskLevel: mapping ? riskFromMapping(mapping) : 'normal',
    }
  }

  const riskLevel =
    selected.type === 'customer_invoice' || selected.type === 'supplier_invoice'
      ? 'normal'
      : mapping
        ? riskFromMapping(mapping)
        : 'normal'

  // ── Auto-commit guards (each failed guard appends a blocking reason) ──────

  const capAllowsAuto = settings.bankImportAfterSyncMode === 'auto_safe'
  if (!capAllowsAuto) blocking.push('after_sync_mode_blocks_auto')

  if (selected.score < minAutoScore) blocking.push('below_auto_confidence')

  // Ambiguity: a close runner-up that points at a different target — either
  // detected across the engine's own candidate set, or flagged by the
  // payment-matching service (close invoice-vs-invoice candidates).
  if (
    (runnerUp &&
      runnerUp.score >= minSuggestScore &&
      selected.score - runnerUp.score < AMBIGUITY_SCORE_GAP &&
      (runnerUp.candidateId !== selected.candidateId || runnerUp.type !== selected.type)) ||
    (input.matchAmbiguous &&
      (selected.type === 'customer_invoice' || selected.type === 'supplier_invoice'))
  ) {
    blocking.push('ambiguous_candidates')
  }

  // Blocking reasons the payment-matching service attached to the best match
  // (disputed/already paid/cross-currency/partial …). Exactness and currency
  // are re-verified below for customer invoices; dedupe when merging.
  if (
    input.matchBlockingReasons?.length &&
    (selected.type === 'customer_invoice' || selected.type === 'supplier_invoice')
  ) {
    for (const reason of input.matchBlockingReasons) {
      if (!blocking.includes(reason)) blocking.push(reason)
    }
  }

  // Amount cap.
  if (
    settings.maxAutoBookAmount !== null &&
    absAmountSek(transaction) > settings.maxAutoBookAmount
  ) {
    blocking.push('amount_over_auto_cap')
  }

  // Per-domain mode + allow flags.
  let domainAllowsAuto = false
  switch (selected.type) {
    case 'customer_invoice': {
      const mode = settings.invoicePaymentMatchingMode
      domainAllowsAuto =
        (mode === 'auto_safe' || mode === 'auto_full') &&
        settings.allowAutoCustomerInvoiceSettlement
      if (!domainAllowsAuto) blocking.push('invoice_auto_settlement_disabled')
      const invoice = invoiceMatch?.invoice
      if (invoice) {
        if (!isExactPayment(transaction, invoice)) blocking.push('not_exact_payment')
        if (invoice.currency !== transaction.currency) blocking.push('cross_currency')
        if (invoice.status === 'disputed') blocking.push('invoice_disputed')
      }
      break
    }
    case 'supplier_invoice': {
      const mode = settings.supplierInvoiceMatchingMode
      domainAllowsAuto = mode === 'auto_safe' || mode === 'auto_full'
      if (!domainAllowsAuto) blocking.push('supplier_auto_link_disabled')
      break
    }
    case 'bank_fee': {
      const mode = settings.bankTransactionMode
      domainAllowsAuto =
        (mode === 'auto_safe' || mode === 'auto_full') && settings.allowAutoBankFeeBooking
      if (!domainAllowsAuto) blocking.push('bank_fee_auto_disabled')
      if (absAmountSek(transaction) > BANK_FEE_SAFE_MAX_SEK) blocking.push('bank_fee_amount_unsafe')
      if (mapping?.requires_review) blocking.push('vat_treatment_unclear')
      break
    }
    case 'own_transfer': {
      const mode = settings.bankTransactionMode
      domainAllowsAuto = mode === 'auto_safe' || mode === 'auto_full'
      if (!domainAllowsAuto) blocking.push('bank_mode_blocks_auto')
      // FX transfers require review (kursvinst/förlust leg).
      if (mapping?.requires_review) blocking.push('fx_transfer_requires_review')
      break
    }
    case 'tax_payment': {
      const mode = settings.bankTransactionMode
      domainAllowsAuto =
        (mode === 'auto_safe' || mode === 'auto_full') && settings.allowAutoTaxPaymentBooking
      if (!domainAllowsAuto) blocking.push('tax_payment_auto_disabled')
      if (mapping?.requires_review) blocking.push('vat_treatment_unclear')
      break
    }
    case 'salary': {
      const mode = settings.bankTransactionMode
      domainAllowsAuto =
        (mode === 'auto_safe' || mode === 'auto_full') && settings.allowAutoSalaryPaymentBooking
      if (!domainAllowsAuto) blocking.push('salary_auto_disabled')
      break
    }
    case 'manual_rule': {
      const mode = settings.bankTransactionMode
      domainAllowsAuto =
        (mode === 'auto_safe' || mode === 'auto_full') && settings.allowAutoCategoryBooking
      if (!domainAllowsAuto) blocking.push('category_auto_disabled')
      if (mapping?.requires_review) blocking.push('vat_treatment_unclear')
      break
    }
    default:
      blocking.push('no_actionable_candidate')
  }

  // SIE overlap blocks all journal-creating autos (double-booking risk); safe
  // invoice matching (which clears an existing receivable) is still allowed.
  const isJournalCreating =
    selected.type === 'bank_fee' ||
    selected.type === 'own_transfer' ||
    selected.type === 'manual_rule' ||
    selected.type === 'tax_payment' ||
    selected.type === 'salary'
  if ((sieOverlap || input.skipAutoCategorization) && isJournalCreating) {
    blocking.push('sie_import_overlap')
  }

  // Period lock — only checked when everything else allows auto (saves a
  // round-trip on the common suggest path).
  if (blocking.length === 0) {
    try {
      const periodStatus = await resolvePeriodStatusForDate(supabase, companyId, transaction.date)
      if (periodStatus.status !== 'open') blocking.push(`period_${periodStatus.status}`)
    } catch {
      blocking.push('period_status_unknown')
    }
  }

  if (blocking.length === 0) {
    const reasonCodes = [...selected.reasonCodes, 'auto_guards_passed']
    if (selected.type === 'customer_invoice') {
      return { candidates, selected, mapping, action: { kind: 'auto_settle_invoice', reasonCodes }, riskLevel }
    }
    if (selected.type === 'supplier_invoice') {
      return { candidates, selected, mapping, action: { kind: 'auto_link_supplier', reasonCodes }, riskLevel }
    }
    return { candidates, selected, mapping, action: { kind: 'auto_book_mapping', reasonCodes }, riskLevel }
  }

  // Not auto — decide between pending operation and plain suggestion.
  const capAllowsPending =
    settings.bankImportAfterSyncMode === 'process_pending' ||
    settings.bankImportAfterSyncMode === 'auto_safe'

  const invoiceModeIsAuto =
    settings.invoicePaymentMatchingMode === 'auto_safe' ||
    settings.invoicePaymentMatchingMode === 'auto_full'

  // A confident customer-invoice match that a soft guard stopped becomes a
  // pending operation (human approves, executor books) — but only when the
  // company has opted into the auto posture and the after-sync cap allows it.
  if (
    selected.type === 'customer_invoice' &&
    capAllowsPending &&
    invoiceModeIsAuto &&
    selected.score >= minAutoScore &&
    !blocking.includes('invoice_disputed') &&
    !blocking.includes('cross_currency')
  ) {
    return {
      candidates,
      selected,
      mapping,
      action: { kind: 'pending_op', reasonCodes: blocking },
      riskLevel,
    }
  }

  return {
    candidates,
    selected,
    mapping,
    action: { kind: 'suggest', reasonCodes: blocking },
    riskLevel,
  }
}

// ── Effects ──────────────────────────────────────────────────────────────────

async function persistCandidates(
  supabase: SupabaseClient,
  companyId: string,
  transactionId: string,
  candidates: AutomationCandidate[],
): Promise<void> {
  try {
    await supabase
      .from('transaction_match_candidates')
      .delete()
      .eq('company_id', companyId)
      .eq('transaction_id', transactionId)
    if (candidates.length > 0) {
      await supabase.from('transaction_match_candidates').insert(
        candidates.map((c) => ({
          company_id: companyId,
          transaction_id: transactionId,
          candidate_type: c.type,
          candidate_id: c.candidateId,
          score: c.score,
          reason_codes: c.reasonCodes,
          proposed_account: c.proposedAccount,
          metadata: c.metadata,
        })),
      )
    }
  } catch (err) {
    log.warn('failed to persist match candidates', {
      companyId,
      transactionId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

type DbDecision = 'auto_book' | 'suggest' | 'review' | 'ignore' | 'reject'

function toDbDecision(kind: AutomationDecisionKind): DbDecision {
  switch (kind) {
    case 'auto_committed':
      return 'auto_book'
    case 'suggested':
      return 'suggest'
    case 'pending_operation_created':
      return 'review'
    case 'blocked':
      return 'reject'
    default:
      return 'ignore'
  }
}

function toAutomationStatus(kind: AutomationDecisionKind): string {
  switch (kind) {
    case 'auto_committed':
      return 'auto_booked'
    case 'suggested':
      return 'suggested'
    case 'pending_operation_created':
      return 'needs_review'
    case 'blocked':
      return 'needs_review'
    default:
      return 'needs_review'
  }
}

/**
 * Insert the decision row FIRST — before any side effect — with a
 * deterministic idempotency key. A unique-violation means a previous run
 * already decided this transaction: the caller must replay (no side effects).
 */
async function claimDecision(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  transactionId: string,
  intended: {
    decision: AutomationDecisionKind
    confidence: number
    riskLevel: 'low' | 'normal' | 'high'
    reasonCodes: string[]
    selected: AutomationCandidate | null
    source: string
  },
): Promise<{ decisionId: string | null; replayed: boolean }> {
  const idempotencyKey = `bank_tx:${transactionId}`
  const { data, error } = await supabase
    .from('automation_decisions')
    .insert({
      company_id: companyId,
      transaction_id: transactionId,
      decision: toDbDecision(intended.decision),
      confidence: Math.round(Math.max(0, Math.min(1, intended.confidence)) * 100),
      risk_level: intended.riskLevel,
      reason_codes: intended.reasonCodes,
      proposed_journal: intended.selected
        ? { candidate_type: intended.selected.type, ...intended.selected.metadata }
        : {},
      status: 'pending',
      metadata: {
        outcome: intended.decision,
        candidate_id: intended.selected?.candidateId ?? null,
      },
      idempotency_key: idempotencyKey,
      source: intended.source,
      created_by: userId,
    })
    .select('id')
    .single()

  if (error) {
    // 23505 = unique violation on (company_id, idempotency_key): decision
    // already recorded by a previous run — replay, never re-execute.
    if ((error as { code?: string }).code === '23505') {
      return { decisionId: null, replayed: true }
    }
    log.warn('failed to record automation decision', {
      companyId,
      transactionId,
      error: error.message,
    })
    return { decisionId: null, replayed: false }
  }
  return { decisionId: (data as { id: string }).id, replayed: false }
}

/** Finalize the claimed decision row after side effects ran (or failed). */
async function finalizeDecision(
  supabase: SupabaseClient,
  decisionId: string,
  outcome: {
    decision: AutomationDecisionKind
    reasonCodes: string[]
    journalEntryId: string | null
    pendingOperationId: string | null
  },
): Promise<void> {
  try {
    await supabase
      .from('automation_decisions')
      .update({
        decision: toDbDecision(outcome.decision),
        status: outcome.decision === 'auto_committed' ? 'applied' : 'pending',
        reason_codes: outcome.reasonCodes,
        applied_journal_entry_id: outcome.journalEntryId,
        metadata: {
          outcome: outcome.decision,
          pending_operation_id: outcome.pendingOperationId,
        },
      })
      .eq('id', decisionId)
  } catch {
    // Non-critical — the claim row still records the intent.
  }
}

async function updateTransactionAutomationState(
  supabase: SupabaseClient,
  transactionId: string,
  kind: AutomationDecisionKind,
  confidence: number,
  decisionId: string | null,
): Promise<void> {
  try {
    await supabase
      .from('transactions')
      .update({
        automation_status: toAutomationStatus(kind),
        automation_confidence: Math.round(Math.max(0, Math.min(1, confidence)) * 100),
        ...(decisionId ? { automation_decision_id: decisionId } : {}),
      })
      .eq('id', transactionId)
  } catch {
    // Non-critical — the decision row is the source of truth.
  }
}

async function stageAutomationPendingOperation(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  operationType: string,
  title: string,
  params: Record<string, unknown>,
  previewData: Record<string, unknown>,
  riskLevel: 'low' | 'medium' | 'high',
): Promise<string | null> {
  const { data, error } = await supabase
    .from('pending_operations')
    .insert({
      company_id: companyId,
      user_id: userId,
      operation_type: operationType,
      title,
      params,
      preview_data: previewData,
      actor_type: 'automation',
      actor_label: 'Bankautomation',
      risk_level: riskLevel,
    })
    .select('id')
    .single()

  if (error) {
    log.warn('failed to stage automation pending operation', {
      companyId,
      operationType,
      error: error.message,
    })
    return null
  }
  return (data as { id: string }).id
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Evaluate one freshly imported bank transaction and apply the resulting
 * decision under the company's automation settings.
 *
 * Guarantees:
 *  - Nothing is booked when the mode is off/suggest.
 *  - Auto-commits only run when EVERY guard passes (confidence, ambiguity,
 *    period status, SIE overlap, amount cap, per-domain allow flags).
 *  - Every evaluation is recorded in automation_decisions with a
 *    deterministic idempotency key; a retried run replays instead of
 *    re-executing.
 *  - Uncertain-but-confident cases become pending operations for review.
 */
export async function processBankTransactionAutomation(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: ProcessTransactionInput,
  source: string = 'bank_import',
): Promise<AutomationOutcome> {
  const { transaction, settings } = input

  const none: AutomationOutcome = {
    decision: 'ignored',
    confidence: 0,
    candidate: null,
    reasonCodes: [],
    riskLevel: 'low',
    journalEntryId: null,
    pendingOperationId: null,
    decisionId: null,
    replayed: false,
  }

  // Mode off / after-sync off: no evaluation, no writes.
  if (settings.bankImportAfterSyncMode === 'off') {
    return { ...none, reasonCodes: ['after_sync_mode_off'] }
  }
  if (
    settings.bankTransactionMode === 'off' &&
    settings.invoicePaymentMatchingMode === 'off' &&
    settings.supplierInvoiceMatchingMode === 'off'
  ) {
    return { ...none, reasonCodes: ['automation_off'] }
  }

  const evaluation = await evaluateTransaction(supabase, companyId, input)
  const { candidates, selected, mapping, action, riskLevel } = evaluation
  const confidence = selected ? selected.score / 100 : 0

  await persistCandidates(supabase, companyId, transaction.id, candidates)

  const intendedKind: AutomationDecisionKind =
    action.kind === 'none'
      ? action.reasonCodes.includes('already_linked')
        ? 'blocked'
        : 'ignored'
      : action.kind === 'suggest'
        ? 'suggested'
        : action.kind === 'pending_op'
          ? 'pending_operation_created'
          : 'auto_committed'

  // Claim the decision BEFORE any side effect: the unique idempotency key is
  // what makes a retried sync/import safe — a replay never re-books.
  const { decisionId, replayed } = await claimDecision(supabase, companyId, userId, transaction.id, {
    decision: intendedKind,
    confidence,
    riskLevel,
    reasonCodes: action.reasonCodes,
    selected,
    source,
  })

  if (replayed) {
    return {
      decision: 'ignored',
      confidence,
      candidate: selected,
      reasonCodes: ['idempotent_replay'],
      riskLevel,
      journalEntryId: null,
      pendingOperationId: null,
      decisionId: null,
      replayed: true,
    }
  }

  let journalEntryId: string | null = null
  let pendingOperationId: string | null = null
  let decisionKind: AutomationDecisionKind
  let reasonCodes = action.reasonCodes

  switch (action.kind) {
    case 'none': {
      decisionKind = reasonCodes.includes('already_linked') ? 'blocked' : 'ignored'
      // Audit trail: a candidate was scored but nothing came of it — the
      // "varför matchades inte transaktionen?" answer lives here.
      if (selected && (selected.type === 'customer_invoice' || selected.type === 'supplier_invoice')) {
        logMatchEvent(supabase, userId, transaction.id, 'evaluated', {
          companyId,
          ...(selected.type === 'customer_invoice'
            ? { invoiceId: selected.candidateId ?? undefined }
            : { supplierInvoiceId: selected.candidateId ?? undefined }),
          matchConfidence: confidence,
          matchMethod: selected.reasonCodes[0],
          newState: { reason_codes: reasonCodes },
        })
      }
      break
    }

    case 'suggest': {
      decisionKind = 'suggested'
      // Suggestion links: potential invoice / supplier invoice for the UI.
      if (selected?.type === 'customer_invoice' && selected.candidateId) {
        await supabase
          .from('transactions')
          .update({ potential_invoice_id: selected.candidateId })
          .eq('id', transaction.id)
        logMatchEvent(supabase, userId, transaction.id, 'auto_suggested', {
          companyId,
          invoiceId: selected.candidateId,
          matchConfidence: confidence,
          matchMethod: selected.reasonCodes[0],
        })
      } else if (selected?.type === 'supplier_invoice' && selected.candidateId) {
        await supabase
          .from('transactions')
          .update({ potential_supplier_invoice_id: selected.candidateId })
          .eq('id', transaction.id)
        logMatchEvent(supabase, userId, transaction.id, 'auto_suggested', {
          companyId,
          supplierInvoiceId: selected.candidateId,
          matchConfidence: confidence,
          matchMethod: selected.reasonCodes[0],
        })
      }
      break
    }

    case 'pending_op': {
      // Confident customer-invoice match blocked by a soft guard → stage a
      // reviewable match_transaction_invoice operation.
      const invoiceId = selected?.candidateId
      if (invoiceId) {
        // Also record the suggestion link so the transaction UI shows it.
        await supabase
          .from('transactions')
          .update({ potential_invoice_id: invoiceId })
          .eq('id', transaction.id)
        pendingOperationId = await stageAutomationPendingOperation(
          supabase,
          companyId,
          userId,
          'match_transaction_invoice',
          `Matcha banktransaktion ${transaction.date} (${transaction.amount} ${transaction.currency}) mot faktura`,
          { transaction_id: transaction.id, invoice_id: invoiceId },
          {
            transaction: {
              id: transaction.id,
              date: transaction.date,
              amount: transaction.amount,
              currency: transaction.currency,
              description: transaction.description,
            },
            candidate: selected?.metadata ?? {},
            reason_codes: reasonCodes,
            confidence,
          },
          'medium',
        )
        logMatchEvent(supabase, userId, transaction.id, 'auto_suggested', {
          companyId,
          invoiceId,
          matchConfidence: confidence,
          matchMethod: selected?.reasonCodes[0],
        })
      }
      decisionKind = pendingOperationId ? 'pending_operation_created' : 'suggested'
      break
    }

    case 'auto_book_mapping': {
      // Safe category / bank fee / own transfer booking via the engine.
      decisionKind = 'suggested'
      if (mapping) {
        try {
          const journalEntry = await runWithActor(
            { type: 'automation', label: 'Bankautomation' },
            () => createTransactionJournalEntry(supabase, companyId, userId, transaction, mapping),
          )
          if (journalEntry) {
            journalEntryId = journalEntry.id
            await supabase
              .from('transactions')
              .update({
                journal_entry_id: journalEntry.id,
                is_business: !mapping.default_private,
              })
              .eq('id', transaction.id)
            try {
              await upsertCounterpartyTemplate(supabase, companyId, transaction, mapping, 'auto_learned')
            } catch {
              // Non-critical
            }
            decisionKind = 'auto_committed'
          }
        } catch (err) {
          log.warn('auto-booking failed — leaving transaction for review', {
            companyId,
            transactionId: transaction.id,
            error: err instanceof Error ? err.message : String(err),
          })
          reasonCodes = [...reasonCodes, 'auto_book_failed']
          decisionKind = 'blocked'
        }
      }
      break
    }

    case 'auto_settle_invoice': {
      // Exact customer-invoice payment: stage + immediately commit the
      // existing match_transaction_invoice executor so the settlement runs
      // through the same allocation/journal path a human approval would use —
      // and stays visible/reviewable as a committed pending operation.
      decisionKind = 'suggested'
      const invoiceId = selected?.candidateId
      if (invoiceId) {
        pendingOperationId = await stageAutomationPendingOperation(
          supabase,
          companyId,
          userId,
          'match_transaction_invoice',
          `Automatisk matchning: banktransaktion ${transaction.date} mot faktura`,
          { transaction_id: transaction.id, invoice_id: invoiceId },
          {
            transaction: {
              id: transaction.id,
              date: transaction.date,
              amount: transaction.amount,
              currency: transaction.currency,
              description: transaction.description,
            },
            candidate: selected?.metadata ?? {},
            reason_codes: reasonCodes,
            confidence,
            auto_committed: true,
          },
          'medium',
        )
        if (pendingOperationId) {
          const { data: opRow } = await supabase
            .from('pending_operations')
            .select('*')
            .eq('id', pendingOperationId)
            .single()
          if (opRow) {
            const commitResult = await commitPendingOperation(
              supabase,
              userId,
              companyId,
              opRow as PendingOperation,
              {
                commitMethod: 'automation',
                actor: { type: 'automation', label: 'Bankautomation' },
              },
            )
            if (commitResult.status === 'committed') {
              decisionKind = 'auto_committed'
              journalEntryId =
                typeof commitResult.data?.journal_entry_id === 'string'
                  ? commitResult.data.journal_entry_id
                  : null
              logMatchEvent(supabase, userId, transaction.id, 'auto_matched', {
                companyId,
                invoiceId,
                matchConfidence: confidence,
                matchMethod: selected?.reasonCodes[0],
              })
            } else {
              // Commit refused (state changed under us) — the op stays for
              // human review; nothing was booked.
              reasonCodes = [...reasonCodes, 'auto_settle_refused']
              decisionKind = 'pending_operation_created'
            }
          }
        }
      }
      break
    }

    case 'auto_link_supplier': {
      // Auto-LINK only (no payment booking): sets supplier_invoice_id so the
      // payment flow can settle it. Actual settlement stays human-gated
      // unless allow_auto_supplier_invoice_settlement (handled by the
      // payment-matching service).
      const supplierInvoiceId = selected?.candidateId
      if (supplierInvoiceId) {
        await supabase
          .from('transactions')
          .update({ supplier_invoice_id: supplierInvoiceId })
          .eq('id', transaction.id)
        logMatchEvent(supabase, userId, transaction.id, 'auto_matched', {
          companyId,
          supplierInvoiceId,
          matchConfidence: confidence,
          matchMethod: selected?.reasonCodes[0],
        })
        decisionKind = 'auto_committed'
      } else {
        decisionKind = 'suggested'
      }
      break
    }
  }

  if (decisionId) {
    await finalizeDecision(supabase, decisionId, {
      decision: decisionKind,
      reasonCodes,
      journalEntryId,
      pendingOperationId,
    })
  }

  await updateTransactionAutomationState(supabase, transaction.id, decisionKind, confidence, decisionId)

  return {
    decision: decisionKind,
    confidence,
    candidate: selected,
    reasonCodes,
    riskLevel,
    journalEntryId,
    pendingOperationId,
    decisionId,
    replayed: false,
  }
}
