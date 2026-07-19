/**
 * Full-flow regression suite for issue #675.
 *
 * Some systems export SIE files without current-year #IB 0 records — the
 * opening balances exist only implicitly via the SIE continuity invariant
 * IB(year 0) = UB(year -1). executeSIEImport must derive the IB from the
 * file's #UB -1 records, build an opening-balance payload whose voucher
 * text documents the derivation, hand it to the atomic finalize_sie_import
 * RPC (which posts it inside ONE transaction), and warn the user.
 *
 * The make-or-break line is the gate in executeSIEImport: it must open on
 * the EFFECTIVE opening balances (getEffectiveOpeningBalances), not on raw
 * parsed.openingBalances — the raw set is empty for these files.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeSIEImport } from '../sie-import'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import type { ParsedSIEFile, AccountMapping } from '../types'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn(async () => ({ id: 'adjustment-entry-1' })),
  reverseEntry: vi.fn(),
}))

// --- Helpers ---

type QueuedResult = { data?: unknown; error?: unknown; count?: number | null }

type RpcCall = { fn: string; args: Record<string, unknown> }

/**
 * Table-routing supabase mock: each table has its own FIFO of results
 * (consumed per .from(table) call), falling back to { data: null, error:
 * null } when the queue is empty. Order-independent across tables, so the
 * mock doesn't break when an unrelated query is added elsewhere in the flow.
 *
 * RPCs are captured for assertions. finalize_sie_import mirrors the real
 * contract: it posts atomically and reports the opening-balance entry id
 * only when the caller actually supplied an opening_balance payload.
 */
function buildRoutingSupabase(tableQueues: Record<string, QueuedResult[]>) {
  const queues = new Map<string, QueuedResult[]>(
    Object.entries(tableQueues).map(([k, v]) => [k, [...v]])
  )

  const makeChain = (result: { data: unknown; error: unknown; count: number | null }): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve(result)
        }
        return (..._args: unknown[]) => makeChain(result)
      },
    }
    return new Proxy({}, handler)
  }

  const rpcCalls: RpcCall[] = []

  const supabase = {
    from: (table: string) => {
      const next = queues.get(table)?.shift() ?? {}
      return makeChain({
        data: next.data ?? null,
        error: next.error ?? null,
        count: next.count ?? null,
      })
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args })
      if (fn === 'finalize_sie_import') {
        const options = (args?.p_options ?? {}) as Record<string, unknown>
        return {
          data: {
            posted: 0,
            skipped_duplicates: 0,
            deleted_from_replaced: 0,
            opening_balance_entry_id: options.opening_balance ? 'ob-entry-1' : null,
            next_period_opening_balance_entry_id: null,
            next_period_id: null,
          },
          error: null,
        }
      }
      return { data: null, error: null }
    },
    storage: {
      from: () => ({ upload: async () => ({ error: null }) }),
    },
  }

  return { supabase: supabase as unknown as SupabaseClient, rpcCalls }
}

function findRpc(rpcCalls: RpcCall[], fn: string): RpcCall | undefined {
  return rpcCalls.find((c) => c.fn === fn)
}

function makeParsedFile(overrides?: Partial<ParsedSIEFile>): ParsedSIEFile {
  return {
    header: {
      sieType: 4,
      flagga: 0,
      program: 'TestProg',
      programVersion: '1.0',
      generatedDate: '2024-01-01',
      format: 'PC8',
      companyName: 'Continuity AB',
      orgNumber: '5566778899',
      address: null,
      fiscalYears: [
        { yearIndex: 0, start: '2024-01-01', end: '2024-12-31' },
        { yearIndex: -1, start: '2023-01-01', end: '2023-12-31' },
      ],
      currency: 'SEK',
      kontoPlanType: null,
      ksumma: null,
    },
    accounts: [
      { number: '1930', name: 'Företagskonto' },
      { number: '2010', name: 'Eget kapital' },
    ],
    // Issue #675 shape: no #IB 0 at all — only prior-year IB/UB and current UB.
    dimensions: [],
    objects: [],
    openingBalances: [{ yearIndex: -1, account: '1930', amount: 9483.08 }],
    closingBalances: [
      { yearIndex: -1, account: '1930', amount: 37400.78 },
      { yearIndex: -1, account: '2010', amount: -37400.78 },
      { yearIndex: 0, account: '1930', amount: 160406.0 },
      { yearIndex: 0, account: '2010', amount: -160406.0 },
    ],
    resultBalances: [],
    vouchers: [],
    issues: [],
    stats: {
      totalAccounts: 2,
      totalVouchers: 0,
      totalTransactionLines: 0,
      fiscalYearStart: '2024-01-01',
      fiscalYearEnd: '2024-12-31',
    },
    ...overrides,
  }
}

function makeMapping(source: string, target: string): AccountMapping {
  return {
    sourceAccount: source,
    sourceName: `Account ${source}`,
    targetAccount: target,
    targetName: `Target ${target}`,
    confidence: 1,
    matchType: 'exact',
    isOverride: false,
  }
}

function standardQueues() {
  return {
    sie_imports: [
      { data: null }, // checkDuplicateImport — no duplicate
      {}, // cleanupStaleImportRecords delete
      { data: { id: 'imp-1' } }, // createPendingImportRecord insert
      { data: null }, // checkDuplicatePeriodImport — no duplicate
      // fiscal-period stamp + finalizeImportRecord metadata update ride on defaults
    ],
    chart_of_accounts: [
      {
        // syncMappedAccounts paged fetch — both accounts already exist
        data: [
          { account_number: '1930', account_name: 'Företagskonto' },
          { account_number: '2010', account_name: 'Eget kapital' },
        ],
      },
    ],
    fiscal_periods: [
      { data: { id: 'fp-1' } }, // find existing fiscal period
      { data: { opening_balances_set: false, opening_balance_entry_id: null } }, // IB-block check
    ],
    journal_entries: [
      { count: 0 }, // companyHasPriorActivity — first-ever import
      // posted-entries fetchAllRows rides on defaults (data: null ends pagination)
    ],
  }
}

const standardOptions = {
  filename: 'continuity.se',
  fileContent: '#dummy',
  createFiscalPeriod: false,
  importOpeningBalances: true,
  importTransactions: true,
  updateAccountNames: false,
}

const standardMappings = [makeMapping('1930', '1930'), makeMapping('2010', '2010')]

// --- Tests ---

describe('executeSIEImport — derived IB from #UB -1 (issue #675)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('feeds the derived opening-balance payload to finalize_sie_import when #IB 0 is missing', async () => {
    const { supabase, rpcCalls } = buildRoutingSupabase(standardQueues())

    const result = await executeSIEImport(
      supabase,
      'company-1',
      'user-1',
      makeParsedFile(),
      standardMappings,
      standardOptions,
    )

    expect(result.errors).toEqual([])
    expect(result.success).toBe(true)
    expect(result.openingBalanceEntryId).toBe('ob-entry-1')
    expect(result.journalEntriesCreated).toBe(1)
    expect(result.warnings.join(' ')).toMatch(/kontinuitetsprincipen/)

    // The OB entry is no longer posted through the engine — it is built as a
    // payload and posted atomically inside the finalize_sie_import RPC.
    expect(createJournalEntry).not.toHaveBeenCalled()

    const finalize = findRpc(rpcCalls, 'finalize_sie_import')
    expect(finalize).toBeDefined()
    expect(finalize!.args.p_company_id).toBe('company-1')
    expect(finalize!.args.p_import_id).toBe('imp-1')
    expect(finalize!.args.p_user_id).toBe('user-1')

    const options = finalize!.args.p_options as Record<string, unknown>
    const openingBalance = options.opening_balance as {
      entry_date: string
      description: string
      lines: unknown[]
    }
    expect(openingBalance.entry_date).toBe('2024-01-01')
    expect(openingBalance.description).toBe(
      'Ingående balanser från SIE-import (härledda från föregående års utgående balans)'
    )
    expect(openingBalance.lines).toEqual([
      { account_number: '1930', debit_amount: 37400.78, credit_amount: 0, line_description: 'IB 1930' },
      { account_number: '2010', debit_amount: 0, credit_amount: 37400.78, line_description: 'IB 2010' },
    ])

    // The N→N+1 IB resync (I12) is fed from the imported #UB 0 — the RPC
    // enforces conflict rules and exact continuity; N+1 is never auto-created.
    const nextPeriodOb = options.next_period_ob as { lines: unknown[] }
    expect(nextPeriodOb.lines).toEqual([
      {
        account_number: '1930',
        debit_amount: 160406.0,
        credit_amount: 0,
        line_description: 'IB 1930 (från föregående års UB)',
      },
      {
        account_number: '2010',
        debit_amount: 0,
        credit_amount: 160406.0,
        line_description: 'IB 2010 (från föregående års UB)',
      },
    ])
    expect(options.create_next_period).toBe(false)

    // Archive succeeded → the controlled status RPC flips to 'completed' (I18).
    const complete = findRpc(rpcCalls, 'complete_sie_import')
    expect(complete).toBeDefined()
    expect(complete!.args.p_status).toBe('completed')
    expect(complete!.args.p_archived).toBe(true)
  })

  it('uses the plain description and no continuity warning for explicit #IB 0', async () => {
    const { supabase, rpcCalls } = buildRoutingSupabase(standardQueues())
    const parsed = makeParsedFile({
      openingBalances: [
        { yearIndex: 0, account: '1930', amount: 37400.78 },
        { yearIndex: 0, account: '2010', amount: -37400.78 },
      ],
    })

    const result = await executeSIEImport(
      supabase,
      'company-1',
      'user-1',
      parsed,
      standardMappings,
      standardOptions,
    )

    expect(result.success).toBe(true)
    expect(result.warnings.join(' ')).not.toMatch(/kontinuitetsprincipen/)

    const finalize = findRpc(rpcCalls, 'finalize_sie_import')
    const options = finalize!.args.p_options as Record<string, unknown>
    const openingBalance = options.opening_balance as { description: string }
    expect(openingBalance.description).toBe('Ingående balanser från SIE-import')
  })

  it('respects the continuation guard — no derived IB when the company has prior activity', async () => {
    const queues = standardQueues()
    queues.journal_entries = [{ count: 5 }] // posted entries exist
    const { supabase, rpcCalls } = buildRoutingSupabase(queues)

    const result = await executeSIEImport(
      supabase,
      'company-1',
      'user-1',
      makeParsedFile(),
      standardMappings,
      standardOptions,
    )

    expect(createJournalEntry).not.toHaveBeenCalled()
    expect(result.openingBalanceEntryId).toBeNull()
    expect(result.warnings.join(' ')).toMatch(/hoppades över eftersom bolaget redan har bokförda verifikationer/)

    // No opening_balance payload reaches the RPC — the guard closed the gate.
    const finalize = findRpc(rpcCalls, 'finalize_sie_import')
    const options = finalize!.args.p_options as Record<string, unknown>
    expect(options.opening_balance).toBeUndefined()

    // Zero entries created → the finalizer safety net downgrades the run so
    // the file slot stays free for a retry (existing behavior).
    expect(result.success).toBe(false)
    expect(result.errors.join(' ')).toMatch(/0 verifikationer/)
    const complete = findRpc(rpcCalls, 'complete_sie_import')
    expect(complete!.args.p_status).toBe('failed')
  })

  it('creates no IB entry when the file has neither #IB 0 nor #UB -1', async () => {
    const { supabase, rpcCalls } = buildRoutingSupabase(standardQueues())
    const parsed = makeParsedFile({
      openingBalances: [],
      closingBalances: [
        { yearIndex: 0, account: '1930', amount: 160406.0 },
        { yearIndex: 0, account: '2010', amount: -160406.0 },
      ],
    })

    const result = await executeSIEImport(
      supabase,
      'company-1',
      'user-1',
      parsed,
      standardMappings,
      standardOptions,
    )

    expect(createJournalEntry).not.toHaveBeenCalled()
    expect(result.openingBalanceEntryId).toBeNull()

    const finalize = findRpc(rpcCalls, 'finalize_sie_import')
    const options = finalize!.args.p_options as Record<string, unknown>
    expect(options.opening_balance).toBeUndefined()
  })
})
