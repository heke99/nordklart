import { describe, it, expect } from 'vitest'
import {
  calculateLatePaymentInterest,
  getAnnualInterestRate,
  getReferensrantaAt,
} from '../late-payment-interest'

describe('getReferensrantaAt', () => {
  it('returns 0 for early 2022', () => {
    expect(getReferensrantaAt('2022-01-15')).toBe(0)
  })

  it('returns 0.005 for late 2022', () => {
    expect(getReferensrantaAt('2022-12-31')).toBe(0.005)
  })

  it('returns the boundary value exactly on switch date', () => {
    expect(getReferensrantaAt('2024-07-01')).toBe(0.04)
  })

  it('returns the most recent rate for dates in 2026', () => {
    expect(getReferensrantaAt('2026-05-15')).toBe(0.02)
  })

  it('falls back to earliest entry for pre-2022 dates', () => {
    expect(getReferensrantaAt('2021-01-01')).toBe(0)
  })
})

describe('getAnnualInterestRate', () => {
  it('adds 8 percentage points to referensränta by default', () => {
    // 2026 referensränta = 0.02 (Riksbanken) → 0.02 + 0.08 = 0.10
    const rate = getAnnualInterestRate('2026-05-01')
    expect(rate).toBeCloseTo(0.1, 4)
  })

  it('uses the override rate when supplied', () => {
    const rate = getAnnualInterestRate('2026-05-01', 0.115)
    expect(rate).toBe(0.115)
  })

  it('respects override of 0 (interest-free reminder)', () => {
    const rate = getAnnualInterestRate('2026-05-01', 0)
    expect(rate).toBe(0)
  })

  it('ignores undefined override but respects 0', () => {
    expect(getAnnualInterestRate('2026-05-01', undefined)).toBeCloseTo(0.1, 4)
    expect(getAnnualInterestRate('2026-05-01', null)).toBeCloseTo(0.1, 4)
  })
})

describe('calculateLatePaymentInterest', () => {
  it('returns 0 when invoice is not yet overdue', () => {
    const result = calculateLatePaymentInterest({
      overdueAmount: 10_000,
      dueDate: '2026-06-01',
      asOfDate: '2026-05-15',
    })
    expect(result.amount).toBe(0)
    expect(result.days).toBe(0)
    expect(result.fromDate).toBe('2026-06-01')
  })

  it('returns 0 when asOfDate equals dueDate', () => {
    const result = calculateLatePaymentInterest({
      overdueAmount: 10_000,
      dueDate: '2026-05-15',
      asOfDate: '2026-05-15',
    })
    expect(result.amount).toBe(0)
    expect(result.days).toBe(0)
  })

  it('computes Räntelagen §6 default for 30 days on 10 000 kr (2026 rate 10 %)', () => {
    // 2026-01-01 referensränta = 0.02 → annual rate = 0.10
    // interest = 10 000 × 0.10 × 30 / 365 ≈ 82.19
    const result = calculateLatePaymentInterest({
      overdueAmount: 10_000,
      dueDate: '2026-04-15',
      asOfDate: '2026-05-15',
    })
    expect(result.days).toBe(30)
    expect(result.rate).toBeCloseTo(0.1, 4)
    expect(result.amount).toBeCloseTo(82.19, 2)
  })

  it('computes with explicit override 5% on 10 000 kr for 30 days ≈ 41.10', () => {
    // interest = 10 000 × 0.05 × 30 / 365 ≈ 41.0959
    const result = calculateLatePaymentInterest({
      overdueAmount: 10_000,
      dueDate: '2026-04-15',
      asOfDate: '2026-05-15',
      overrideRate: 0.05,
    })
    expect(result.amount).toBeCloseTo(41.1, 1)
    expect(result.rate).toBe(0.05)
  })

  it('computes with explicit override 11.5% on 10 000 kr for 30 days ≈ 94.52', () => {
    // interest = 10 000 × 0.115 × 30 / 365 ≈ 94.5205
    const result = calculateLatePaymentInterest({
      overdueAmount: 10_000,
      dueDate: '2026-04-15',
      asOfDate: '2026-05-15',
      overrideRate: 0.115,
    })
    expect(result.amount).toBeCloseTo(94.52, 1)
    expect(result.rate).toBe(0.115)
  })

  it('applies the referensränta of each calendar half-year the debt spans (räntelagen 6 §)', () => {
    // Overdue 2024-12-15 → 2025-02-15: 16 days at 4 % + 8 = 12 % (2024 H2),
    // then 46 days at 3 % + 8 = 11 % (2025 H1).
    const result = calculateLatePaymentInterest({
      overdueAmount: 10_000,
      dueDate: '2024-12-15',
      asOfDate: '2025-02-15',
    })
    expect(result.days).toBe(62)
    expect(result.segments?.map((s) => [s.days, Number(s.rate.toFixed(4))])).toEqual([
      [16, 0.12],
      [46, 0.11],
    ])
    const expected = 10_000 * 0.12 * 16 / 365 + 10_000 * 0.11 * 46 / 365
    expect(result.amount).toBeCloseTo(expected, 2)
  })

  it('does not segment a contractual override rate', () => {
    const result = calculateLatePaymentInterest({
      overdueAmount: 10_000,
      dueDate: '2024-12-15',
      asOfDate: '2025-02-15',
      overrideRate: 0.12,
    })
    expect(result.segments?.every((s) => s.rate === 0.12)).toBe(true)
  })

  it('throws on a negative overdue amount', () => {
    expect(() =>
      calculateLatePaymentInterest({
        overdueAmount: -500,
        dueDate: '2026-04-15',
        asOfDate: '2026-05-15',
      }),
    ).toThrow()
  })

  it('returns 0 amount when overdueAmount is 0 even if days > 0', () => {
    const result = calculateLatePaymentInterest({
      overdueAmount: 0,
      dueDate: '2026-04-15',
      asOfDate: '2026-05-15',
    })
    expect(result.amount).toBe(0)
    expect(result.days).toBe(0)
  })

  it('rounds to 2 decimals (no toFixed drift)', () => {
    // 12 345 × 0.115 × 17 / 365 = 66.1150... → 66.12
    const result = calculateLatePaymentInterest({
      overdueAmount: 12_345,
      dueDate: '2026-04-15',
      asOfDate: '2026-05-02',
      overrideRate: 0.115,
    })
    expect(result.amount).toBe(66.12)
  })
})
