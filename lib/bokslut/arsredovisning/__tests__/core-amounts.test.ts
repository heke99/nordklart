import { describe, expect, it } from 'vitest'
import { compareCoreAmounts, type AnnualReportCoreAmounts } from '../core-amounts'

const sampleCore: AnnualReportCoreAmounts = {
  net_revenue: 21_300,
  result_after_financial: 19_843.5,
  result_before_tax: 19_843.5,
  tax: 2_154,
  net_result: 17_689.5,
  total_assets: 25_149.5,
  total_equity_liabilities: 25_149.5,
  equity: 29_294.19,
}

describe('annual-report PDF/iXBRL core comparison', () => {
  it('passes only when every canonical core amount is identical', () => {
    const result = compareCoreAmounts(sampleCore, { ...sampleCore })
    expect(result.match).toBe(true)
    expect(Object.values(result.fields).every((field) => field.match)).toBe(true)
  })

  it('reports the exact mismatched field', () => {
    const result = compareCoreAmounts(sampleCore, {
      ...sampleCore,
      result_after_financial: 17_689.5,
    })
    expect(result.match).toBe(false)
    expect(result.fields.result_after_financial).toEqual({
      pdf: 19_843.5,
      ixbrl: 17_689.5,
      match: false,
    })
  })
})
