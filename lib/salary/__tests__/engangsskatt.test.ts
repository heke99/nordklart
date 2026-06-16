import { describe, it, expect } from 'vitest'
import { calculateEngangsskatt } from '../engangsskatt'

describe('calculateEngangsskatt', () => {
  it('calculates 0% tax for very low annual income', () => {
    const result = calculateEngangsskatt(5000, 1000)
    // Annual: 1000 × 12 + 5000 = 17,000 → bracket 0-20,000 → 0%
    expect(result.taxRate).toBe(0.00)
    expect(result.taxAmount).toBe(0)
  })

  it('calculates tax for moderate annual income', () => {
    const result = calculateEngangsskatt(10000, 25000)
    // Annual: 25000 × 12 + 10000 = 310,000 → bracket 200,001-350,000 → 30%
    expect(result.taxRate).toBe(0.30)
    expect(result.taxAmount).toBe(3000)
  })

  it('calculates higher tax when annual income crosses state tax threshold', () => {
    const result = calculateEngangsskatt(50000, 55000)
    // Annual: 55000 × 12 + 50000 = 710,000 → bracket 660,401-950,000 → 52%
    expect(result.taxRate).toBe(0.52)
    expect(result.taxAmount).toBe(26000)
  })

  it('uses total annual income including bonus for bracket lookup', () => {
    const result = calculateEngangsskatt(100000, 40000)
    // Annual: 40000 × 12 + 100000 = 580,000 → bracket 500,001-660,400 → 34%
    expect(result.taxRate).toBe(0.34)
    expect(result.taxAmount).toBe(34000)
  })

  it('returns calculation steps for transparency', () => {
    const result = calculateEngangsskatt(10000, 30000)
    expect(result.steps.length).toBe(2)
    expect(result.steps[0].label).toBe('Beräknad årsinkomst')
    expect(result.annualIncomeEstimate).toBe(370000) // 30000 × 12 + 10000
  })

  it('handles very high income bracket', () => {
    const result = calculateEngangsskatt(200000, 120000)
    // Annual: 120000 × 12 + 200000 = 1,640,000 → bracket ≥1,500,001 → 57%
    expect(result.taxRate).toBe(0.57)
    expect(result.taxAmount).toBe(114000)
  })
})
