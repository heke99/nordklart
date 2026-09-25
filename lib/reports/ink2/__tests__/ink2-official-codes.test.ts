import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SKV_FIELD_CODES, SKV_INK2R_FIELDS } from '@/lib/reports/sru/skv-field-codes'
import {
  INK2R_ASSET_CODES,
  INK2R_EQUITY_LIABILITY_CODES,
  INK2R_INCOME_CODES,
  INK2S_NUMERIC_CODES,
} from '../types'
import { INK2R_ACCOUNT_MAPPINGS, generateINK2Declaration } from '../ink2-engine'
import { computePeriodSuffix } from '../sru-generator'

vi.mock('@/lib/tax-declaration/adjustments', () => ({
  listTaxDeclarationAdjustments: vi.fn().mockResolvedValue([]),
  approvedAdjustmentAmount: vi.fn().mockReturnValue(0),
  pendingAdjustmentWarnings: vi.fn().mockReturnValue([]),
}))

describe('INK2 field codes follow Skatteverket 2025P4', () => {
  it('every INK2R code Nordklart emits exists on INK2R', () => {
    for (const code of [...INK2R_ASSET_CODES, ...INK2R_EQUITY_LIABILITY_CODES, ...INK2R_INCOME_CODES]) {
      expect(SKV_FIELD_CODES.INK2R.has(code), code).toBe(true)
    }
  })

  it('covers every numeric INK2R field on the form', () => {
    const ours = new Set<string>([...INK2R_ASSET_CODES, ...INK2R_EQUITY_LIABILITY_CODES, ...INK2R_INCOME_CODES])
    const missing = SKV_INK2R_FIELDS.map((f) => f.code).filter((code) => !ours.has(code))
    expect(missing).toEqual([])
  })

  it('every mapping targets an INK2R code', () => {
    for (const mapping of INK2R_ACCOUNT_MAPPINGS) {
      expect(SKV_FIELD_CODES.INK2R.has(mapping.sruCode), mapping.sruCode).toBe(true)
      if (mapping.negativeSruCode) expect(SKV_FIELD_CODES.INK2R.has(mapping.negativeSruCode)).toBe(true)
    }
  })

  it('every INK2S code exists on INK2S', () => {
    for (const code of INK2S_NUMERIC_CODES) {
      expect(SKV_FIELD_CODES.INK2S.has(code), code).toBe(true)
    }
  })

  it('överskott/underskott on INK2 page 1 are 7104/7114', () => {
    expect(SKV_FIELD_CODES.INK2.has('7104')).toBe(true)
    expect(SKV_FIELD_CODES.INK2.has('7114')).toBe(true)
    expect(SKV_FIELD_CODES.INK2.has('7113')).toBe(false)
  })
})

describe('computePeriodSuffix', () => {
  it.each([
    ['2025-04-30', 'P1'],
    ['2025-05-31', 'P2'],
    ['2025-06-30', 'P2'],
    ['2025-07-31', 'P3'],
    ['2025-08-31', 'P3'],
    ['2025-09-30', 'P4'],
    ['2025-12-31', 'P4'],
  ])('%s -> %s', (end, suffix) => {
    expect(computePeriodSuffix(end)).toBe(suffix)
  })
})

/**
 * Minimal supabase stub: every table returns its fixture once (first page),
 * and every filter call is recorded so the test can assert the closing
 * vouchers were filtered out.
 */
function makeSupabase(tables: Record<string, unknown[] | Record<string, unknown>>) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = []
  const from = (table: string) => {
    let rangeFrom = 0
    const builder: Record<string, unknown> = {}
    const chain = (method: string) => (...args: unknown[]) => {
      calls.push({ table, method, args })
      if (method === 'range') rangeFrom = Number(args[0])
      return builder
    }
    for (const m of ['select', 'eq', 'neq', 'in', 'is', 'gte', 'lte', 'lt', 'order', 'range', 'limit']) {
      builder[m] = chain(m)
    }
    const fixture = tables[table]
    builder.single = async () => ({ data: Array.isArray(fixture) ? fixture[0] : fixture ?? null, error: null })
    builder.maybeSingle = builder.single
    builder.then = (resolve: (v: unknown) => void) =>
      resolve({ data: rangeFrom === 0 ? (Array.isArray(fixture) ? fixture : []) : [], error: null })
    return builder
  }
  return { client: { from } as unknown as SupabaseClient, calls }
}

describe('generateINK2Declaration', () => {
  it('derives the result from the accounts and ignores year-end closing vouchers', async () => {
    const lines = [
      // IB: share capital and bank
      { account_number: '1930', debit_amount: 25000, credit_amount: 0 },
      { account_number: '2081', debit_amount: 0, credit_amount: 25000 },
      // Year: sales 100 000, costs 40 000, through the bank
      { account_number: '1930', debit_amount: 100000, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 100000 },
      { account_number: '5010', debit_amount: 40000, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 40000 },
      // Non-deductible representation
      { account_number: '6072', debit_amount: 1000, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
    ]
    const { client, calls } = makeSupabase({
      fiscal_periods: { id: 'fp', name: '2025', period_start: '2025-01-01', period_end: '2025-12-31', is_closed: true },
      company_settings: { company_name: 'Test AB', org_number: '5560000001', entity_type: 'aktiebolag' },
      journal_entry_lines: lines,
      chart_of_accounts: [],
      year_end_rulesets: { schablonintakt_rate: 0.0196 },
    })

    const declaration = await generateINK2Declaration(client, 'company', 'fp')

    expect(declaration.ink2r['7410']).toBe(100000)
    expect(declaration.ink2r['7513']).toBe(41000)
    expect(declaration.ink2r['7450']).toBe(59000)
    // Fritt eget kapital carries the year's result; the schedule balances.
    expect(declaration.ink2r['7302']).toBe(59000)
    expect(declaration.totals.totalAssets).toBe(84000)
    expect(declaration.totals.totalEquityLiabilities).toBe(84000)
    // Taxable surplus = result + non-deductible representation.
    expect(declaration.ink2s['7653']).toBe(1000)
    expect(declaration.ink2s['7670']).toBe(60000)
    expect(declaration.ink2['7104']).toBe(60000)

    const closingFilters = calls.filter(
      (c) => c.table === 'journal_entry_lines' && c.method === 'neq' && c.args[0] === 'journal_entries.source_type',
    )
    expect(closingFilters.map((c) => c.args[1])).toEqual(expect.arrayContaining(['year_end', 'year_end_closing']))
  })
})
