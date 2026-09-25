import { describe, expect, it } from 'vitest'
import { computeK10, getK10Parameters } from '../k10'

const base = {
  incomeYear: 2026,
  totalShares: 1000,
  ownerShares: 1000,
  wageBase: 0,
  ownerOrRelatedCashPay: 0,
  costBasis: 25_000,
  savedSpace: 0,
  dividend: 0,
}

describe('computeK10 (inkomstår 2026, IL 57 kap. i lydelse SFS 2025:1361)', () => {
  it('gives a sole owner the full grundbelopp 322 400 (4 × 80 600)', () => {
    const r = computeK10(base)
    expect(r.grundbelopp).toBe(322_400)
    expect(r.aretsGransbelopp).toBe(322_400)
  })

  it('shares the grundbelopp per share', () => {
    expect(computeK10({ ...base, ownerShares: 500 }).grundbelopp).toBe(161_200)
  })

  it('caps the grundbelopp at one across companies (57:11 a)', () => {
    // 100 % here and 100 % in another company: half each.
    expect(computeK10({ ...base, otherCompanyOwnershipFractions: [1] }).grundbelopp).toBe(161_200)
    // 50 % + 30 %: under one grundbelopp in total, no reduction.
    expect(computeK10({ ...base, ownerShares: 500, otherCompanyOwnershipFractions: [0.3] }).grundbelopp).toBe(161_200)
  })

  it('computes lönebaserat utrymme as (löneunderlag × andel − 8 IBB) × 0,5 (Skatteverkets exempel)', () => {
    const r = computeK10({ ...base, ownerShares: 700, wageBase: 4_000_000, ownerOrRelatedCashPay: 600_000 })
    // (4 000 000 × 0,7 − 644 800) × 0,5
    expect(r.lonebaseratUtrymme).toBe(1_077_600)
  })

  it('caps lönebaserat utrymme at 50 × the owner\'s or närståendes cash pay', () => {
    const r = computeK10({ ...base, wageBase: 4_000_000, ownerOrRelatedCashPay: 10_000 })
    expect(r.lonebaseratUtrymmeUncapped).toBe(1_677_600)
    expect(r.lonebaseratUtrymme).toBe(500_000)
    expect(computeK10({ ...base, wageBase: 4_000_000, ownerOrRelatedCashPay: 0 }).lonebaseratUtrymme).toBe(0)
  })

  it('gives interest only on omkostnadsbelopp above 100 000 at SLR + 9 % (11,55 %)', () => {
    expect(computeK10({ ...base, costBasis: 100_000 }).rantaPaOmkostnadsbelopp).toBe(0)
    expect(computeK10({ ...base, costBasis: 300_000 }).rantaPaOmkostnadsbelopp).toBe(23_100)
  })

  it('adds saved space without uplift and taxes the dividend within the limit at 20 %', () => {
    const r = computeK10({ ...base, savedSpace: 50_000, dividend: 100_000 })
    expect(r.gransbelopp).toBe(372_400)
    expect(r.taxableCapitalWithinLimit).toBeCloseTo(66_666.67, 2)
    // Skatteverket: 100 000 × 2/3 × 0,3 = 20 000
    expect(r.capitalTax).toBe(20_000)
    expect(r.savedSpaceCarriedForward).toBe(272_400)
  })

  it('taxes the part above the gränsbelopp in tjänst up to 90 IBB, then as capital at 30 %', () => {
    const r = computeK10({ ...base, dividend: 322_400 + 8_000_000 })
    expect(r.dividendWithinLimit).toBe(322_400)
    // 90 × 83 400 = 7 506 000
    expect(r.dividendAsTjanst).toBe(7_506_000)
    expect(r.dividendAboveTjanstCap).toBe(494_000)
    expect(r.savedSpaceCarriedForward).toBe(0)
  })

  it('refuses income years under the old rules', () => {
    expect(() => getK10Parameters(2025)).toThrow(/äldre reglerna/)
  })
})
