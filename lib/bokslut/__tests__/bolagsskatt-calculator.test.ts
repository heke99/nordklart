import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/reports/income-statement', () => ({
  generateIncomeStatement: vi.fn(),
}))

import {
  calculateBolagsskatt,
  BOLAGSSKATT_RATE,
} from '../tax-provision/bolagsskatt-calculator'
import { generateIncomeStatement } from '@/lib/reports/income-statement'

const NOOP_CLIENT = {} as Parameters<typeof calculateBolagsskatt>[0]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('calculateBolagsskatt', () => {
  it('applies 20.6% to positive result and posts 8910/2512', async () => {
    vi.mocked(generateIncomeStatement).mockResolvedValue({
      net_result: 500_000,
    } as Awaited<ReturnType<typeof generateIncomeStatement>>)

    const result = await calculateBolagsskatt(NOOP_CLIENT, 'co', 'fp')

    expect(result).not.toBeNull()
    expect(result!.amount).toBe(Math.round(500_000 * BOLAGSSKATT_RATE)) // 103000
    const debit = result!.lines.find((l) => l.account_number === '8910')!
    const credit = result!.lines.find((l) => l.account_number === '2512')!
    expect(debit.debit_amount).toBe(103_000)
    expect(credit.credit_amount).toBe(103_000)
  })

  it('returns a zero-amount proposal for loss year (no entry posted)', async () => {
    vi.mocked(generateIncomeStatement).mockResolvedValue({
      net_result: -50_000,
    } as Awaited<ReturnType<typeof generateIncomeStatement>>)

    const result = await calculateBolagsskatt(NOOP_CLIENT, 'co', 'fp')

    expect(result).not.toBeNull()
    expect(result!.amount).toBe(0)
    expect(result!.lines).toEqual([])
    expect(result!.description).toContain('förlust')
  })

  it('adds non-deductible expenses to taxable result', async () => {
    vi.mocked(generateIncomeStatement).mockResolvedValue({
      net_result: 100_000,
    } as Awaited<ReturnType<typeof generateIncomeStatement>>)

    const result = await calculateBolagsskatt(NOOP_CLIENT, 'co', 'fp', {
      manualAdjustments: { nonDeductibleExpenses: 50_000 },
    })

    // (100_000 + 50_000) × 0.206 = 30_900
    expect(result!.amount).toBe(30_900)
  })

  it('subtracts non-taxable income from taxable result', async () => {
    vi.mocked(generateIncomeStatement).mockResolvedValue({
      net_result: 100_000,
    } as Awaited<ReturnType<typeof generateIncomeStatement>>)

    const result = await calculateBolagsskatt(NOOP_CLIENT, 'co', 'fp', {
      manualAdjustments: { nonTaxableIncome: 40_000 },
    })

    // (100_000 - 40_000) × 0.206 = 12_360
    expect(result!.amount).toBe(12_360)
  })

  it('adds schablonintäkt on periodiseringsfond to taxable result', async () => {
    vi.mocked(generateIncomeStatement).mockResolvedValue({
      net_result: 200_000,
    } as Awaited<ReturnType<typeof generateIncomeStatement>>)

    const result = await calculateBolagsskatt(NOOP_CLIENT, 'co', 'fp', {
      manualAdjustments: { schablonintaktPeriodiseringsfond: 3_000 },
    })

    // (200_000 + 3_000) × 0.206 = 41_818
    expect(result!.amount).toBe(41_818)
  })

  it('truncates taxable result to whole krona before applying tax', async () => {
    vi.mocked(generateIncomeStatement).mockResolvedValue({
      net_result: 100_999.99,
    } as Awaited<ReturnType<typeof generateIncomeStatement>>)

    const result = await calculateBolagsskatt(NOOP_CLIENT, 'co', 'fp')

    // floor(100_999.99) = 100_999, × 0.206 = 20805.794 → round = 20_806
    expect(result!.amount).toBe(20_806)
  })
})
