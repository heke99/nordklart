import { describe, it, expect, vi } from 'vitest'
import {
  getVatDeductionPercent,
  splitDeductibleVat,
  buildNonDeductibleVatLine,
} from '../deduction'
import type { SupabaseClient } from '@supabase/supabase-js'

function mockSettingsClient(vatDeductionPercent: unknown) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({
            data: vatDeductionPercent === undefined ? null : { vat_deduction_percent: vatDeductionPercent },
            error: null,
          }),
        }),
      }),
    }),
  } as unknown as SupabaseClient
}

describe('splitDeductibleVat', () => {
  it('returns full amount as deductible at 100%', () => {
    expect(splitDeductibleVat(250, 100)).toEqual({ deductible: 250, nonDeductible: 0 })
  })

  it('splits 60/40 exactly', () => {
    expect(splitDeductibleVat(1000, 60)).toEqual({ deductible: 600, nonDeductible: 400 })
  })

  it('handles 0% deduction (fully exempt activity)', () => {
    expect(splitDeductibleVat(250, 0)).toEqual({ deductible: 0, nonDeductible: 250 })
  })

  it('öre-exact: parts always sum to the original amount', () => {
    for (const [amount, pct] of [[333.33, 33], [99.99, 50], [0.01, 75], [1234.56, 87.5]] as const) {
      const { deductible, nonDeductible } = splitDeductibleVat(amount, pct)
      expect(Math.round((deductible + nonDeductible) * 100) / 100).toBe(Math.round(amount * 100) / 100)
    }
  })

  it('clamps out-of-range percentages', () => {
    expect(splitDeductibleVat(100, 150)).toEqual({ deductible: 100, nonDeductible: 0 })
    expect(splitDeductibleVat(100, -10)).toEqual({ deductible: 0, nonDeductible: 100 })
    expect(splitDeductibleVat(100, NaN)).toEqual({ deductible: 100, nonDeductible: 0 })
  })
})

describe('getVatDeductionPercent', () => {
  it('reads the configured percentage', async () => {
    expect(await getVatDeductionPercent(mockSettingsClient(60), 'c1')).toBe(60)
  })

  it('defaults to 100 when unset', async () => {
    expect(await getVatDeductionPercent(mockSettingsClient(undefined), 'c1')).toBe(100)
    expect(await getVatDeductionPercent(mockSettingsClient(null), 'c1')).toBe(100)
  })

  it('defaults to 100 for out-of-range values', async () => {
    expect(await getVatDeductionPercent(mockSettingsClient(120), 'c1')).toBe(100)
    expect(await getVatDeductionPercent(mockSettingsClient(-5), 'c1')).toBe(100)
  })

  it('coerces numeric strings (pg NUMERIC)', async () => {
    expect(await getVatDeductionPercent(mockSettingsClient('75'), 'c1')).toBe(75)
  })

  it('never throws when the client is unusable — returns 100', async () => {
    expect(await getVatDeductionPercent(null as never, 'c1')).toBe(100)
  })
})

describe('buildNonDeductibleVatLine', () => {
  it('books the non-deductible portion as a cost on the given account', () => {
    const line = buildNonDeductibleVatLine(400, '6540', 60)
    expect(line.account_number).toBe('6540')
    expect(line.debit_amount).toBe(400)
    expect(line.credit_amount).toBe(0)
    expect(line.line_description).toContain('Ej avdragsgill ingående moms')
    expect(line.line_description).toContain('60%')
  })
})
