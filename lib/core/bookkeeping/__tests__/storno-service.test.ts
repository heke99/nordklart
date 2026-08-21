import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { makeJournalEntry, makeJournalEntryLine } from '@/tests/helpers'
import { BookkeepingDatabaseError, MeaninglessCorrectionError } from '@/lib/bookkeeping/errors'

// ============================================================
// Mock — separate client (no .then) from query builder (thenable)
//
// correctEntry no longer writes the two vouchers itself: it reads what it
// needs, plans both entries, and hands them to reverse_journal_entry_v2, which
// creates, links, commits and flips the original inside ONE transaction. The
// mock therefore models reads + one RPC, and the assertions are about the PLAN
// that goes over the wire rather than about a sequence of inserts.
// ============================================================

let resultIdx: number
let results: Array<{ data?: unknown; error?: unknown }>
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>
let rpcResult: { data?: unknown; error?: unknown }

function makeBuilder() {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'update', 'delete', 'insert']) {
    b[m] = vi.fn().mockReturnValue(b)
  }
  b.single = vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null })
  b.then = (resolve: (v: unknown) => void) => resolve(results[resultIdx++] ?? { data: null, error: null })
  return b
}

function makeClient() {
  return {
    from: vi.fn().mockImplementation(() => makeBuilder()),
    rpc: vi.fn().mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args })
      return rpcResult
    }),
  }
}

const serviceClient = { rpc: vi.fn() }

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => serviceClient,
}))

vi.mock('@/lib/bookkeeping/engine', () => ({
  validateBalance: vi.fn().mockReturnValue({ valid: true, totalDebit: 1000, totalCredit: 1000 }),
}))

import { correctEntry } from '../storno-service'
import { validateBalance } from '@/lib/bookkeeping/engine'

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  resultIdx = 0
  results = []
  rpcCalls = []
  rpcResult = { data: null, error: null }

  vi.mocked(validateBalance).mockReturnValue({ valid: true, totalDebit: 1000, totalCredit: 1000 })
  serviceClient.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args })
    return rpcResult
  })
})

/** The plan reverse_journal_entry_v2 was handed, by role. */
function plans() {
  const call = rpcCalls.find((c) => c.fn === 'reverse_journal_entry_v2')
  return {
    reversal: call?.args.p_reversal_journal as
      | { source_type: string; fiscal_period_id: string; entry_date: string; lines: Array<Record<string, number | string>> }
      | undefined,
    correction: call?.args.p_correction_journal as
      | { source_type: string; fiscal_period_id: string; entry_date: string; lines: Array<Record<string, number | string>> }
      | undefined,
  }
}

describe('correctEntry', () => {
  const originalEntry = makeJournalEntry({
    id: 'orig-1',
    status: 'posted',
    description: 'Test purchase',
    fiscal_period_id: 'fp-1',
    voucher_series: 'A',
    lines: [
      makeJournalEntryLine({ account_number: '5410', debit_amount: 1000, credit_amount: 0 }),
      makeJournalEntryLine({ account_number: '1930', debit_amount: 0, credit_amount: 1000 }),
    ],
  })

  const correctedLines = [
    { account_number: '5420', debit_amount: 1200, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: 1200 },
  ]

  function setupResults() {
    const reversalEntry = makeJournalEntry({ id: 'reversal-1', reverses_id: 'orig-1' })
    const correctedEntry = makeJournalEntry({ id: 'corrected-1', correction_of_id: 'orig-1' })

    results = [
      // 0: fetch original (.single())
      { data: originalEntry, error: null },
      // 1: active accounts for the corrected lines (thenable)
      { data: [{ account_number: '5420' }, { account_number: '1930' }], error: null },
      // 2: fetch final reversal (.single())
      { data: { ...reversalEntry, lines: [] }, error: null },
      // 3: fetch final corrected (.single())
      { data: { ...correctedEntry, lines: correctedLines }, error: null },
    ]
    rpcResult = {
      data: { reversal_entry_id: 'reversal-1', correction_entry_id: 'corrected-1' },
      error: null,
    }
  }

  it('creates reversal with swapped debit/credit lines', async () => {
    setupResults()
    const supabase = makeClient()
    const result = await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)
    expect(result.reversal).toBeDefined()
    expect(result.reversal.reverses_id).toBe('orig-1')
  })

  it('links original ↔ reversal ↔ corrected via IDs', async () => {
    setupResults()
    const supabase = makeClient()
    const result = await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)
    expect(result.reversal.id).toBe('reversal-1')
    expect(result.corrected.id).toBe('corrected-1')
    expect(result.corrected.correction_of_id).toBe('orig-1')
  })

  it('validates balance of corrected lines (rejects unbalanced)', async () => {
    vi.mocked(validateBalance).mockReturnValueOnce({
      valid: false,
      totalDebit: 1200,
      totalCredit: 1000,
    })

    const supabase = makeClient()
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', [
        { account_number: '5420', debit_amount: 1200, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
      ])
    ).rejects.toThrow('not balanced')
  })

  // The three tests this replaces asserted that a failure CANCELS the entries
  // it had already written. There is nothing to cancel any more: the vouchers
  // are created inside the RPC's transaction, so a rejection rolls them away.
  // What the service must still do is translate the domain code back into the
  // typed error the routes already handle.
  it('surfaces a concurrent reversal as EntryAlreadyReversedError, writing nothing', async () => {
    results = [
      { data: originalEntry, error: null },
      { data: [{ account_number: '5420' }, { account_number: '1930' }], error: null },
    ]
    rpcResult = {
      data: null,
      error: { message: 'Journal entry is already reversed.', details: '{"code":"ENTRY_ALREADY_REVERSED"}' },
    }

    const supabase = makeClient()
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)
    ).rejects.toThrow('already reversed')

    // No compensation path exists — and none is needed.
    expect(supabase.from).not.toHaveBeenCalledWith('journal_entry_lines')
  })

  it('surfaces a locked period as TargetPeriodLockedError', async () => {
    results = [
      { data: originalEntry, error: null },
      { data: [{ account_number: '5420' }, { account_number: '1930' }], error: null },
    ]
    rpcResult = {
      data: null,
      error: { message: 'Payment period is closed or locked.', details: '{"code":"PERIOD_LOCKED"}' },
    }

    const supabase = makeClient()
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)
    ).rejects.toMatchObject({ code: 'TARGET_PERIOD_LOCKED' })
  })

  it('surfaces an unmapped RPC failure as BookkeepingDatabaseError', async () => {
    results = [
      { data: originalEntry, error: null },
      { data: [{ account_number: '5420' }, { account_number: '1930' }], error: null },
    ]
    rpcResult = { data: null, error: { message: 'connection reset' } }

    const supabase = makeClient()
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)
    ).rejects.toThrow(BookkeepingDatabaseError)
  })

  it('rejects a corrected line on an inactive account', async () => {
    results = [
      { data: originalEntry, error: null },
      // 5420 is not in the active set — the rättelse may not use it, even
      // though the storno of an old entry still may.
      { data: [{ account_number: '1930' }], error: null },
    ]

    const supabase = makeClient()
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)
    ).rejects.toMatchObject({ code: 'ACCOUNTS_NOT_IN_CHART' })

    expect(rpcCalls).toHaveLength(0)
  })

  it('mirrors original.entry_date on storno + corrected entries (rättelsen stannar i ursprungsperioden)', async () => {
    setupResults()
    const supabase = makeClient()
    await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)

    const { reversal, correction } = plans()
    expect(reversal).toMatchObject({ source_type: 'storno', entry_date: '2024-06-15' })
    expect(correction).toMatchObject({ source_type: 'correction', entry_date: '2024-06-15' })
  })

  it('rejects rättelse where every account nets to zero (1930 → 1930)', async () => {
    const supabase = makeClient()
    const noOpLines = [
      { account_number: '1930', debit_amount: 100, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 100 },
    ]
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', noOpLines)
    ).rejects.toBeInstanceOf(MeaninglessCorrectionError)

    // Guard runs before any DB call — original must not be fetched.
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('rejects rättelse where multiple accounts each net to zero', async () => {
    const supabase = makeClient()
    const noOpLines = [
      { account_number: '1930', debit_amount: 100, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 100 },
      { account_number: '5410', debit_amount: 50, credit_amount: 0 },
      { account_number: '5410', debit_amount: 0, credit_amount: 50 },
    ]
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', noOpLines)
    ).rejects.toMatchObject({
      code: 'MEANINGLESS_CORRECTION',
      reason: 'net_zero_per_account',
    })
  })

  it('rejects rättelse identical to the original entry', async () => {
    const supabase = makeClient()
    // Only the fetch-original result is needed — guard runs right after.
    results = [{ data: originalEntry, error: null }]

    const identicalLines = [
      { account_number: '5410', debit_amount: 1000, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
    ]

    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', identicalLines)
    ).rejects.toMatchObject({
      code: 'MEANINGLESS_CORRECTION',
      reason: 'identical_to_original',
    })
  })

  it('allows rättelse that shifts amounts between different accounts', async () => {
    setupResults()
    const supabase = makeClient()
    // correctedLines moves expense from 5410 → 5420 — net effect per account
    // is non-zero (5420 +1200, 5410 0 since absent, 1930 -1200), and the lines
    // differ from the original, so both guards must pass.
    const result = await correctEntry(
      supabase as never,
      'company-1',
      'user-1',
      'orig-1',
      correctedLines
    )
    expect(result.corrected).toBeDefined()
  })

  it('accepts a source_type=correction entry as the original (chained correction, BFL 5 kap. 5 §)', async () => {
    // The user just corrected entry A → got correction C. They now want to
    // correct C. Service must not care about source_type of the original —
    // status='posted' is the only constraint.
    const correctionAsOriginal = makeJournalEntry({
      id: 'correction-1',
      status: 'posted',
      source_type: 'correction',
      correction_of_id: 'orig-A',
      description: 'Rättelse: Test purchase',
      fiscal_period_id: 'fp-1',
      voucher_series: 'A',
      lines: [
        makeJournalEntryLine({ account_number: '5420', debit_amount: 1200, credit_amount: 0 }),
        makeJournalEntryLine({ account_number: '1930', debit_amount: 0, credit_amount: 1200 }),
      ],
    })
    const secondReversal = makeJournalEntry({ id: 'reversal-2', reverses_id: 'correction-1' })
    const secondCorrection = makeJournalEntry({
      id: 'correction-2',
      correction_of_id: 'correction-1',
      source_type: 'correction',
    })

    results = [
      { data: correctionAsOriginal, error: null },                              // 0: fetch original (the prior correction)
      { data: [{ account_number: '5430' }, { account_number: '1930' }], error: null }, // 1: active accounts
      { data: { ...secondReversal, lines: [] }, error: null },                  // 2: fetch final reversal
      { data: { ...secondCorrection, lines: [] }, error: null },                // 3: fetch final corrected
    ]
    rpcResult = {
      data: { reversal_entry_id: 'reversal-2', correction_entry_id: 'correction-2' },
      error: null,
    }

    const supabase = makeClient()
    const result = await correctEntry(supabase as never, 'company-1', 'user-1', 'correction-1', [
      { account_number: '5430', debit_amount: 1500, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 1500 },
    ])

    expect(result.reversal.reverses_id).toBe('correction-1')
    expect(result.corrected.correction_of_id).toBe('correction-1')
    expect(result.corrected.source_type).toBe('correction')
  })

  it('emits journal_entry.corrected event', async () => {
    setupResults()

    const handler = vi.fn()
    eventBus.on('journal_entry.corrected', handler)

    const supabase = makeClient()
    await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)

    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', companyId: 'company-1' })
    )
  })
})

describe('correctEntry — date/period override (recordate engine)', () => {
  const originalEntry = makeJournalEntry({
    id: 'orig-1',
    status: 'posted',
    description: 'Webbhotell',
    entry_date: '2024-06-15',
    fiscal_period_id: 'fp-1',
    voucher_series: 'A',
    lines: [
      makeJournalEntryLine({ account_number: '5410', debit_amount: 1000, credit_amount: 0 }),
      makeJournalEntryLine({ account_number: '1930', debit_amount: 0, credit_amount: 1000 }),
    ],
  })

  // Same multiset as the original — allowed here because the *date* is the
  // change (a wrong-year fix keeps the lines untouched).
  const identicalLines = [
    { account_number: '5410', debit_amount: 1000, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
  ]

  it('re-books the corrected entry in the target period/date while the storno stays in the original period', async () => {
    const reversalEntry = makeJournalEntry({ id: 'reversal-1', reverses_id: 'orig-1' })
    const correctedEntry = makeJournalEntry({ id: 'corrected-1', correction_of_id: 'orig-1' })
    results = [
      { data: originalEntry, error: null },                                                          // 0 fetch original
      { data: { name: '2025', period_start: '2025-01-01', period_end: '2025-12-31' }, error: null },  // 1 target period
      { data: [{ account_number: '5410' }, { account_number: '1930' }], error: null },                // 2 active accounts
      { data: { ...reversalEntry, lines: [] }, error: null },                                        // 3 final reversal
      { data: { ...correctedEntry, lines: [] }, error: null },                                       // 4 final corrected
    ]
    rpcResult = {
      data: { reversal_entry_id: 'reversal-1', correction_entry_id: 'corrected-1' },
      error: null,
    }
    const supabase = makeClient()
    const result = await correctEntry(
      supabase as never,
      'company-1',
      'user-1',
      'orig-1',
      identicalLines,
      { newEntryDate: '2025-06-15', newFiscalPeriodId: 'fp-2' }
    )
    expect(result.corrected).toBeDefined()

    // The storno stays where the original was booked; only the rättelse moves.
    const { reversal, correction } = plans()
    expect(reversal).toMatchObject({ source_type: 'storno', fiscal_period_id: 'fp-1', entry_date: '2024-06-15' })
    expect(correction).toMatchObject({ source_type: 'correction', fiscal_period_id: 'fp-2', entry_date: '2025-06-15' })
  })

  it('rejects when the new date falls outside the target period bounds', async () => {
    results = [
      { data: originalEntry, error: null },                                                          // 0 fetch original
      { data: { name: '2025', period_start: '2025-01-01', period_end: '2025-05-31' }, error: null },  // 1 target period — 06-15 out of bounds
    ]
    const supabase = makeClient()
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', identicalLines, {
        newEntryDate: '2025-06-15',
        newFiscalPeriodId: 'fp-2',
      })
    ).rejects.toMatchObject({ code: 'ENTRY_DATE_OUTSIDE_FISCAL_PERIOD' })

    // The guard runs before the RPC — no storno is even planned.
    expect(rpcCalls).toHaveLength(0)
  })

  it('rejects when the target period cannot be found', async () => {
    results = [
      { data: originalEntry, error: null },           // 0 fetch original
      { data: null, error: { message: 'no rows' } },  // 1 target period missing
    ]
    const supabase = makeClient()
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', identicalLines, {
        newEntryDate: '2025-06-15',
        newFiscalPeriodId: 'fp-2',
      })
    ).rejects.toMatchObject({ code: 'FISCAL_PERIOD_NOT_FOUND' })
  })
})
