import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { YearEndValidation } from '@/types'

// Mock the sources the aggregator composes from. Tests focus on composition
// (reminders by entity, DB blockers, fail-closed behavior) — the underlying
// validateYearEndReadiness already has its own coverage.
vi.mock('@/lib/core/bookkeeping/year-end-service', () => ({
  validateYearEndReadiness: vi.fn(),
}))

vi.mock('@/lib/bokslut/enskild-firma/ef-declaration-preview', () => ({
  computeEfDeclarationPreview: vi.fn(),
}))

import { buildBokslutReadinessReport } from '../readiness-aggregator'
import { validateYearEndReadiness } from '@/lib/core/bookkeeping/year-end-service'
import { computeEfDeclarationPreview } from '@/lib/bokslut/enskild-firma/ef-declaration-preview'

interface MockBuilder {
  select: ReturnType<typeof vi.fn>
  eq: ReturnType<typeof vi.fn>
  single: ReturnType<typeof vi.fn>
  maybeSingle: ReturnType<typeof vi.fn>
}

function makeSupabase(handlers: {
  period: { data: unknown; error: unknown }
  /** companies.entity_type — the canonical legal form (B13). */
  company?: { data: unknown; error: unknown }
  /** year_end_db_blockers RPC result (B03/B04). */
  dbBlockers?: { data: unknown; error: unknown }
  /** year_end_control_status RPC result. */
  controlRows?: { data: unknown; error: unknown }
  /** year_end_cash_reconciliation_status RPC result. */
  cashStatus?: { data: unknown; error: unknown }
}) {
  function makeBuilder(table: string): MockBuilder {
    const b: MockBuilder = {
      select: vi.fn(),
      eq: vi.fn(),
      single: vi.fn(),
      maybeSingle: vi.fn(),
    }
    b.select.mockReturnValue(b)
    b.eq.mockReturnValue(b)
    if (table === 'fiscal_periods') {
      b.single.mockResolvedValue(handlers.period)
    } else if (table === 'companies') {
      b.single.mockResolvedValue(handlers.company ?? { data: null, error: null })
    }
    return b
  }
  const rpc = vi.fn(async (fn: string) => {
    if (fn === 'year_end_cash_reconciliation_status') {
      return handlers.cashStatus ?? { data: CASH_RECON_CLEAN, error: null }
    }
    if (fn === 'year_end_control_status') {
      return handlers.controlRows ?? { data: [], error: null }
    }
    return handlers.dbBlockers ?? { data: [], error: null }
  })
  return {
    supabase: {
      from: vi.fn((table: string) => makeBuilder(table)),
      rpc,
    } as unknown as Parameters<typeof buildBokslutReadinessReport>[0],
    rpc,
  }
}

function baseValidation(overrides: Partial<YearEndValidation> = {}): YearEndValidation {
  return {
    ready: true,
    errors: [],
    warnings: [],
    draftCount: 0,
    voucherGaps: [],
    unexplainedGaps: [],
    sequenceMismatches: [],
    trialBalanceBalanced: true,
    ...overrides,
  }
}

const PERIOD = {
  id: 'fp-1',
  name: '2025',
  period_start: '2025-01-01',
  period_end: '2025-12-31',
  is_closed: false,
  locked_at: null,
  closing_entry_id: null,
}

const AB_COMPANY = { data: { entity_type: 'aktiebolag' }, error: null }
const EF_COMPANY = { data: { entity_type: 'enskild_firma' }, error: null }

const CASH_RECON_CLEAN = [{
  cash_account_id: 'cash-1',
  ledger_account: '1930',
  account_name: 'Företagskonto',
  currency: 'SEK',
  reconciliation_mode: 'automated',
  ledger_balance: 100,
  statement_balance: null,
  difference: 0,
  unmatched_transaction_count: 0,
  unmatched_gl_line_count: 0,
  matching_conflict_count: 0,
  reconciliation_id: null,
  evidence_document_id: null,
  evidence_file_name: null,
  evidence_sha256: null,
  verified_at: null,
  invalidated_at: null,
  invalidation_reason: null,
  snapshot_current: false,
  is_reconciled: true,
}]

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(computeEfDeclarationPreview).mockResolvedValue({
    bookedSurplus: 0,
  } as Awaited<ReturnType<typeof computeEfDeclarationPreview>>)
})

describe('buildBokslutReadinessReport', () => {
  it('returns a ready report with the accruals reminder for AB', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue(baseValidation())
    const { supabase, rpc } = makeSupabase({
      period: { data: PERIOD, error: null },
      company: AB_COMPANY,
      dbBlockers: { data: [], error: null },
    })

    const report = await buildBokslutReadinessReport(supabase, 'co-1', 'user-1', 'fp-1')

    expect(report.ready).toBe(true)
    expect(report.blockers).toEqual([])
    expect(report.blockerDetails).toEqual([])
    expect(report.entityType).toBe('aktiebolag')
    // The blocking checks come from the SAME database function the atomic
    // close re-runs inside its locked transaction (B03).
    expect(rpc).toHaveBeenCalledWith('year_end_db_blockers', {
      p_company_id: 'co-1',
      p_fiscal_period_id: 'fp-1',
    })
    // Phase 3 handles depreciation + bolagsskatt + p-fond automatically — only
    // the accruals reminder should remain (Phase 4 will replace it).
    expect(report.reminders.map((r) => r.code)).toContain('accruals_manual')
    expect(report.reminders.map((r) => r.code)).not.toContain('depreciation_manual')
    expect(report.reminders.map((r) => r.code)).not.toContain('bolagsskatt_manual')
    expect(report.reminders.map((r) => r.code)).not.toContain('periodiseringsfond_manual')
    expect(report.reminders.find((r) => r.code === 'ef_skatt_via_ne')).toBeUndefined()
    expect(report.reconciliation?.is_reconciled).toBe(true)
  })

  it('returns the EF-only reminder for enskild firma', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue(baseValidation())
    const { supabase } = makeSupabase({
      period: { data: PERIOD, error: null },
      company: EF_COMPANY,
    })

    const report = await buildBokslutReadinessReport(supabase, 'co-1', 'user-1', 'fp-1')

    expect(report.entityType).toBe('enskild_firma')
    expect(report.reminders.find((r) => r.code === 'ef_skatt_via_ne')).toBeDefined()
  })

  it('warns EF owners about missing kapitalunderlag when the surplus is large', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue(baseValidation())
    vi.mocked(computeEfDeclarationPreview).mockResolvedValue({
      bookedSurplus: 120_000,
    } as Awaited<ReturnType<typeof computeEfDeclarationPreview>>)
    const { supabase } = makeSupabase({
      period: { data: PERIOD, error: null },
      company: EF_COMPANY,
    })

    const report = await buildBokslutReadinessReport(supabase, 'co-1', 'user-1', 'fp-1')

    const reminder = report.reminders.find((r) => r.code === 'ef_kapitalunderlag_missing')
    expect(reminder).toBeDefined()
    expect(reminder?.severity).toBe('warning')
    // Informational only — never a blocker.
    expect(report.ready).toBe(true)
  })

  it('surfaces blockers from the underlying validation and stays not-ready', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue(
      baseValidation({
        ready: false,
        errors: ['3 draft journal entries must be posted or deleted before closing'],
        draftCount: 3,
      }),
    )
    const { supabase } = makeSupabase({
      period: { data: PERIOD, error: null },
      company: AB_COMPANY,
    })

    const report = await buildBokslutReadinessReport(supabase, 'co-1', 'user-1', 'fp-1')

    expect(report.ready).toBe(false)
    expect(report.blockers).toHaveLength(1)
    expect(report.draftCount).toBe(3)
  })

  it('turns year_end_db_blockers rows into structured blockerDetails with exact counts', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue(baseValidation())
    const { supabase } = makeSupabase({
      period: { data: PERIOD, error: null },
      company: AB_COMPANY,
      dbBlockers: {
        data: [
          {
            code: 'unposted_drafts',
            message: '3 verifikat är fortfarande utkast.',
            detail_count: 3,
          },
          {
            code: 'unexplained_gaps',
            message: '1 lucka i verifikationsserien saknar förklaring.',
            detail_count: null,
          },
        ],
        error: null,
      },
    })

    const report = await buildBokslutReadinessReport(supabase, 'co-1', 'user-1', 'fp-1')

    expect(report.ready).toBe(false)
    expect(report.blockerDetails).toEqual([
      {
        code: 'unposted_drafts',
        message: '3 verifikat är fortfarande utkast.',
        count: 3,
        checkCompleted: true,
      },
      {
        code: 'unexplained_gaps',
        message: '1 lucka i verifikationsserien saknar förklaring.',
        count: 0,
        checkCompleted: true,
      },
    ])
    // The flat blockers list carries the same messages for the UI.
    expect(report.blockers).toContain('3 verifikat är fortfarande utkast.')
    expect(report.blockers).toContain('1 lucka i verifikationsserien saknar förklaring.')
  })

  it('fails CLOSED when year_end_db_blockers errors (B04): readiness_check_failed blocker', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue(baseValidation())
    const { supabase } = makeSupabase({
      period: { data: PERIOD, error: null },
      company: AB_COMPANY,
      dbBlockers: { data: null, error: { message: 'connection reset' } },
    })

    const report = await buildBokslutReadinessReport(supabase, 'co-1', 'user-1', 'fp-1')

    expect(report.ready).toBe(false)
    const blocker = report.blockerDetails.find((d) => d.code === 'readiness_check_failed')
    expect(blocker).toBeDefined()
    expect(blocker?.checkCompleted).toBe(false)
    // Fails closed with a safe, user-facing Swedish message. The raw driver
    // text ("connection reset") stays in the server log — surfacing it here
    // would leak database internals into the client payload.
    expect(blocker?.message).not.toContain('connection reset')
    expect(blocker?.message).toBeTruthy()
    expect(report.blockers).toContain(blocker!.message)
  })

  it('fails CLOSED when the reconciliation lookup throws: reconciliation_check_failed blocker', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue(baseValidation())
    const { supabase } = makeSupabase({
      period: { data: PERIOD, error: null },
      company: AB_COMPANY,
      cashStatus: { data: null, error: { message: 'boom' } },
    })

    const report = await buildBokslutReadinessReport(supabase, 'co-1', 'user-1', 'fp-1')

    expect(report.reconciliation).toBeNull()
    expect(report.ready).toBe(false)
    const blocker = report.blockerDetails.find((d) => d.code === 'reconciliation_check_failed')
    expect(blocker).toBeDefined()
    expect(blocker?.checkCompleted).toBe(false)
    expect(blocker?.message).toContain('boom')
    // The soft reminder is for unreconciled banks, not failed checks.
    expect(report.reminders.find((r) => r.code === 'bank_reconciliation_incomplete')).toBeUndefined()
  })

  it('adds a reconciliation reminder when bank is unreconciled', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue(baseValidation())
    const { supabase } = makeSupabase({
      period: { data: PERIOD, error: null },
      company: AB_COMPANY,
      cashStatus: {
        data: [{
          ...CASH_RECON_CLEAN[0],
          is_reconciled: false,
          unmatched_transaction_count: 7,
          difference: 1234.56,
        }],
        error: null,
      },
    })

    const report = await buildBokslutReadinessReport(supabase, 'co-1', 'user-1', 'fp-1')

    const reconReminder = report.reminders.find((r) => r.code === 'bank_reconciliation_incomplete')
    expect(reconReminder).toBeDefined()
    expect(reconReminder?.severity).toBe('warning')
    expect(reconReminder?.message).toContain('7')
    // Reconciliation reminder is not a legal blocker — ready should still mirror validation
    expect(report.ready).toBe(true)
  })

  it('throws when the fiscal period is missing', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue(baseValidation())
    const { supabase } = makeSupabase({
      period: { data: null, error: { message: 'not found' } },
      company: AB_COMPANY,
    })

    await expect(
      buildBokslutReadinessReport(supabase, 'co-1', 'user-1', 'fp-missing'),
    ).rejects.toThrow(/not found/i)
  })

  it('blocks with entity_type_missing when companies.entity_type is absent — no silent AB fallback (B13)', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue(baseValidation())
    const { supabase } = makeSupabase({
      period: { data: PERIOD, error: null },
      company: { data: { entity_type: null }, error: null },
    })

    const report = await buildBokslutReadinessReport(supabase, 'co-1', 'user-1', 'fp-1')

    expect(report.ready).toBe(false)
    const blocker = report.blockerDetails.find((d) => d.code === 'entity_type_missing')
    expect(blocker).toBeDefined()
    expect(blocker?.checkCompleted).toBe(false)
    expect(report.blockers).toContain(blocker!.message)
    // No EF reminders sneak in from an assumed legal form.
    expect(report.reminders.find((r) => r.code === 'ef_skatt_via_ne')).toBeUndefined()
  })

  it('treats a current manual SIE-only verification as reconciled', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue(baseValidation())
    const { supabase } = makeSupabase({
      period: { data: PERIOD, error: null },
      company: AB_COMPANY,
      cashStatus: {
        data: [{
          ...CASH_RECON_CLEAN[0],
          reconciliation_mode: 'manual',
          statement_balance: 25_000,
          ledger_balance: 25_000,
          reconciliation_id: 'recon-1',
          evidence_document_id: 'doc-1',
          evidence_file_name: 'kontoutdrag.pdf',
          evidence_sha256: 'a'.repeat(64),
          verified_at: '2026-01-15T10:00:00Z',
          snapshot_current: true,
          is_reconciled: true,
        }],
        error: null,
      },
    })

    const report = await buildBokslutReadinessReport(supabase, 'co-1', 'user-1', 'fp-1')

    expect(report.ready).toBe(true)
    expect(report.reconciliation?.is_reconciled).toBe(true)
    expect(report.cashReconciliations[0]?.reconciliation_mode).toBe('manual')
    expect(
      report.reminders.find((item) => item.code === 'bank_reconciliation_incomplete'),
    ).toBeUndefined()
  })

  it('links a missing manual reconciliation blocker to the real period/company route', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue(baseValidation())
    const message =
      'Konto 1930 saknar bankkoppling. Ladda upp kontoutdrag och verifiera saldot manuellt per balansdagen.'
    const { supabase } = makeSupabase({
      period: { data: PERIOD, error: null },
      company: AB_COMPANY,
      dbBlockers: {
        data: [{
          code: 'manual_cash_reconciliation_missing',
          message,
          detail_count: 1,
        }],
        error: null,
      },
      cashStatus: {
        data: [{
          ...CASH_RECON_CLEAN[0],
          reconciliation_mode: 'manual',
          is_reconciled: false,
        }],
        error: null,
      },
    })

    const report = await buildBokslutReadinessReport(supabase, 'co-1', 'user-1', 'fp-1')

    expect(report.ready).toBe(false)
    expect(report.blockerDetails[0]).toMatchObject({
      code: 'manual_cash_reconciliation_missing',
      href: '/bookkeeping/year-end/reconciliation?period=fp-1&company_id=co-1',
      actionLabel: 'Öppna avstämning',
    })
    expect(report.reminders.find((item) => item.code === 'bank_reconciliation_incomplete')?.href)
      .toBe('/bookkeeping/year-end/reconciliation?period=fp-1&company_id=co-1')
  })

  it('separates an imported SIE confirmation from accounting errors and deep-links it', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue(baseValidation())
    const message =
      'Kundfordringar enligt importerad SIE: 11 250 kr. Bekräfta saldot.'
    const { supabase } = makeSupabase({
      period: { data: PERIOD, error: null },
      company: AB_COMPANY,
      dbBlockers: {
        data: [{
          code: 'customer_receivables_reconciliation',
          message,
          detail_count: 1,
        }],
        error: null,
      },
      controlRows: {
        data: [{
          control_code: 'customer_receivables_reconciliation',
          control_category: 'customer_receivables',
          status: 'imported_from_sie',
          ledger_amount: '11250.00',
          supporting_register_amount: null,
          difference: null,
          source_type: 'sie_ledger',
          verification_method: null,
          evidence_count: 0,
          is_stale: false,
          is_blocking: true,
          message,
          available_actions: ['accept_sie_balance'],
          metadata: { workpaper_id: 'wp-1' },
        }],
        error: null,
      },
    })

    const report = await buildBokslutReadinessReport(
      supabase,
      'co-1',
      'user-1',
      'fp-1',
    )

    expect(report.ready).toBe(false)
    expect(report.confirmationCount).toBe(1)
    expect(report.blockers).not.toContain(message)
    expect(report.controls?.[0]).toMatchObject({
      status: 'imported_from_sie',
      support_balance: null,
      difference: null,
      href:
        '/bookkeeping/year-end/historical-support?period=fp-1&company_id=co-1'
        + '&focus=customer_receivables_reconciliation',
    })
    expect(report.blockerDetails[0]?.resolutionKind).toBe('confirmation')
  })
})
