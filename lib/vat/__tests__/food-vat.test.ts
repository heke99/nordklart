import { describe, it, expect } from 'vitest'
import { getFoodVatRate, isFoodVatReductionActive } from '../food-vat'

describe('food VAT', () => {
  it.each([
    ['2026-03-31', 0.12],
    ['2026-04-01', 0.06],
    ['2027-12-31', 0.06],
    ['2028-01-01', 0.12],
  ])('%s → %s', (date, rate) => {
    expect(getFoodVatRate(date)).toBe(rate)
  })

  it('accepts timestamps', () => {
    expect(isFoodVatReductionActive('2026-06-15T10:00:00Z')).toBe(true)
  })
})
