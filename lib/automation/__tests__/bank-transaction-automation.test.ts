/**
 * Controlled-automation decision engine tests.
 *
 * Covers the Batch-2 guarantees: mode matrix, confidence thresholds,
 * ambiguity, period locks, SIE overlap, amount caps, per-domain allow flags,
 * idempotent retry and decision logging.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeTransaction, makeInvoice, makeSupplierInvoice } from '@/tests/helpers'
import type { Transaction } from '@/types'

const mockEvaluateMappingRules = vi.fn()
vi.mock('@/lib/bookkeeping/mapping-engine', () => ({
  evaluateMappingRules: (...args: unknown[]) => mockEvaluateMappingRules(...args),
}))

const mockCreateTransactionJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/transaction-entries', () => ({
  createTransactionJournalEntry: (...args: unknown[]) =>
    mockCreateTransactionJournalEntry(...args),
}))

vi.mock('@/lib/bookkeeping/counterparty-templates', () => ({
  upsertCounterpartyTemplate: vi.fn().mockResolvedValue(undefined),
}))

const mockResolvePeriodStatus = vi.fn()
vi.mock('@/lib/core/bookkeeping/period-service', () => ({
  resolvePeriodStatusForDate: (...args: unknown[]) => mockResolvePeriodStatus(...args),
}))

const mockCommitPendingOperation = vi.fn()
vi.mock('@/lib/pending-operations/commit', () => ({
  commitPendingOperation: (...args: unknown[]) => mockCommitPendingOperation(...args),
}))

const mockLogMatchEvent = vi.fn()
vi.mock('@/lib/invoices/match-log', () => ({
  logMatchEvent: (...args: unknown[]) => mockLogMatchEvent(...args),
}))

import {
  DEFAULT_AUTOMATION_SETTINGS,
  processBankTransactionAutomation,
  type CompanyAutomationSettings,
} from '../bank-transaction-automation'

// ── Table-routed Supabase mock ───────────────────────────────────────────────

function createTableMockSupabase() {
  const inserts: Record<string, unknown[]> = {}
  const updates: Record<string, unknown[]> = {}
  const deletes: string[] = []
  // Keyed `${table}:${op}` (op = select|insert|update|delete) with a bare
  // table-name fallback.
  const results: Record<string, { data: unknown; error: unknown }> = {}

  const setResult = (key: string, result: { data?: unknown; error?: unknown }) => {
    results[key] = { data: result.data ?? null, error: result.error ?? null }
  }

  const resolveFor = (table: string, op: string) =>
    results[`${table}:${op}`] ?? results[table] ?? { data: null, error: null }

  const buildChain = (table: string, op: string): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            const res = resolveFor(table, op)
            return (resolve: (v: unknown) => void) => resolve(res)
          }
          if (prop === 'insert') {
            return (payload: unknown) => {
              ;(inserts[table] ??= []).push(payload)
              return buildChain(table, 'insert')
            }
          }
          if (prop === 'update') {
            return (payload: unknown) => {
              ;(updates[table] ??= []).push(payload)
              return buildChain(table, 'update')
            }
          }
          if (prop === 'delete') {
            return () => {
              deletes.push(table)
              return buildChain(table, 'delete')
            }
          }
          return (..._args: unknown[]) => buildChain(table, op)
        },
      },
    )

  const supabase = {
    from: vi.fn().mockImplementation((table: string) => buildChain(table, 'select')),
    rpc: vi.fn().mockImplementation(() => buildChain('rpc', 'select')),
  }

  return { supabase, setResult, inserts, updates, deletes }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const COMPANY_ID = 'company-1'
const USER_ID = 'user-1'

function settings(overrides: Partial<CompanyAutomationSettings> = {}): CompanyAutomationSettings {
  return { ...DEFAULT_AUTOMATION_SETTINGS, ...overrides }
}

function feeTx(overrides: Partial<Transaction> = {}): Transaction {
  return makeTransaction({
    id: 'tx-fee',
    amount: -120,
    description: 'Bankavgift företagspaket',
    original_description: 'Bankavgift företagspaket',
    ...overrides,
  })
}

function feeMapping(overrides: Record<string, unknown> = {}) {
  return {
    rule: { id: 'rule-fee' },
    debit_account: '6570',
    credit_account: '1930',
    risk_level: 'LOW',
    confidence: 0.97,
    requires_review: false,
    default_private: false,
    vat_lines: [],
    description: 'Bankavgifter',
    ...overrides,
  }
}

function lowMapping() {
  return {
    rule: null,
    debit_account: '6991',
    credit_account: '1930',
    risk_level: 'MEDIUM',
    confidence: 0.1,
    requires_review: true,
    default_private: false,
    vat_lines: [],
    description: 'Okategoriserat',
    ...{},
  }
}

function autoSettings(overrides: Partial<CompanyAutomationSettings> = {}) {
  return settings({
    bankTransactionMode: 'auto_safe',
    bankImportAfterSyncMode: 'auto_safe',
    ...overrides,
  })
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    transaction: feeTx(),
    settings: autoSettings(),
    sieOverlap: false,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockResolvePeriodStatus.mockResolvedValue({ period_id: 'fp-1', status: 'open', lock_date: null })
  mockEvaluateMappingRules.mockResolvedValue(lowMapping())
  mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })
})

function setupDecisionInsert(setResult: ReturnType<typeof createTableMockSupabase>['setResult']) {
  setResult('automation_decisions:insert', { data: { id: 'dec-1' } })
  setResult('pending_operations:insert', { data: { id: 'op-1' } })
  setResult('pending_operations:select', {
    data: { id: 'op-1', operation_type: 'match_transaction_invoice', params: {}, status: 'pending' },
  })
}

// ── Mode matrix ──────────────────────────────────────────────────────────────

describe('mode matrix', () => {
  it('after-sync mode off: evaluates nothing and writes nothing', async () => {
    const { supabase, setResult, inserts } = createTableMockSupabase()
    setupDecisionInsert(setResult)

    const outcome = await processBankTransactionAutomation(supabase as never, COMPANY_ID, USER_ID, {
      ...baseInput(),
      settings: settings({ bankImportAfterSyncMode: 'off' }),
    } as never)

    expect(outcome.decision).toBe('ignored')
    expect(outcome.reasonCodes).toContain('after_sync_mode_off')
    expect(supabase.from).not.toHaveBeenCalled()
    expect(inserts['automation_decisions']).toBeUndefined()
  })

  it('all domain modes off: ignored without evaluation', async () => {
    const { supabase } = createTableMockSupabase()

    const outcome = await processBankTransactionAutomation(supabase as never, COMPANY_ID, USER_ID, {
      ...baseInput(),
      settings: settings({
        bankTransactionMode: 'off',
        invoicePaymentMatchingMode: 'off',
        supplierInvoiceMatchingMode: 'off',
      }),
    } as never)

    expect(outcome.decision).toBe('ignored')
    expect(outcome.reasonCodes).toContain('automation_off')
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('suggest mode never books, even at very high confidence', async () => {
    const { supabase, setResult, inserts } = createTableMockSupabase()
    setupDecisionInsert(setResult)
    mockEvaluateMappingRules.mockResolvedValue(feeMapping({ confidence: 0.99 }))

    const outcome = await processBankTransactionAutomation(supabase as never, COMPANY_ID, USER_ID, {
      ...baseInput(),
      settings: settings({ bankTransactionMode: 'suggest', bankImportAfterSyncMode: 'process_pending' }),
    } as never)

    expect(outcome.decision).toBe('suggested')
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
    // The decision IS logged.
    expect(inserts['automation_decisions']).toHaveLength(1)
  })
})

// ── Auto-booking guards ──────────────────────────────────────────────────────

describe('auto-booking guards', () => {
  it('auto-books a safe bank fee in auto_safe mode', async () => {
    const { supabase, setResult, inserts, updates } = createTableMockSupabase()
    setupDecisionInsert(setResult)
    mockEvaluateMappingRules.mockResolvedValue(feeMapping())

    const outcome = await processBankTransactionAutomation(
      supabase as never,
      COMPANY_ID,
      USER_ID,
      baseInput() as never,
    )

    expect(outcome.decision).toBe('auto_committed')
    expect(outcome.journalEntryId).toBe('je-1')
    expect(mockCreateTransactionJournalEntry).toHaveBeenCalled()
    // Decision row claimed before booking + transaction status updated.
    expect(inserts['automation_decisions']).toHaveLength(1)
    const txUpdates = updates['transactions'] ?? []
    expect(txUpdates.some((u) => (u as { automation_status?: string }).automation_status === 'auto_booked')).toBe(true)
  })

  it('does not auto-book below min_auto_confidence', async () => {
    const { supabase, setResult } = createTableMockSupabase()
    setupDecisionInsert(setResult)
    mockEvaluateMappingRules.mockResolvedValue(feeMapping({ confidence: 0.9 }))

    const outcome = await processBankTransactionAutomation(
      supabase as never,
      COMPANY_ID,
      USER_ID,
      baseInput({ settings: autoSettings({ minAutoConfidence: 0.95 }) }) as never,
    )

    expect(outcome.decision).toBe('suggested')
    expect(outcome.reasonCodes).toContain('below_auto_confidence')
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
  })

  it('does not auto-book above max_auto_book_amount', async () => {
    const { supabase, setResult } = createTableMockSupabase()
    setupDecisionInsert(setResult)
    mockEvaluateMappingRules.mockResolvedValue(feeMapping())

    const outcome = await processBankTransactionAutomation(
      supabase as never,
      COMPANY_ID,
      USER_ID,
      baseInput({
        transaction: feeTx({ amount: -1500 }),
        settings: autoSettings({ maxAutoBookAmount: 1000 }),
      }) as never,
    )

    expect(outcome.decision).toBe('suggested')
    expect(outcome.reasonCodes).toContain('amount_over_auto_cap')
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
  })

  it('does not auto-book into a closed period', async () => {
    const { supabase, setResult } = createTableMockSupabase()
    setupDecisionInsert(setResult)
    mockEvaluateMappingRules.mockResolvedValue(feeMapping())
    mockResolvePeriodStatus.mockResolvedValue({ period_id: 'fp-1', status: 'closed', lock_date: null })

    const outcome = await processBankTransactionAutomation(
      supabase as never,
      COMPANY_ID,
      USER_ID,
      baseInput() as never,
    )

    expect(outcome.decision).toBe('suggested')
    expect(outcome.reasonCodes).toContain('period_closed')
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
  })

  it('SIE overlap blocks journal-creating auto-booking', async () => {
    const { supabase, setResult } = createTableMockSupabase()
    setupDecisionInsert(setResult)
    mockEvaluateMappingRules.mockResolvedValue(feeMapping())

    const outcome = await processBankTransactionAutomation(
      supabase as never,
      COMPANY_ID,
      USER_ID,
      baseInput({ sieOverlap: true }) as never,
    )

    expect(outcome.decision).toBe('suggested')
    expect(outcome.reasonCodes).toContain('sie_import_overlap')
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
  })

  it('bank fee auto-booking honors allow_auto_bank_fee_booking=false', async () => {
    const { supabase, setResult } = createTableMockSupabase()
    setupDecisionInsert(setResult)
    mockEvaluateMappingRules.mockResolvedValue(feeMapping())

    const outcome = await processBankTransactionAutomation(
      supabase as never,
      COMPANY_ID,
      USER_ID,
      baseInput({ settings: autoSettings({ allowAutoBankFeeBooking: false }) }) as never,
    )

    expect(outcome.decision).toBe('suggested')
    expect(outcome.reasonCodes).toContain('bank_fee_auto_disabled')
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
  })

  it('category bookings stay suggestions unless allow_auto_category_booking is on', async () => {
    const { supabase, setResult } = createTableMockSupabase()
    setupDecisionInsert(setResult)
    // A generic rule match — not a fee, not a transfer.
    mockEvaluateMappingRules.mockResolvedValue(
      feeMapping({ debit_account: '5410', confidence: 0.98 }),
    )

    const blocked = await processBankTransactionAutomation(
      supabase as never,
      COMPANY_ID,
      USER_ID,
      baseInput({ transaction: feeTx({ description: 'Kontorsmaterial', original_description: 'Kontorsmaterial' }) }) as never,
    )
    expect(blocked.decision).toBe('suggested')
    expect(blocked.reasonCodes).toContain('category_auto_disabled')

    const { supabase: supabase2, setResult: setResult2 } = createTableMockSupabase()
    setupDecisionInsert(setResult2)
    const allowed = await processBankTransactionAutomation(
      supabase2 as never,
      COMPANY_ID,
      USER_ID,
      baseInput({
        transaction: feeTx({ description: 'Kontorsmaterial', original_description: 'Kontorsmaterial' }),
        settings: autoSettings({ allowAutoCategoryBooking: true }),
      }) as never,
    )
    expect(allowed.decision).toBe('auto_committed')
  })

  it('never auto-books when the VAT treatment is unclear (requires_review)', async () => {
    const { supabase, setResult } = createTableMockSupabase()
    setupDecisionInsert(setResult)
    mockEvaluateMappingRules.mockResolvedValue(feeMapping({ requires_review: true }))

    const outcome = await processBankTransactionAutomation(
      supabase as never,
      COMPANY_ID,
      USER_ID,
      baseInput() as never,
    )

    expect(outcome.decision).toBe('suggested')
    expect(outcome.reasonCodes).toContain('vat_treatment_unclear')
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
  })

  it('blocks auto when two candidates are close in score (ambiguity)', async () => {
    const { supabase, setResult } = createTableMockSupabase()
    setupDecisionInsert(setResult)
    // Income transaction with a 0.97 invoice match AND a 0.95 mapping match.
    mockEvaluateMappingRules.mockResolvedValue(feeMapping({ confidence: 0.95, debit_account: '1930', credit_account: '3001' }))
    const invoice = makeInvoice({ id: 'inv-1', status: 'sent', total: 5000, remaining_amount: 5000 })

    const outcome = await processBankTransactionAutomation(supabase as never, COMPANY_ID, USER_ID, {
      transaction: makeTransaction({ id: 'tx-amb', amount: 5000 }),
      settings: autoSettings(),
      sieOverlap: false,
      invoiceMatch: { invoice, confidence: 0.97, matchReason: 'ocr_match' },
    } as never)

    expect(outcome.decision).not.toBe('auto_committed')
    expect(outcome.reasonCodes).toContain('ambiguous_candidates')
  })
})

// ── Customer invoice settlement ──────────────────────────────────────────────

describe('customer invoice settlement', () => {
  const invoice = makeInvoice({
    id: 'inv-1',
    status: 'sent',
    total: 5000,
    remaining_amount: 5000,
    currency: 'SEK',
  })

  it('auto-settles an exact OCR match by staging + committing a pending operation', async () => {
    const { supabase, setResult, inserts } = createTableMockSupabase()
    setupDecisionInsert(setResult)
    mockEvaluateMappingRules.mockResolvedValue(lowMapping())
    mockCommitPendingOperation.mockResolvedValue({
      status: 'committed',
      data: { journal_entry_id: 'je-settle' },
    })

    const outcome = await processBankTransactionAutomation(supabase as never, COMPANY_ID, USER_ID, {
      transaction: makeTransaction({ id: 'tx-pay', amount: 5000, currency: 'SEK' }),
      settings: autoSettings(),
      sieOverlap: false,
      invoiceMatch: { invoice, confidence: 0.99, matchReason: 'ocr_match' },
    } as never)

    expect(outcome.decision).toBe('auto_committed')
    expect(outcome.journalEntryId).toBe('je-settle')
    expect(outcome.pendingOperationId).toBe('op-1')
    // Staged as an automation-actor pending operation before committing.
    const opInserts = inserts['pending_operations'] ?? []
    expect(opInserts).toHaveLength(1)
    expect((opInserts[0] as { actor_type: string }).actor_type).toBe('automation')
    expect(mockCommitPendingOperation).toHaveBeenCalledWith(
      expect.anything(),
      USER_ID,
      COMPANY_ID,
      expect.objectContaining({ id: 'op-1' }),
      expect.objectContaining({ commitMethod: 'automation' }),
    )
  })

  it('a partial payment becomes a pending operation, never a silent booking', async () => {
    const { supabase, setResult, inserts } = createTableMockSupabase()
    setupDecisionInsert(setResult)
    mockEvaluateMappingRules.mockResolvedValue(lowMapping())

    const outcome = await processBankTransactionAutomation(supabase as never, COMPANY_ID, USER_ID, {
      transaction: makeTransaction({ id: 'tx-partial', amount: 2500, currency: 'SEK' }),
      settings: autoSettings(),
      sieOverlap: false,
      invoiceMatch: { invoice, confidence: 0.99, matchReason: 'ocr_match' },
    } as never)

    expect(outcome.decision).toBe('pending_operation_created')
    expect(outcome.reasonCodes).toContain('not_exact_payment')
    expect(mockCommitPendingOperation).not.toHaveBeenCalled()
    expect(inserts['pending_operations']).toHaveLength(1)
  })

  it('respects allow_auto_customer_invoice_settlement=false', async () => {
    const { supabase, setResult } = createTableMockSupabase()
    setupDecisionInsert(setResult)
    mockEvaluateMappingRules.mockResolvedValue(lowMapping())

    const outcome = await processBankTransactionAutomation(supabase as never, COMPANY_ID, USER_ID, {
      transaction: makeTransaction({ id: 'tx-pay2', amount: 5000, currency: 'SEK' }),
      settings: autoSettings({ allowAutoCustomerInvoiceSettlement: false }),
      sieOverlap: false,
      invoiceMatch: { invoice, confidence: 0.99, matchReason: 'ocr_match' },
    } as never)

    expect(outcome.decision).not.toBe('auto_committed')
    expect(outcome.reasonCodes).toContain('invoice_auto_settlement_disabled')
    expect(mockCommitPendingOperation).not.toHaveBeenCalled()
  })

  it('never auto-settles a disputed invoice', async () => {
    const { supabase, setResult } = createTableMockSupabase()
    setupDecisionInsert(setResult)
    mockEvaluateMappingRules.mockResolvedValue(lowMapping())
    const disputed = makeInvoice({
      id: 'inv-d',
      status: 'disputed',
      total: 5000,
      remaining_amount: 5000,
    })

    const outcome = await processBankTransactionAutomation(supabase as never, COMPANY_ID, USER_ID, {
      transaction: makeTransaction({ id: 'tx-disp', amount: 5000, currency: 'SEK' }),
      settings: autoSettings(),
      sieOverlap: false,
      invoiceMatch: { invoice: disputed, confidence: 0.99, matchReason: 'ocr_match' },
    } as never)

    expect(outcome.decision).toBe('suggested')
    expect(outcome.reasonCodes).toContain('invoice_disputed')
    expect(mockCommitPendingOperation).not.toHaveBeenCalled()
  })
})

// ── Supplier invoice linking ─────────────────────────────────────────────────

describe('supplier invoice linking', () => {
  const supplierInvoice = makeSupplierInvoice({ id: 'si-1', remaining_amount: 10000 })

  it('suggest mode records a potential match only', async () => {
    const { supabase, setResult, updates } = createTableMockSupabase()
    setupDecisionInsert(setResult)
    mockEvaluateMappingRules.mockResolvedValue(lowMapping())

    const outcome = await processBankTransactionAutomation(supabase as never, COMPANY_ID, USER_ID, {
      transaction: makeTransaction({ id: 'tx-sup', amount: -10000 }),
      settings: settings({ supplierInvoiceMatchingMode: 'suggest', bankImportAfterSyncMode: 'auto_safe' }),
      sieOverlap: false,
      supplierMatch: { supplierInvoice, confidence: 0.96, matchMethod: 'payment_reference' },
    } as never)

    expect(outcome.decision).toBe('suggested')
    const txUpdates = updates['transactions'] ?? []
    expect(
      txUpdates.some(
        (u) => (u as { potential_supplier_invoice_id?: string }).potential_supplier_invoice_id === 'si-1',
      ),
    ).toBe(true)
    expect(
      txUpdates.some((u) => (u as { supplier_invoice_id?: string }).supplier_invoice_id === 'si-1'),
    ).toBe(false)
  })

  it('auto_safe mode links the supplier invoice (no payment booking)', async () => {
    const { supabase, setResult, updates } = createTableMockSupabase()
    setupDecisionInsert(setResult)
    mockEvaluateMappingRules.mockResolvedValue(lowMapping())

    const outcome = await processBankTransactionAutomation(supabase as never, COMPANY_ID, USER_ID, {
      transaction: makeTransaction({ id: 'tx-sup2', amount: -10000 }),
      settings: settings({ supplierInvoiceMatchingMode: 'auto_safe', bankImportAfterSyncMode: 'auto_safe' }),
      sieOverlap: false,
      supplierMatch: { supplierInvoice, confidence: 0.97, matchMethod: 'payment_reference' },
    } as never)

    expect(outcome.decision).toBe('auto_committed')
    const txUpdates = updates['transactions'] ?? []
    expect(
      txUpdates.some((u) => (u as { supplier_invoice_id?: string }).supplier_invoice_id === 'si-1'),
    ).toBe(true)
    // Linking only — the payment posting is a separate, gated step.
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
    expect(mockCommitPendingOperation).not.toHaveBeenCalled()
  })
})

// ── Salary payment linking ───────────────────────────────────────────────────

describe('salary payment linking', () => {
  const salaryRunRow = {
    id: 'run-1',
    payment_date: '2024-06-15',
    total_net: 25000,
    salary_entry_id: 'je-salary',
    status: 'booked',
  }

  it('links a matching salary payment to the run journal entry when allowed', async () => {
    const { supabase, setResult, updates } = createTableMockSupabase()
    setupDecisionInsert(setResult)
    setResult('salary_runs:select', { data: [salaryRunRow] })
    setResult('transactions:update', { data: [{ id: 'tx-sal' }] })
    mockEvaluateMappingRules.mockResolvedValue(lowMapping())

    const outcome = await processBankTransactionAutomation(supabase as never, COMPANY_ID, USER_ID, {
      transaction: makeTransaction({ id: 'tx-sal', amount: -25000, date: '2024-06-15' }),
      settings: autoSettings({ allowAutoSalaryPaymentBooking: true }),
      sieOverlap: false,
    } as never)

    expect(outcome.decision).toBe('auto_committed')
    expect(outcome.candidate?.type).toBe('salary')
    expect(outcome.journalEntryId).toBe('je-salary')
    const txUpdates = updates['transactions'] ?? []
    expect(
      txUpdates.some((u) => (u as { journal_entry_id?: string }).journal_entry_id === 'je-salary'),
    ).toBe(true)
    // Linking to the EXISTING salary entry — never a new booking.
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
  })

  it('salary payments stay suggestions when allow_auto_salary_payment_booking is off (default)', async () => {
    const { supabase, setResult, updates } = createTableMockSupabase()
    setupDecisionInsert(setResult)
    setResult('salary_runs:select', { data: [salaryRunRow] })
    mockEvaluateMappingRules.mockResolvedValue(lowMapping())

    const outcome = await processBankTransactionAutomation(supabase as never, COMPANY_ID, USER_ID, {
      transaction: makeTransaction({ id: 'tx-sal2', amount: -25000, date: '2024-06-15' }),
      settings: autoSettings(),
      sieOverlap: false,
    } as never)

    expect(outcome.decision).toBe('suggested')
    expect(outcome.reasonCodes).toContain('salary_auto_disabled')
    const txUpdates = updates['transactions'] ?? []
    expect(
      txUpdates.some((u) => (u as { journal_entry_id?: string }).journal_entry_id === 'je-salary'),
    ).toBe(false)
  })
})

// ── Idempotency & audit ──────────────────────────────────────────────────────

describe('idempotency and audit', () => {
  it('replays without side effects when the decision already exists', async () => {
    const { supabase, setResult } = createTableMockSupabase()
    setResult('automation_decisions:insert', {
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint' },
    })
    mockEvaluateMappingRules.mockResolvedValue(feeMapping())

    const outcome = await processBankTransactionAutomation(
      supabase as never,
      COMPANY_ID,
      USER_ID,
      baseInput() as never,
    )

    expect(outcome.replayed).toBe(true)
    expect(outcome.reasonCodes).toContain('idempotent_replay')
    // The retry MUST NOT re-book.
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
    expect(mockCommitPendingOperation).not.toHaveBeenCalled()
  })

  it('fails closed when the decision row cannot be claimed (non-23505 error)', async () => {
    const { supabase, setResult, inserts } = createTableMockSupabase()
    setResult('automation_decisions:insert', {
      data: null,
      error: { code: '57014', message: 'canceling statement due to statement timeout' },
    })
    mockEvaluateMappingRules.mockResolvedValue(feeMapping())

    const outcome = await processBankTransactionAutomation(
      supabase as never,
      COMPANY_ID,
      USER_ID,
      baseInput() as never,
    )

    // Without a claimed decision row there is no idempotency guarantee —
    // a retried run could double-book. Nothing may execute.
    expect(outcome.decision).toBe('blocked')
    expect(outcome.reasonCodes).toContain('decision_claim_failed')
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
    expect(mockCommitPendingOperation).not.toHaveBeenCalled()
    expect(inserts['pending_operations'] ?? []).toHaveLength(0)
  })

  it('bulk-booked transactions (voucher links, journal_entry_id NULL) are never re-decided', async () => {
    const { supabase, setResult } = createTableMockSupabase()
    setupDecisionInsert(setResult)
    setResult('transaction_voucher_links:select', {
      data: [{ transaction_id: 'tx-fee' }],
    })
    mockEvaluateMappingRules.mockResolvedValue(feeMapping())

    const outcome = await processBankTransactionAutomation(
      supabase as never,
      COMPANY_ID,
      USER_ID,
      baseInput() as never,
    )

    expect(outcome.decision).toBe('blocked')
    expect(outcome.reasonCodes).toContain('already_linked')
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
  })

  it('records a decision row with the deterministic idempotency key for every evaluation', async () => {
    const { supabase, setResult, inserts } = createTableMockSupabase()
    setupDecisionInsert(setResult)
    mockEvaluateMappingRules.mockResolvedValue(feeMapping({ confidence: 0.8 }))

    await processBankTransactionAutomation(
      supabase as never,
      COMPANY_ID,
      USER_ID,
      baseInput({ transaction: feeTx({ id: 'tx-audit' }) }) as never,
    )

    const decisionInserts = inserts['automation_decisions'] ?? []
    expect(decisionInserts).toHaveLength(1)
    const row = decisionInserts[0] as Record<string, unknown>
    expect(row.idempotency_key).toBe('bank_tx:tx-audit')
    expect(row.company_id).toBe(COMPANY_ID)
    expect(Array.isArray(row.reason_codes)).toBe(true)
  })

  it('already linked transactions are never re-decided', async () => {
    const { supabase, setResult, inserts } = createTableMockSupabase()
    setupDecisionInsert(setResult)

    const outcome = await processBankTransactionAutomation(
      supabase as never,
      COMPANY_ID,
      USER_ID,
      baseInput({ transaction: feeTx({ journal_entry_id: 'je-existing' }) }) as never,
    )

    expect(outcome.decision).toBe('blocked')
    expect(outcome.reasonCodes).toContain('already_linked')
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
    // The blocked decision is still logged.
    expect(inserts['automation_decisions']).toHaveLength(1)
  })

  it('a failed auto-booking downgrades to blocked and never leaves half state unlogged', async () => {
    const { supabase, setResult, inserts } = createTableMockSupabase()
    setupDecisionInsert(setResult)
    mockEvaluateMappingRules.mockResolvedValue(feeMapping())
    mockCreateTransactionJournalEntry.mockRejectedValue(new Error('period locked by trigger'))

    const outcome = await processBankTransactionAutomation(
      supabase as never,
      COMPANY_ID,
      USER_ID,
      baseInput() as never,
    )

    expect(outcome.decision).toBe('blocked')
    expect(outcome.reasonCodes).toContain('auto_book_failed')
    expect(outcome.journalEntryId).toBeNull()
    expect(inserts['automation_decisions']).toHaveLength(1)
  })
})
