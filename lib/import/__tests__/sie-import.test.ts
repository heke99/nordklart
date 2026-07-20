import { describe, it, expect } from 'vitest'
import {
  generateImportPreview,
  validateIBBalance,
  isBalanceSheetAccount,
  ensureFiscalPeriod,
  buildOpeningBalancePayload,
  computeVoucherNumberRanges,
  linkOpeningBalanceEntryToPeriod,
  companyHasPriorActivity,
} from '../sie-import'
import {
  prepareStagedVouchers,
  buildNextPeriodObLines,
  type SieImportPolicy,
} from '../sie-staging'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { ParsedSIEFile, AccountMapping } from '../types'

// --- Helpers ---

function makeParsedFile(overrides?: Partial<ParsedSIEFile>): ParsedSIEFile {
  return {
    header: {
      sieType: 4,
      flagga: 0,
      program: 'TestProg',
      programVersion: '1.0',
      generatedDate: '2024-01-01',
      format: 'PC8',
      companyName: 'Test AB',
      orgNumber: '5566778899',
      address: null,
      fiscalYears: [{ yearIndex: 0, start: '2024-01-01', end: '2024-12-31' }],
      currency: 'SEK',
      kontoPlanType: null,
      ksumma: null,
    },
    accounts: [
      { number: '1510', name: 'Kundfordringar' },
      { number: '1930', name: 'Företagskonto' },
      { number: '2440', name: 'Leverantörsskulder' },
    ],
    dimensions: [],
    objects: [],
    openingBalances: [
      { yearIndex: 0, account: '1510', amount: 50000 },
      { yearIndex: 0, account: '1930', amount: 100000 },
      { yearIndex: 0, account: '2440', amount: -150000 },
    ],
    closingBalances: [],
    resultBalances: [],
    vouchers: [
      {
        series: 'A',
        number: 1,
        date: new Date(2024, 0, 15),
        description: 'Faktura 1001',
        lines: [
          { account: '1510', amount: 12500 },
          { account: '3001', amount: -10000 },
          { account: '2611', amount: -2500 },
        ],
      },
    ],
    issues: [],
    stats: {
      totalAccounts: 3,
      totalVouchers: 1,
      totalTransactionLines: 3,
      fiscalYearStart: '2024-01-01',
      fiscalYearEnd: '2024-12-31',
    },
    ...overrides,
  }
}

function makeMapping(source: string, target: string, confidence: number = 1.0): AccountMapping {
  return {
    sourceAccount: source,
    sourceName: `Account ${source}`,
    targetAccount: target,
    targetName: `Target ${target}`,
    confidence,
    matchType: target ? 'exact' : 'manual',
    isOverride: false,
  }
}

// --- Tests ---

describe('generateImportPreview', () => {
  describe('trial balance from IB', () => {
    it('calculates debit totals from positive IB amounts', () => {
      const parsed = makeParsedFile()
      const mappings = [
        makeMapping('1510', '1510'),
        makeMapping('1930', '1930'),
        makeMapping('2440', '2440'),
      ]
      const preview = generateImportPreview(parsed, mappings)

      // Positive amounts: 50000 + 100000 = 150000
      expect(preview.trialBalance.totalDebit).toBe(150000)
    })

    it('calculates credit totals from negative IB amounts', () => {
      const parsed = makeParsedFile()
      const mappings = [
        makeMapping('1510', '1510'),
        makeMapping('1930', '1930'),
        makeMapping('2440', '2440'),
      ]
      const preview = generateImportPreview(parsed, mappings)

      // Negative amounts: |-150000| = 150000
      expect(preview.trialBalance.totalCredit).toBe(150000)
    })

    it('detects balanced trial balance', () => {
      const parsed = makeParsedFile()
      const mappings = [makeMapping('1510', '1510')]
      const preview = generateImportPreview(parsed, mappings)

      // 150000 debit = 150000 credit
      expect(preview.trialBalance.isBalanced).toBe(true)
    })

    it('detects unbalanced trial balance', () => {
      const parsed = makeParsedFile({
        openingBalances: [
          { yearIndex: 0, account: '1510', amount: 50000 },
          { yearIndex: 0, account: '1930', amount: 100000 },
          // Missing credit side — only 150000 debit, 0 credit
        ],
      })
      const mappings = [makeMapping('1510', '1510')]
      const preview = generateImportPreview(parsed, mappings)

      expect(preview.trialBalance.isBalanced).toBe(false)
    })

    it('handles zero opening balances', () => {
      const parsed = makeParsedFile({ openingBalances: [] })
      const mappings: AccountMapping[] = []
      const preview = generateImportPreview(parsed, mappings)

      expect(preview.trialBalance.totalDebit).toBe(0)
      expect(preview.trialBalance.totalCredit).toBe(0)
      expect(preview.trialBalance.isBalanced).toBe(true)
    })
  })

  describe('company info passthrough', () => {
    it('passes company name', () => {
      const parsed = makeParsedFile()
      const preview = generateImportPreview(parsed, [])
      expect(preview.companyName).toBe('Test AB')
    })

    it('passes org number', () => {
      const parsed = makeParsedFile()
      const preview = generateImportPreview(parsed, [])
      expect(preview.orgNumber).toBe('5566778899')
    })

    it('handles null company info', () => {
      const parsed = makeParsedFile({
        header: {
          ...makeParsedFile().header,
          companyName: null,
          orgNumber: null,
        },
      })
      const preview = generateImportPreview(parsed, [])
      expect(preview.companyName).toBeNull()
      expect(preview.orgNumber).toBeNull()
    })
  })

  describe('mapping status', () => {
    it('reflects mapper output counts', () => {
      const parsed = makeParsedFile()
      const mappings = [
        makeMapping('1510', '1510'),     // mapped
        makeMapping('1930', '1930'),     // mapped
        makeMapping('2440', '', 0),       // unmapped
      ]
      const preview = generateImportPreview(parsed, mappings)

      expect(preview.mappingStatus.total).toBe(3)
      expect(preview.mappingStatus.mapped).toBe(2)
      expect(preview.mappingStatus.unmapped).toBe(1)
    })

    it('reports low confidence mappings', () => {
      const mappings = [
        makeMapping('1510', '1510', 1.0),
        makeMapping('3400', '3001', 0.3), // low confidence
      ]
      const parsed = makeParsedFile()
      const preview = generateImportPreview(parsed, mappings)

      expect(preview.mappingStatus.lowConfidence).toBe(1)
    })
  })

  describe('statistics', () => {
    it('passes account count', () => {
      const parsed = makeParsedFile()
      const preview = generateImportPreview(parsed, [])
      expect(preview.accountCount).toBe(3)
    })

    it('passes voucher count', () => {
      const parsed = makeParsedFile()
      const preview = generateImportPreview(parsed, [])
      expect(preview.voucherCount).toBe(1)
    })

    it('passes transaction line count', () => {
      const parsed = makeParsedFile()
      const preview = generateImportPreview(parsed, [])
      expect(preview.transactionLineCount).toBe(3)
    })
  })

  describe('issues passthrough', () => {
    it('passes parse issues to preview', () => {
      const parsed = makeParsedFile({
        issues: [
          { severity: 'warning', line: 5, message: 'Okänd tagg: #FOO — ignoreras', tag: 'FOO' },
          { severity: 'error', line: 10, message: 'Invalid voucher', tag: 'VER' },
        ],
      })
      const preview = generateImportPreview(parsed, [])

      expect(preview.issues).toHaveLength(2)
      expect(preview.issues[0].severity).toBe('warning')
      expect(preview.issues[1].severity).toBe('error')
    })
  })
})

describe('validateIBBalance', () => {
  it('returns 0 roundingAdjustment when IB is balanced', () => {
    const parsed = makeParsedFile({
      openingBalances: [
        { yearIndex: 0, account: '1510', amount: 50000 },
        { yearIndex: 0, account: '2440', amount: -50000 },
      ],
    })
    const accountMap = new Map([['1510', '1510'], ['2440', '2440']])
    const result = validateIBBalance(parsed, accountMap)

    expect(result.roundingAdjustment).toBe(0)
    expect(result.fileImbalance).toBe(0)
    expect(result.excludedAccountsTotal).toBe(0)
    expect(result.lines).toHaveLength(2)
  })

  it('returns rounding adjustment for imbalance <= 1 SEK', () => {
    const parsed = makeParsedFile({
      openingBalances: [
        { yearIndex: 0, account: '1510', amount: 50000.50 },
        { yearIndex: 0, account: '2440', amount: -50000 },
      ],
    })
    const accountMap = new Map([['1510', '1510'], ['2440', '2440']])
    const result = validateIBBalance(parsed, accountMap)

    expect(result.roundingAdjustment).toBe(0.5)
    expect(result.fileImbalance).toBe(0.5)
  })

  it('returns large adjustment for file-level imbalance (unallocated årets resultat)', () => {
    // Simulates a Fortnox export where previous year result hasn't been allocated
    // to equity — BS accounts don't balance because årets resultat is implicit
    const parsed = makeParsedFile({
      openingBalances: [
        { yearIndex: 0, account: '1510', amount: 50100 },
        { yearIndex: 0, account: '2440', amount: -50000 },
      ],
    })
    const accountMap = new Map([['1510', '1510'], ['2440', '2440']])
    const result = validateIBBalance(parsed, accountMap)

    // The adjustment is 100 SEK — caller should book to 2099, never reject
    expect(result.roundingAdjustment).toBe(100)
    expect(result.fileImbalance).toBe(100)
    expect(result.excludedAccountsTotal).toBe(0)
  })

  it('tracks excluded accounts separately from file imbalance (Fortnox system accounts)', () => {
    // Simulates Fortnox 0099 carrying IB balance — file is balanced,
    // but mapped accounts are not because 0099 is excluded from mapping
    const parsed = makeParsedFile({
      openingBalances: [
        { yearIndex: 0, account: '1510', amount: 50000 },
        { yearIndex: 0, account: '2440', amount: -150000 },
        { yearIndex: 0, account: '0099', amount: 100000 },  // System account, not mapped
      ],
    })
    const accountMap = new Map([['1510', '1510'], ['2440', '2440']])
    const result = validateIBBalance(parsed, accountMap)

    // File-level: 50000 + (-150000) + 100000 = 0, balanced
    expect(result.fileImbalance).toBe(0)
    // Mapped-level: 50000 debit, 150000 credit = -100000 diff
    expect(result.roundingAdjustment).toBe(-100000)
    // The excluded 0099 accounts for the entire difference
    expect(result.excludedAccountsTotal).toBe(100000)
    // Only 2 lines (0099 excluded)
    expect(result.lines).toHaveLength(2)
  })

  it('ignores non-current-year balances', () => {
    const parsed = makeParsedFile({
      openingBalances: [
        { yearIndex: 0, account: '1510', amount: 50000 },
        { yearIndex: 0, account: '2440', amount: -50000 },
        { yearIndex: -1, account: '1510', amount: 99999 }, // Previous year — ignored
      ],
    })
    const accountMap = new Map([['1510', '1510'], ['2440', '2440']])
    const result = validateIBBalance(parsed, accountMap)

    expect(result.roundingAdjustment).toBe(0)
    expect(result.lines).toHaveLength(2)
  })
})

describe('ensureFiscalPeriod validation', () => {
  // Mirrors the `enforce_period_start_day` DB trigger so users get an
  // actionable Swedish error instead of a raw Postgres message.
  type Supabase = Parameters<typeof ensureFiscalPeriod>[0]

  it('rejects mid-month start when an earlier period already exists', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: null, error: null }, // containing check — no match
      { data: [], error: null },   // overlapping check — none
      { data: [{ id: 'earlier' }], error: null }, // earlier period exists
    ])

    await expect(
      ensureFiscalPeriod(
        supabase as unknown as Supabase,
        'company-id',
        '2026-04-16',
        '2026-12-31',
      ),
    ).rejects.toThrow(/kronologiskt första räkenskapsår får börja mitt i månaden/)
  })

  it('rejects end date that is not the last day of the month', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: null, error: null },
      { data: [], error: null },
      { data: [], error: null }, // no earlier period
    ])

    await expect(
      ensureFiscalPeriod(
        supabase as unknown as Supabase,
        'company-id',
        '2026-01-01',
        '2026-12-30', // not the last day of December
      ),
    ).rejects.toThrow(/måste sluta på månadens sista dag/)
  })

  it('allows mid-month start for the company first fiscal period', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: null, error: null },
      { data: [], error: null },
      { data: [], error: null }, // no earlier period
      { data: { id: 'new-period-id' }, error: null }, // insert result
    ])

    const id = await ensureFiscalPeriod(
      supabase as unknown as Supabase,
      'company-id',
      '2026-04-16',
      '2026-12-31',
    )

    expect(id).toBe('new-period-id')
  })

  it('allows mid-month start when importing a retroactive earliest period', async () => {
    // Scenario: onboarding created a 2026 fiscal period, user now imports
    // an SIE for their förlängt första räkenskapsår 2017-07-28 – 2018-12-31.
    // The 2017 period is chronologically earliest, so mid-month start is
    // legal under BFL 3 kap.
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: null, error: null }, // containing check — no match
      { data: [], error: null },   // overlapping check — none (2017 vs 2026)
      { data: [], error: null },   // no earlier period than 2017-07-28
      { data: { id: 'retro-first-year-id' }, error: null }, // insert
    ])

    const id = await ensureFiscalPeriod(
      supabase as unknown as Supabase,
      'company-id',
      '2017-07-28',
      '2018-12-31',
    )

    expect(id).toBe('retro-first-year-id')
  })

  it('reuses an existing period that contains the range (no validation needed)', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'existing-period-id' }, error: null }, // containing match
    ])

    const id = await ensureFiscalPeriod(
      supabase as unknown as Supabase,
      'company-id',
      '2026-04-16',
      '2026-12-31',
    )

    expect(id).toBe('existing-period-id')
  })

  it('rejects when an existing period overlaps the range but already has posted entries', async () => {
    // Regression: previously fell through to the overlapping period silently,
    // which stamped every imported voucher with a fiscal_period_id whose
    // window did not cover the voucher's own entry_date — breaking the SIE
    // invariant and BFL 5 kap. (verifikationsnummer per räkenskapsår).
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: null, error: null }, // containing check — no match
      {
        data: [
          {
            id: 'calendar-2026',
            period_start: '2026-01-01',
            period_end: '2026-12-31',
            name: 'Räkenskapsår 2026',
            is_closed: false,
            locked_at: null,
            opening_balances_set: false,
          },
        ],
        error: null,
      },
      { data: [{ id: 'entry-1' }], error: null }, // journal_entries — has at least one
    ])

    await expect(
      ensureFiscalPeriod(
        supabase as unknown as Supabase,
        'company-id',
        '2025-03-01', // Capelix-style broken FY March–Feb
        '2026-02-28',
      ),
    ).rejects.toThrow(/Inställningar → Företag/)
  })

  it('replaces an overlapping period when it is empty (onboarding-seeded)', async () => {
    // Real-world Zerify AB case: onboarding seeded Räkenskapsår 2026 =
    // 2026-01-01 – 2026-12-31; the user has a förlängt första räkenskapsår
    // 2025-10-20 – 2026-12-31 (BFL 3 kap.) and imports an SIE for it.
    // The seeded period carries no data, so we replace it.
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: null, error: null }, // containing check — no match
      {
        data: [
          {
            id: 'seeded-2026',
            period_start: '2026-01-01',
            period_end: '2026-12-31',
            name: 'Räkenskapsår 2026',
            is_closed: false,
            locked_at: null,
            opening_balances_set: false,
          },
        ],
        error: null,
      },
      { data: [], error: null }, // journal_entries — none
      { data: [], error: null }, // earlier-period check — none (mid-month start)
      { data: null, error: null }, // delete result
      { data: { id: 'replaced-id' }, error: null }, // insert result
    ])

    const id = await ensureFiscalPeriod(
      supabase as unknown as Supabase,
      'company-id',
      '2025-10-20',
      '2026-12-31',
    )

    expect(id).toBe('replaced-id')
  })

  it('refuses to replace an overlapping period whose opening balances are already set', async () => {
    // opening_balances_set: true short-circuits the replaceability gate before
    // we even look at journal_entries — the period clearly carries user data.
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: null, error: null },
      {
        data: [
          {
            id: 'with-ib-2026',
            period_start: '2026-01-01',
            period_end: '2026-12-31',
            name: 'Räkenskapsår 2026',
            is_closed: false,
            locked_at: null,
            opening_balances_set: true,
          },
        ],
        error: null,
      },
    ])

    await expect(
      ensureFiscalPeriod(
        supabase as unknown as Supabase,
        'company-id',
        '2025-10-20',
        '2026-12-31',
      ),
    ).rejects.toThrow(/Inställningar → Företag/)
  })

  it('refuses to replace an overlapping period that is locked', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: null, error: null },
      {
        data: [
          {
            id: 'locked-2026',
            period_start: '2026-01-01',
            period_end: '2026-12-31',
            name: 'Räkenskapsår 2026',
            is_closed: false,
            locked_at: '2026-03-15T10:00:00Z',
            opening_balances_set: false,
          },
        ],
        error: null,
      },
    ])

    await expect(
      ensureFiscalPeriod(
        supabase as unknown as Supabase,
        'company-id',
        '2025-10-20',
        '2026-12-31',
      ),
    ).rejects.toThrow(/överlappar men matchar inte/)
  })
})

describe('linkOpeningBalanceEntryToPeriod', () => {
  // Regression: SIE import created the opening-balance entry but never wrote
  // its ID back to fiscal_periods. Without the link, getOpeningBalances falls
  // through to summing all prior journal lines, which inflates balance-sheet
  // accounts across multi-year imports (each year's IB double-counted against
  // the prior year's UB).
  type Supabase = Parameters<typeof linkOpeningBalanceEntryToPeriod>[0]

  it('writes opening_balance_entry_id and opening_balances_set to the fiscal period', async () => {
    const updates: Array<{ payload: Record<string, unknown>; filters: Record<string, unknown> }> = []

    const supabase = {
      from: (table: string) => {
        if (table !== 'fiscal_periods') {
          throw new Error(`Unexpected table: ${table}`)
        }
        let pendingPayload: Record<string, unknown> = {}
        const filters: Record<string, unknown> = {}
        const chain = {
          update: (payload: Record<string, unknown>) => {
            pendingPayload = payload
            return chain
          },
          eq: (col: string, val: unknown) => {
            filters[col] = val
            return chain
          },
          then: (resolve: (v: unknown) => void) => {
            updates.push({ payload: pendingPayload, filters: { ...filters } })
            resolve({ data: null, error: null })
          },
        }
        return chain
      },
    }

    await linkOpeningBalanceEntryToPeriod(
      supabase as unknown as Supabase,
      'company-1',
      'period-1',
      'ob-entry-1',
    )

    expect(updates).toHaveLength(1)
    expect(updates[0].payload).toEqual({
      opening_balance_entry_id: 'ob-entry-1',
      opening_balances_set: true,
    })
    expect(updates[0].filters).toEqual({
      id: 'period-1',
      company_id: 'company-1',
    })
  })

  it('throws a descriptive error when the update fails', async () => {
    const supabase = {
      from: () => {
        const chain = {
          update: () => chain,
          eq: () => chain,
          then: (resolve: (v: unknown) => void) =>
            resolve({ data: null, error: { message: 'permission denied' } }),
        }
        return chain
      },
    }

    await expect(
      linkOpeningBalanceEntryToPeriod(
        supabase as unknown as Supabase,
        'company-1',
        'period-1',
        'ob-entry-1',
      ),
    ).rejects.toThrow(/Failed to link opening balance entry.*permission denied/)
  })
})

describe('companyHasPriorActivity', () => {
  // Guards multi-year SIE imports: when the company already has posted
  // non-IB journal entries, creating another IB entry would double-count
  // one year's movements against every balance-sheet account.
  type Supabase = Parameters<typeof companyHasPriorActivity>[0]

  function buildCountingSupabase(count: number) {
    const capturedFilters: Record<string, unknown> = {}

    const supabase = {
      from: (table: string) => {
        if (table !== 'journal_entries') {
          throw new Error(`Unexpected table: ${table}`)
        }
        const chain = {
          select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
            capturedFilters['_opts'] = opts
            return chain
          },
          eq: (col: string, val: unknown) => {
            capturedFilters[`eq:${col}`] = val
            return chain
          },
          neq: (col: string, val: unknown) => {
            const key = `neq:${col}`
            const existing = capturedFilters[key]
            if (Array.isArray(existing)) {
              existing.push(val)
            } else if (existing !== undefined) {
              capturedFilters[key] = [existing, val]
            } else {
              capturedFilters[key] = val
            }
            return chain
          },
          in: (col: string, val: unknown) => {
            capturedFilters[`in:${col}`] = val
            return chain
          },
          then: (resolve: (v: { count: number; error: null }) => void) =>
            resolve({ count, error: null }),
        }
        return chain
      },
    }
    return { supabase, capturedFilters }
  }

  it('returns false when the company has no prior posted entries', async () => {
    const { supabase } = buildCountingSupabase(0)

    const result = await companyHasPriorActivity(supabase as unknown as Supabase, 'company-1')

    expect(result).toBe(false)
  })

  it('returns true when the company has prior posted non-IB entries', async () => {
    const { supabase } = buildCountingSupabase(42)

    const result = await companyHasPriorActivity(supabase as unknown as Supabase, 'company-1')

    expect(result).toBe(true)
  })

  it('excludes opening_balance and storno entries, and only counts posted', async () => {
    const { supabase, capturedFilters } = buildCountingSupabase(0)

    await companyHasPriorActivity(supabase as unknown as Supabase, 'company-1')

    expect(capturedFilters['neq:source_type']).toEqual(['opening_balance', 'storno'])
    expect(capturedFilters['eq:status']).toBe('posted')
    expect(capturedFilters['eq:company_id']).toBe('company-1')
  })

  it('treats null/undefined count as zero', async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            neq: () => ({
              neq: () => ({
                eq: () => ({
                  then: (resolve: (v: { count: null; error: null }) => void) =>
                    resolve({ count: null, error: null }),
                }),
              }),
            }),
          }),
        }),
      }),
    }

    const result = await companyHasPriorActivity(supabase as unknown as Supabase, 'company-1')

    expect(result).toBe(false)
  })
})

describe('isBalanceSheetAccount', () => {
  it('returns true for class 1 (assets)', () => {
    expect(isBalanceSheetAccount('1510')).toBe(true)
    expect(isBalanceSheetAccount('1930')).toBe(true)
  })

  it('returns true for class 2 (liabilities/equity)', () => {
    expect(isBalanceSheetAccount('2099')).toBe(true)
    expect(isBalanceSheetAccount('2440')).toBe(true)
  })

  it('returns false for class 3 (revenue)', () => {
    expect(isBalanceSheetAccount('3001')).toBe(false)
    expect(isBalanceSheetAccount('3740')).toBe(false)
  })

  it('returns false for class 4-8 (expenses)', () => {
    expect(isBalanceSheetAccount('4010')).toBe(false)
    expect(isBalanceSheetAccount('5010')).toBe(false)
    expect(isBalanceSheetAccount('6211')).toBe(false)
    expect(isBalanceSheetAccount('7210')).toBe(false)
    expect(isBalanceSheetAccount('8999')).toBe(false)
  })
})

describe('computeVoucherNumberRanges', () => {
  it('returns empty array for no mapping', () => {
    expect(computeVoucherNumberRanges([])).toEqual([])
  })

  it('produces one range per series with correct from/to', () => {
    const ranges = computeVoucherNumberRanges([
      { sourceId: 'B1', series: 'B', targetNumber: 1 },
      { sourceId: 'B2', series: 'B', targetNumber: 2 },
      { sourceId: 'B3', series: 'B', targetNumber: 3 },
      { sourceId: 'C1', series: 'C', targetNumber: 1 },
      { sourceId: 'C2', series: 'C', targetNumber: 2 },
      { sourceId: 'V1', series: 'V', targetNumber: 1 },
    ])

    expect(ranges).toEqual([
      { series: 'B', from: 1, to: 3 },
      { series: 'C', from: 1, to: 2 },
      { series: 'V', from: 1, to: 1 },
    ])
  })

  it('handles non-contiguous target numbers per series', () => {
    const ranges = computeVoucherNumberRanges([
      { sourceId: 'B1', series: 'B', targetNumber: 5 },
      { sourceId: 'B2', series: 'B', targetNumber: 9 },
    ])
    expect(ranges).toEqual([{ series: 'B', from: 5, to: 9 }])
  })
})

describe('prepareStagedVouchers — per-voucher series preservation', () => {
  // Voucher posting now happens inside the finalize_sie_import RPC (atomic,
  // per-series sequential numbering — I01–I03). What the unit tests assert
  // is the staged payload contract produced by the pure
  // prepareStagedVouchers(): series routing, source traceability and the
  // strict tolerance policy (audit I15).
  const strictPolicy: SieImportPolicy = {
    approveOreRounding: false,
    approveSkippedVouchers: false,
  }

  function makeVoucher(
    series: string,
    number: number,
    lines: Array<{ account: string; amount: number }> = [
      { account: '1510', amount: 1000 },
      { account: '3001', amount: -1000 },
    ],
  ) {
    return {
      series,
      number,
      date: new Date(2024, 0, 15),
      description: `Voucher ${series}${number}`,
      lines,
    }
  }

  const baseMap = new Map([
    ['1510', '1510'],
    ['3001', '3001'],
  ])

  it('routes each voucher to its source series (B, C, V → B, C, V)', () => {
    const parsed = makeParsedFile({
      vouchers: [
        makeVoucher('B', 1),
        makeVoucher('B', 2),
        makeVoucher('C', 1),
        makeVoucher('V', 1),
      ],
    })

    // fallback 'B' should not be used here — all vouchers carry a series
    const result = prepareStagedVouchers(parsed, baseMap, 'B', strictPolicy)

    expect(result.blockingErrors).toEqual([])
    expect(result.staged).toHaveLength(4)
    expect(new Set(result.seriesUsed)).toEqual(new Set(['B', 'C', 'V']))
    expect(result.staged.map((s) => s.voucher_series)).toEqual(['B', 'B', 'C', 'V'])
  })

  it('falls back to defaultSeries when source voucher has empty series (SIE4I)', () => {
    const parsed = makeParsedFile({
      vouchers: [
        { ...makeVoucher('', 1) },
        { ...makeVoucher('', 2) },
      ],
    })

    // fallback used because source series is empty
    const result = prepareStagedVouchers(parsed, baseMap, 'V', strictPolicy)

    expect(result.staged).toHaveLength(2)
    expect(result.seriesUsed).toEqual(['V'])
    expect(result.staged.every((s) => s.voucher_series === 'V')).toBe(true)
  })

  it('builds the idempotency key external_reference as `series:number:date`', () => {
    // finalize_sie_import skips already-posted external references on retry
    // (I05), so the key must be stable and unique per source voucher.
    // Series-less vouchers key on the default series.
    const parsed = makeParsedFile({
      vouchers: [makeVoucher('B', 7), { ...makeVoucher('', 3) }],
    })

    const result = prepareStagedVouchers(parsed, baseMap, 'V', strictPolicy)

    expect(result.staged.map((s) => s.external_reference)).toEqual([
      'B:7:2024-01-15',
      'V:3:2024-01-15',
    ])
  })

  it('records source series/number on each staged payload for the audit trail', () => {
    // The voucherNumberMapping documentation is now built from the posted
    // entries after finalize — the staged payload must therefore carry the
    // source identity that the RPC persists on each journal entry.
    const parsed = makeParsedFile({
      vouchers: [
        makeVoucher('B', 1),
        makeVoucher('C', 7),
      ],
    })

    const result = prepareStagedVouchers(parsed, baseMap, 'B', strictPolicy)

    expect(
      result.staged.map((s) => ({
        series: s.source_voucher_series,
        number: s.source_voucher_number,
      })),
    ).toEqual([
      { series: 'B', number: 1 },
      { series: 'C', number: 7 },
    ])
  })

  it('converts signed SIE amounts to debit/credit lines and dates the entry from the voucher', () => {
    const parsed = makeParsedFile({
      vouchers: [makeVoucher('A', 1)],
    })

    const result = prepareStagedVouchers(parsed, baseMap, 'A', strictPolicy)

    expect(result.staged[0].entry_date).toBe('2024-01-15')
    expect(result.staged[0].description).toBe('Voucher A1')
    expect(result.staged[0].lines).toEqual([
      {
        account_number: '1510',
        debit_amount: 1000,
        credit_amount: 0,
        line_description: null,
        cost_center: null,
        project: null,
        dimensions: null,
      },
      {
        account_number: '3001',
        debit_amount: 0,
        credit_amount: 1000,
        line_description: null,
        cost_center: null,
        project: null,
        dimensions: null,
      },
    ])
  })

  it('preserves original source series/number on staged payloads, even across skipped vouchers', () => {
    // A2 is an empty voucher (no lines) — will be skipped. A1 and A3 survive.
    // The finalize RPC assigns contiguous target numbers, but source_voucher_number
    // must preserve the SIE originals (1 and 3) so traceability is not lost.
    const parsed = makeParsedFile({
      vouchers: [
        makeVoucher('A', 1),
        { ...makeVoucher('A', 2), lines: [] },
        makeVoucher('A', 3),
      ],
    })

    const result = prepareStagedVouchers(parsed, baseMap, 'A', strictPolicy)

    expect(result.blockingErrors).toEqual([])
    expect(result.staged).toHaveLength(2)
    expect(result.skippedEmpty).toBe(1)
    expect(result.skippedDetails).toEqual([
      expect.objectContaining({ voucherId: 'A2', reason: 'zero_lines' }),
    ])
    expect(result.staged.map((s) => s.source_voucher_series)).toEqual(['A', 'A'])
    expect(result.staged.map((s) => s.source_voucher_number)).toEqual([1, 3])
  })

  it('stores NULL source series when the source voucher has no series (SIE4I subsystem import)', () => {
    const parsed = makeParsedFile({
      vouchers: [
        { ...makeVoucher('', 1) },
      ],
    })

    const result = prepareStagedVouchers(parsed, baseMap, 'V', strictPolicy)

    expect(result.staged[0].source_voucher_series).toBeNull()
    expect(result.staged[0].source_voucher_number).toBe(1)
  })

  it('tracks net movements per target account for the vouchers that will be posted', () => {
    // Feeds the migration-adjustment reconciliation (I16) for skipped vouchers.
    const parsed = makeParsedFile({
      vouchers: [makeVoucher('A', 1), makeVoucher('A', 2)],
    })

    const result = prepareStagedVouchers(parsed, baseMap, 'A', strictPolicy)

    expect(result.movementsByAccount.get('1510')).toBe(2000)
    expect(result.movementsByAccount.get('3001')).toBe(-2000)
  })

  describe('strict tolerance policy (audit I15)', () => {
    it('blocks the import when a voucher has unmapped accounts', () => {
      // Silently skipping financial vouchers would corrupt the migrated year —
      // unmapped accounts are always blocking, never a warning.
      const parsed = makeParsedFile({
        vouchers: [
          makeVoucher('A', 1, [
            { account: '1510', amount: 1000 },
            { account: '9999', amount: -1000 }, // not in accountMap
          ]),
        ],
      })

      const result = prepareStagedVouchers(parsed, baseMap, 'A', strictPolicy)

      expect(result.staged).toEqual([])
      expect(result.skippedUnmapped).toBe(1)
      expect(result.blockingErrors.join(' ')).toMatch(/konton utan mappning: 9999/)
    })

    it('skips empty vouchers without blocking (no financial content)', () => {
      const parsed = makeParsedFile({
        vouchers: [{ ...makeVoucher('A', 1), lines: [] }, makeVoucher('A', 2)],
      })

      const result = prepareStagedVouchers(parsed, baseMap, 'A', strictPolicy)

      expect(result.blockingErrors).toEqual([])
      expect(result.skippedEmpty).toBe(1)
      expect(result.staged).toHaveLength(1)
    })

    it('blocks single-line vouchers without approveSkippedVouchers', () => {
      const parsed = makeParsedFile({
        vouchers: [makeVoucher('A', 1, [{ account: '1510', amount: 500 }])],
      })

      const result = prepareStagedVouchers(parsed, baseMap, 'A', strictPolicy)

      expect(result.staged).toEqual([])
      expect(result.skippedSingleLine).toBe(1)
      expect(result.blockingErrors.join(' ')).toMatch(/endast en bokföringsrad/)
    })

    it('skips single-line vouchers with a warning when approveSkippedVouchers is set', () => {
      const parsed = makeParsedFile({
        vouchers: [makeVoucher('A', 1, [{ account: '1510', amount: 500 }])],
      })

      const result = prepareStagedVouchers(parsed, baseMap, 'A', {
        approveOreRounding: false,
        approveSkippedVouchers: true,
      })

      expect(result.blockingErrors).toEqual([])
      expect(result.staged).toEqual([])
      expect(result.skippedSingleLine).toBe(1)
      expect(result.warnings.join(' ')).toMatch(/hoppades över efter uttryckligt godkännande/)
    })

    it('auto-adjusts a 0.01 SEK diff with an öresutjämning line on 3741 (no approval needed)', () => {
      // 1 öre är den dokumenterade automatiska toleransen — ingen varning,
      // ingen attest, men differensen bokförs alltid explicit på 3741.
      const parsed = makeParsedFile({
        vouchers: [
          makeVoucher('A', 1, [
            { account: '1510', amount: 100.01 },
            { account: '3001', amount: -100.0 },
          ]),
        ],
      })

      const result = prepareStagedVouchers(parsed, baseMap, 'A', strictPolicy)

      expect(result.blockingErrors).toEqual([])
      expect(result.warnings).toEqual([])
      expect(result.staged).toHaveLength(1)
      // Debet 100.01 > kredit 100.00 → 3741 balanserar på kreditsidan.
      const adjustment = result.staged[0].lines.find((l) => l.account_number === '3741')
      expect(adjustment).toEqual({
        account_number: '3741',
        debit_amount: 0,
        credit_amount: 0.01,
        line_description: 'Öresutjämning',
        cost_center: null,
        project: null,
        dimensions: null,
      })
    })

    it('blocks a 0.02 SEK diff without approveOreRounding', () => {
      const parsed = makeParsedFile({
        vouchers: [
          makeVoucher('A', 1, [
            { account: '1510', amount: 100.02 },
            { account: '3001', amount: -100.0 },
          ]),
        ],
      })

      const result = prepareStagedVouchers(parsed, baseMap, 'A', strictPolicy)

      expect(result.staged).toEqual([])
      expect(result.skippedUnbalanced).toBe(1)
      expect(result.blockingErrors.join(' ')).toMatch(/godkänn öresutjämning uttryckligen/i)
    })

    it('adjusts a 0.02 SEK diff to 3741 with a warning when approveOreRounding is set', () => {
      const parsed = makeParsedFile({
        vouchers: [
          makeVoucher('A', 1, [
            { account: '1510', amount: 100.02 },
            { account: '3001', amount: -100.0 },
          ]),
        ],
      })

      const result = prepareStagedVouchers(parsed, baseMap, 'A', {
        approveOreRounding: true,
        approveSkippedVouchers: false,
      })

      expect(result.blockingErrors).toEqual([])
      expect(result.staged).toHaveLength(1)
      const adjustment = result.staged[0].lines.find((l) => l.account_number === '3741')
      expect(adjustment?.credit_amount).toBe(0.02)
      expect(result.warnings.join(' ')).toMatch(
        /öresutjämning 0\.02 kr bokförd på konto 3741 efter uttryckligt godkännande/,
      )
    })

    it('treats exactly 1.00 SEK as öresutjämning territory — requires approveOreRounding', () => {
      // 1.00 SEK is the documented approval cap: still approvable as
      // öresutjämning, never auto-adjusted.
      const linesWithOneKronaDiff = [
        { account: '1510', amount: 101.0 },
        { account: '3001', amount: -100.0 },
      ]

      const blocked = prepareStagedVouchers(
        makeParsedFile({ vouchers: [makeVoucher('A', 1, linesWithOneKronaDiff)] }),
        baseMap,
        'A',
        strictPolicy,
      )
      expect(blocked.staged).toEqual([])
      expect(blocked.skippedUnbalanced).toBe(1)
      expect(blocked.blockingErrors.join(' ')).toMatch(/godkänn öresutjämning uttryckligen/i)

      const approved = prepareStagedVouchers(
        makeParsedFile({ vouchers: [makeVoucher('A', 1, linesWithOneKronaDiff)] }),
        baseMap,
        'A',
        { approveOreRounding: true, approveSkippedVouchers: false },
      )
      expect(approved.blockingErrors).toEqual([])
      const adjustment = approved.staged[0].lines.find((l) => l.account_number === '3741')
      expect(adjustment?.credit_amount).toBe(1)
    })

    it('blocks a 1.50 SEK diff even with approveOreRounding — needs approveSkippedVouchers', () => {
      // > 1 SEK is never öresavrundning — the voucher is incomplete in the
      // source system. approveOreRounding must NOT rescue it.
      const linesWithBigDiff = [
        { account: '1510', amount: 101.5 },
        { account: '3001', amount: -100.0 },
      ]

      const blocked = prepareStagedVouchers(
        makeParsedFile({ vouchers: [makeVoucher('A', 1, linesWithBigDiff)] }),
        baseMap,
        'A',
        { approveOreRounding: true, approveSkippedVouchers: false },
      )
      expect(blocked.staged).toEqual([])
      expect(blocked.skippedUnbalanced).toBe(1)
      expect(blocked.blockingErrors.join(' ')).toMatch(/obalanserad/)

      // approveSkippedVouchers skips it with a warning — never posts it.
      const skipped = prepareStagedVouchers(
        makeParsedFile({ vouchers: [makeVoucher('A', 1, linesWithBigDiff)] }),
        baseMap,
        'A',
        { approveOreRounding: false, approveSkippedVouchers: true },
      )
      expect(skipped.blockingErrors).toEqual([])
      expect(skipped.staged).toEqual([])
      expect(skipped.skippedUnbalanced).toBe(1)
      expect(skipped.warnings.join(' ')).toMatch(/obalanserad med 1\.5 kr och hoppades över/)
    })
  })

  describe('opening-balance voucher tagging vs derived IB (issue #675)', () => {
    const obMap = new Map([
      ['1930', '1930'],
      ['2010', '2010'],
    ])

    it('tags a qualifying OB voucher opening_balance even when #UB -1 records exist', () => {
      // Precedence 2 beats 3: the OB-voucher candidate makes
      // getEffectiveOpeningBalances yield no balances, so hasCurrentYearIb is
      // false and the voucher keeps serving as the IB. Without that yield, a
      // derived IB entry AND this voucher would both book the same amounts.
      const parsed = makeParsedFile({
        openingBalances: [],
        closingBalances: [
          { yearIndex: -1, account: '1930', amount: 37400.78 },
          { yearIndex: -1, account: '2010', amount: -37400.78 },
        ],
        vouchers: [
          {
            series: 'A',
            number: 1,
            date: new Date(2024, 0, 1),
            description: 'Ingående balans',
            lines: [
              { account: '1930', amount: 37400.78 },
              { account: '2010', amount: -37400.78 },
            ],
          },
        ],
      })

      const result = prepareStagedVouchers(parsed, obMap, 'A', strictPolicy)

      expect(result.staged).toHaveLength(1)
      expect(result.staged[0].source_type).toBe('opening_balance')
    })

    it('keeps an FY-start voucher without IB wording as import when IB is derived from #UB -1', () => {
      const parsed = makeParsedFile({
        openingBalances: [],
        closingBalances: [
          { yearIndex: -1, account: '1930', amount: 37400.78 },
          { yearIndex: -1, account: '2010', amount: -37400.78 },
        ],
        vouchers: [
          {
            series: 'A',
            number: 1,
            date: new Date(2024, 0, 1),
            description: 'Omföring',
            lines: [
              { account: '1930', amount: 1000 },
              { account: '2010', amount: -1000 },
            ],
          },
        ],
      })

      const result = prepareStagedVouchers(parsed, obMap, 'A', strictPolicy)

      expect(result.staged[0].source_type).toBe('import')
    })
  })
})

describe('IB derivation from #UB -1 (issue #675)', () => {
  const derivedOverrides: Partial<ParsedSIEFile> = {
    openingBalances: [],
    closingBalances: [
      { yearIndex: -1, account: '1930', amount: 37400.78 },
      { yearIndex: -1, account: '2440', amount: -37400.78 },
      { yearIndex: 0, account: '1930', amount: 160406.0 },
      { yearIndex: 0, account: '2440', amount: -160406.0 },
    ],
  }

  describe('generateImportPreview', () => {
    it('computes opening balance totals from the derived set', () => {
      const parsed = makeParsedFile(derivedOverrides)
      const preview = generateImportPreview(parsed, [
        makeMapping('1930', '1930'),
        makeMapping('2440', '2440'),
      ])

      // Derived from #UB -1: 37400.78 debit / 37400.78 credit. This is also
      // what enables the IB toggle in ImportReviewStep (openingBalanceTotal > 0).
      expect(preview.openingBalanceTotal).toBe(37400.78)
      expect(preview.trialBalance.totalDebit).toBe(37400.78)
      expect(preview.trialBalance.totalCredit).toBe(37400.78)
      expect(preview.trialBalance.isBalanced).toBe(true)
    })

    it('appends an info issue explaining the derivation without mutating parsed.issues', () => {
      const parsed = makeParsedFile(derivedOverrides)
      const preview = generateImportPreview(parsed, [makeMapping('1930', '1930')])

      const infoMessages = preview.issues.filter((i) => i.severity === 'info')
      expect(infoMessages.map((i) => i.message).join(' ')).toMatch(/härleds från föregående års utgående balans/i)
      expect(parsed.issues).toHaveLength(0)
    })

    it('does not append the derivation issue when explicit #IB 0 exists', () => {
      const parsed = makeParsedFile()
      const preview = generateImportPreview(parsed, [makeMapping('1930', '1930')])

      expect(preview.issues).toHaveLength(0)
    })
  })

  describe('validateIBBalance', () => {
    it('builds journal lines from the derived #UB -1 set', () => {
      const parsed = makeParsedFile(derivedOverrides)
      const accountMap = new Map([
        ['1930', '1930'],
        ['2440', '2440'],
      ])

      const result = validateIBBalance(parsed, accountMap)

      expect(result.lines).toEqual([
        { account_number: '1930', debit_amount: 37400.78, credit_amount: 0, line_description: 'IB 1930' },
        { account_number: '2440', debit_amount: 0, credit_amount: 37400.78, line_description: 'IB 2440' },
      ])
      expect(result.roundingAdjustment).toBe(0)
      expect(result.fileImbalance).toBe(0)
    })

    it('reports the imbalance when the derived set carries an unallocated prior-year result', () => {
      const parsed = makeParsedFile({
        openingBalances: [],
        closingBalances: [
          { yearIndex: -1, account: '1930', amount: 37400.78 },
          { yearIndex: -1, account: '2440', amount: -30000.0 },
        ],
      })
      const accountMap = new Map([
        ['1930', '1930'],
        ['2440', '2440'],
      ])

      const result = validateIBBalance(parsed, accountMap)

      // 37400.78 − 30000.00 → diff booked to 2099 by buildOpeningBalancePayload
      expect(result.roundingAdjustment).toBe(7400.78)
      expect(result.fileImbalance).toBe(7400.78)
    })
  })
})

describe('buildOpeningBalancePayload', () => {
  // Replaces createOpeningBalanceEntry: the payload is now built as pure data
  // and posted inside finalize_sie_import's atomic transaction.
  it('builds debit/credit lines from #IB 0 dated at fiscal year start', () => {
    const parsed = makeParsedFile()
    const accountMap = new Map([
      ['1510', '1510'],
      ['1930', '1930'],
      ['2440', '2440'],
    ])

    const payload = buildOpeningBalancePayload(parsed, accountMap, 0)

    expect(payload).not.toBeNull()
    expect(payload!.entry_date).toBe('2024-01-01')
    expect(payload!.description).toBe('Ingående balanser från SIE-import')
    expect(payload!.lines).toEqual([
      { account_number: '1510', debit_amount: 50000, credit_amount: 0, line_description: 'IB 1510' },
      { account_number: '1930', debit_amount: 100000, credit_amount: 0, line_description: 'IB 1930' },
      { account_number: '2440', debit_amount: 0, credit_amount: 150000, line_description: 'IB 2440' },
    ])
  })

  it('books a validated imbalance explicitly to 2099, never silently', () => {
    // 100 SEK unallocated årets resultat — validateIBBalance computed the
    // adjustment; the payload must document it on a dedicated 2099 line.
    const parsed = makeParsedFile({
      openingBalances: [
        { yearIndex: 0, account: '1510', amount: 50100 },
        { yearIndex: 0, account: '2440', amount: -50000 },
      ],
    })
    const accountMap = new Map([
      ['1510', '1510'],
      ['2440', '2440'],
    ])

    const payload = buildOpeningBalancePayload(parsed, accountMap, 100)

    expect(payload!.lines).toContainEqual({
      account_number: '2099',
      debit_amount: 0,
      credit_amount: 100,
      line_description: 'Avrundningsdifferens vid SIE-import, 100 SEK',
    })
    // The entry balances after the adjustment
    const totalDebit = payload!.lines.reduce((s, l) => s + l.debit_amount, 0)
    const totalCredit = payload!.lines.reduce((s, l) => s + l.credit_amount, 0)
    expect(totalDebit).toBe(totalCredit)
  })

  it('documents the #UB -1 derivation in the voucher description (issue #675)', () => {
    const parsed = makeParsedFile({
      openingBalances: [],
      closingBalances: [
        { yearIndex: -1, account: '1930', amount: 37400.78 },
        { yearIndex: -1, account: '2440', amount: -37400.78 },
      ],
    })
    const accountMap = new Map([
      ['1930', '1930'],
      ['2440', '2440'],
    ])

    const payload = buildOpeningBalancePayload(parsed, accountMap, 0)

    expect(payload!.description).toBe(
      'Ingående balanser från SIE-import (härledda från föregående års utgående balans)'
    )
    expect(payload!.lines).toEqual([
      { account_number: '1930', debit_amount: 37400.78, credit_amount: 0, line_description: 'IB 1930' },
      { account_number: '2440', debit_amount: 0, credit_amount: 37400.78, line_description: 'IB 2440' },
    ])
  })

  it('returns null when the file carries no effective opening balances', () => {
    const parsed = makeParsedFile({ openingBalances: [], closingBalances: [] })

    expect(buildOpeningBalancePayload(parsed, new Map([['1930', '1930']]), 0)).toBeNull()
  })

  it('returns null when no IB account is mapped (all lines excluded)', () => {
    const parsed = makeParsedFile()

    expect(buildOpeningBalancePayload(parsed, new Map(), 0)).toBeNull()
  })
})

describe('buildNextPeriodObLines', () => {
  // Replaces resyncNextPeriodOpeningBalance: the N→N+1 IB resync now happens
  // inside the finalize_sie_import RPC (I12), fed by these pure lines built
  // from the imported year's #UB (yearIndex 0).
  it('builds next-period IB lines from the current-year #UB', () => {
    const parsed = makeParsedFile({
      closingBalances: [
        { yearIndex: -1, account: '1930', amount: 99999 }, // prior year — ignored
        { yearIndex: 0, account: '1930', amount: 160406.0 },
        { yearIndex: 0, account: '2440', amount: -160406.0 },
      ],
    })
    const accountMap = new Map([
      ['1930', '1930'],
      ['2440', '2440'],
    ])

    const lines = buildNextPeriodObLines(parsed, accountMap)

    expect(lines).toEqual([
      {
        account_number: '1930',
        debit_amount: 160406.0,
        credit_amount: 0,
        line_description: 'IB 1930 (från föregående års UB)',
      },
      {
        account_number: '2440',
        debit_amount: 0,
        credit_amount: 160406.0,
        line_description: 'IB 2440 (från föregående års UB)',
      },
    ])
  })

  it('returns null when the file has no current-year #UB', () => {
    const parsed = makeParsedFile({
      closingBalances: [{ yearIndex: -1, account: '1930', amount: 37400.78 }],
    })

    expect(buildNextPeriodObLines(parsed, new Map([['1930', '1930']]))).toBeNull()
  })

  it('books an unbalanced UB set explicitly to 2099', () => {
    const parsed = makeParsedFile({
      closingBalances: [
        { yearIndex: 0, account: '1930', amount: 100 },
        { yearIndex: 0, account: '2440', amount: -50 },
      ],
    })
    const accountMap = new Map([
      ['1930', '1930'],
      ['2440', '2440'],
    ])

    const lines = buildNextPeriodObLines(parsed, accountMap)

    expect(lines).toContainEqual({
      account_number: '2099',
      debit_amount: 0,
      credit_amount: 50,
      line_description: 'Avrundningsdifferens vid IB-synk från SIE-import',
    })
  })

  it('falls back to the source account number when a #UB account is unmapped', () => {
    // Continuity beats mapping strictness here: the RPC validates the final
    // entry, and dropping the line would silently unbalance next year's IB.
    const parsed = makeParsedFile({
      closingBalances: [
        { yearIndex: 0, account: '1930', amount: 100 },
        { yearIndex: 0, account: '2440', amount: -100 },
      ],
    })

    const lines = buildNextPeriodObLines(parsed, new Map([['1930', '1932']]))

    expect(lines!.map((l) => l.account_number)).toEqual(['1932', '2440'])
  })
})
