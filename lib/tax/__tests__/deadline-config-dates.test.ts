import { describe, it, expect } from 'vitest'
import { TAX_DEADLINE_CONFIGS, type CompanySettingsForDeadlines } from '../deadline-config'

/**
 * Dates per Skatteverket "När ska jag deklarera moms" and the F-skatt
 * payment schedule (before the banking-day adjustment the generator applies).
 */
const base: CompanySettingsForDeadlines = {
  entity_type: 'aktiebolag',
  moms_period: 'monthly',
  f_skatt: true,
  vat_registered: true,
  pays_salaries: false,
  fiscal_year_start_month: 1,
}

function dates(type: string, settings: Partial<CompanySettingsForDeadlines> = {}, year = 2026) {
  const config = TAX_DEADLINE_CONFIGS.find((c) => c.type === type)!
  return config
    .generateDates(year, { ...base, ...settings })
    .map((d) => ({ period: d.period, due: `${d.year}-${String(d.month + 1).padStart(2, '0')}-${String(d.day).padStart(2, '0')}` }))
}

describe('momsdeklaration deadlines', () => {
  it('monthly ≤ 40 MSEK: 12th of the second month, 17th in January and August', () => {
    const d = dates('moms_monthly')
    expect(d.find((x) => x.period === '2026-01')?.due).toBe('2026-03-12')
    expect(d.find((x) => x.period === '2026-06')?.due).toBe('2026-08-17')
    expect(d.find((x) => x.period === '2026-11')?.due).toBe('2027-01-17')
    expect(d.find((x) => x.period === '2026-12')?.due).toBe('2027-02-12')
  })

  it('monthly > 40 MSEK: 26th of the following month, 27th in December', () => {
    const d = dates('moms_monthly', { vat_base_over_40m: true })
    expect(d.find((x) => x.period === '2026-01')?.due).toBe('2026-02-26')
    expect(d.find((x) => x.period === '2026-11')?.due).toBe('2026-12-27')
    expect(d.find((x) => x.period === '2026-12')?.due).toBe('2027-01-26')
  })

  it('quarterly: 12th of the second month after the quarter, 17 August', () => {
    const d = dates('moms_quarterly', { moms_period: 'quarterly' })
    expect(d.map((x) => x.due)).toEqual(['2026-05-12', '2026-08-17', '2026-11-12', '2027-02-12'])
  })

  it('yearly for an enskild firma: 12 May the year after', () => {
    const d = dates('moms_yearly', { moms_period: 'yearly', entity_type: 'enskild_firma' })
    expect(d).toEqual([{ period: '2025', due: '2026-05-12' }])
  })
})

describe('F-skatt', () => {
  it('is due the 12th, and the 17th in January and August', () => {
    const d = dates('f_skatt')
    expect(d[0].due).toBe('2026-01-17')
    expect(d[1].due).toBe('2026-02-12')
    expect(d[7].due).toBe('2026-08-17')
    expect(d[11].due).toBe('2026-12-12')
  })
})
