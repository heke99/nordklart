import { describe, it, expect } from 'vitest'
import {
  REPRESENTATION_VAT_BASE_CAP_SEK,
  isRepresentationAccount,
  maxDeductibleRepresentationVat,
  capRepresentationVat,
} from '../representation'

describe('isRepresentationAccount', () => {
  it('matches the BAS 6070-6079 range', () => {
    expect(isRepresentationAccount('6071')).toBe(true)
    expect(isRepresentationAccount('6072')).toBe(true)
    expect(isRepresentationAccount('6079')).toBe(true)
  })

  it('rejects other accounts', () => {
    expect(isRepresentationAccount('6110')).toBe(false)
    expect(isRepresentationAccount('5410')).toBe(false)
    expect(isRepresentationAccount('60711')).toBe(false)
  })
})

describe('maxDeductibleRepresentationVat', () => {
  it('caps at 300 kr underlag per person (ML 13 kap 27 §)', () => {
    expect(REPRESENTATION_VAT_BASE_CAP_SEK).toBe(300)
    // 4 persons × 300 kr × 25% = 300 kr max deductible VAT
    expect(maxDeductibleRepresentationVat(4, 0.25)).toBe(300)
    // 2 persons × 300 kr × 12% = 72 kr
    expect(maxDeductibleRepresentationVat(2, 0.12)).toBe(72)
  })

  it('returns 0 for invalid inputs', () => {
    expect(maxDeductibleRepresentationVat(0, 0.25)).toBe(0)
    expect(maxDeductibleRepresentationVat(-1, 0.25)).toBe(0)
    expect(maxDeductibleRepresentationVat(4, 0)).toBe(0)
    expect(maxDeductibleRepresentationVat(NaN, 0.25)).toBe(0)
  })
})

describe('capRepresentationVat', () => {
  it('passes through VAT below the cap', () => {
    // Lunch 4 pers, 1000 kr underlag → 250 kr moms ≤ cap 300 kr
    expect(capRepresentationVat({ vatAmount: 250, participantCount: 4, vatRate: 0.25 }))
      .toEqual({ deductible: 250, excess: 0 })
  })

  it('caps VAT above the maximum and returns the excess', () => {
    // Middag 2 pers, 4000 kr underlag → 1000 kr moms; cap = 2×300×0.25 = 150 kr
    expect(capRepresentationVat({ vatAmount: 1000, participantCount: 2, vatRate: 0.25 }))
      .toEqual({ deductible: 150, excess: 850 })
  })

  it('handles reduced 12% rate meals', () => {
    // 3 pers mat 12%: cap = 3×300×0.12 = 108
    expect(capRepresentationVat({ vatAmount: 200, participantCount: 3, vatRate: 0.12 }))
      .toEqual({ deductible: 108, excess: 92 })
  })

  it('deductible + excess always equals the original VAT', () => {
    const { deductible, excess } = capRepresentationVat({ vatAmount: 333.33, participantCount: 1, vatRate: 0.25 })
    expect(Math.round((deductible + excess) * 100) / 100).toBe(333.33)
  })
})
