import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))

import { generateResultatrapport } from '../resultatrapport'
import { generateTrialBalance } from '../trial-balance'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { TrialBalanceRow } from '@/types'

const mockTrialBalance = vi.mocked(generateTrialBalance)

beforeEach(() => {
  vi.clearAllMocks()
})

function makeRow(overrides: Partial<TrialBalanceRow>): TrialBalanceRow {
  return {
    account_number: '3001',
    account_name: 'Test',
    account_class: 3,
    opening_debit: 0,
    opening_credit: 0,
    period_debit: 0,
    period_credit: 0,
    closing_debit: 0,
    closing_credit: 0,
    ...overrides,
  }
}

function tb(rows: TrialBalanceRow[]) {
  const totalDebit = rows.reduce((s, r) => s + r.closing_debit, 0)
  const totalCredit = rows.reduce((s, r) => s + r.closing_credit, 0)
  return {
    rows,
    totalDebit: Math.round(totalDebit * 100) / 100,
    totalCredit: Math.round(totalCredit * 100) / 100,
    isBalanced: Math.abs(totalDebit - totalCredit) < 0.01,
  }
}

describe('generateResultatrapport', () => {
  it('groups P&L accounts by class with current and prior period values', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: { period_start: '2026-01-01', period_end: '2026-12-31', previous_period_id: null },
      error: null,
    })

    mockTrialBalance.mockResolvedValueOnce(
      tb([
        makeRow({ account_number: '3001', account_name: 'Försäljning 25%', account_class: 3, closing_credit: 100000 }),
        makeRow({ account_number: '5010', account_name: 'Lokalhyra', account_class: 5, closing_debit: 30000 }),
        makeRow({ account_number: '7210', account_name: 'Löner', account_class: 7, closing_debit: 50000 }),
      ])
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateResultatrapport(q.supabase as any, 'company-1', 'period-1')

    expect(report.groups).toHaveLength(3)
    expect(report.groups.map((g) => g.class)).toEqual([3, 5, 7])
    expect(report.groups[0].rows[0]).toEqual({
      account_number: '3001',
      account_name: 'Försäljning 25%',
      current_period: 100000,
      prior_period: 0,
    })
    // Expense rows shown as negative (credit - debit)
    expect(report.groups[1].rows[0].current_period).toBe(-30000)
    expect(report.groups[2].rows[0].current_period).toBe(-50000)

    // Net result = revenue - expenses = 100000 - 30000 - 50000 = 20000
    expect(report.net_result_current).toBe(20000)
    expect(report.net_result_prior).toBe(0)
    expect(report.prior_period).toBeNull()
  })

  it('joins prior-period values onto current accounts', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: { period_start: '2026-01-01', period_end: '2026-12-31', previous_period_id: 'period-0' },
      error: null,
    })
    q.enqueue({
      data: { period_start: '2025-01-01', period_end: '2025-12-31' },
      error: null,
    })

    mockTrialBalance
      .mockResolvedValueOnce(
        tb([
          makeRow({ account_number: '3001', account_name: 'Försäljning', account_class: 3, closing_credit: 200000 }),
          makeRow({ account_number: '5010', account_name: 'Lokalhyra', account_class: 5, closing_debit: 60000 }),
        ])
      )
      .mockResolvedValueOnce(
        tb([
          makeRow({ account_number: '3001', account_name: 'Försäljning', account_class: 3, closing_credit: 150000 }),
          makeRow({ account_number: '5010', account_name: 'Lokalhyra', account_class: 5, closing_debit: 45000 }),
        ])
      )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateResultatrapport(q.supabase as any, 'company-1', 'period-1')

    const revenueRow = report.groups[0].rows[0]
    expect(revenueRow.current_period).toBe(200000)
    expect(revenueRow.prior_period).toBe(150000)

    const expenseRow = report.groups[1].rows[0]
    expect(expenseRow.current_period).toBe(-60000)
    expect(expenseRow.prior_period).toBe(-45000)

    expect(report.net_result_current).toBe(140000)
    expect(report.net_result_prior).toBe(105000)
    expect(report.prior_period).toEqual({ start: '2025-01-01', end: '2025-12-31' })
  })

  it('includes accounts that exist only in prior period (with current=0)', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: { period_start: '2026-01-01', period_end: '2026-12-31', previous_period_id: 'period-0' },
      error: null,
    })
    q.enqueue({
      data: { period_start: '2025-01-01', period_end: '2025-12-31' },
      error: null,
    })

    mockTrialBalance
      .mockResolvedValueOnce(
        tb([
          makeRow({ account_number: '3001', account_name: 'Försäljning', account_class: 3, closing_credit: 100000 }),
        ])
      )
      .mockResolvedValueOnce(
        tb([
          makeRow({ account_number: '3001', account_name: 'Försäljning', account_class: 3, closing_credit: 80000 }),
          // Account discontinued this year
          makeRow({ account_number: '3002', account_name: 'Gammal intäkt', account_class: 3, closing_credit: 5000 }),
        ])
      )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateResultatrapport(q.supabase as any, 'company-1', 'period-1')

    const class3 = report.groups.find((g) => g.class === 3)!
    expect(class3.rows).toHaveLength(2)
    const discontinued = class3.rows.find((r) => r.account_number === '3002')!
    expect(discontinued.current_period).toBe(0)
    expect(discontinued.prior_period).toBe(5000)
  })

  it('excludes account 8999 (year-end closing account)', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: { period_start: '2026-01-01', period_end: '2026-12-31', previous_period_id: null },
      error: null,
    })

    mockTrialBalance.mockResolvedValueOnce(
      tb([
        makeRow({ account_number: '3001', account_name: 'Revenue', account_class: 3, closing_credit: 100000 }),
        makeRow({ account_number: '8999', account_name: 'Årets resultat', account_class: 8, closing_debit: 100000 }),
      ])
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateResultatrapport(q.supabase as any, 'company-1', 'period-1')

    const class8 = report.groups.find((g) => g.class === 8)
    expect(class8).toBeUndefined()
    expect(report.net_result_current).toBe(100000)
  })

  it('ignores balance accounts (class 1-2)', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: { period_start: '2026-01-01', period_end: '2026-12-31', previous_period_id: null },
      error: null,
    })

    mockTrialBalance.mockResolvedValueOnce(
      tb([
        makeRow({ account_number: '1930', account_name: 'Bank', account_class: 1, closing_debit: 50000 }),
        makeRow({ account_number: '2440', account_name: 'Lev.skuld', account_class: 2, closing_credit: 10000 }),
        makeRow({ account_number: '3001', account_name: 'Revenue', account_class: 3, closing_credit: 40000 }),
      ])
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateResultatrapport(q.supabase as any, 'company-1', 'period-1')

    expect(report.groups).toHaveLength(1)
    expect(report.groups[0].class).toBe(3)
  })

  it('drops rows where both current and prior are zero', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: { period_start: '2026-01-01', period_end: '2026-12-31', previous_period_id: null },
      error: null,
    })

    mockTrialBalance.mockResolvedValueOnce(
      tb([
        makeRow({ account_number: '3001', account_name: 'Revenue', account_class: 3, closing_credit: 50000 }),
        makeRow({ account_number: '3002', account_name: 'Tom rad', account_class: 3, closing_credit: 0 }),
      ])
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateResultatrapport(q.supabase as any, 'company-1', 'period-1')

    expect(report.groups[0].rows).toHaveLength(1)
    expect(report.groups[0].rows[0].account_number).toBe('3001')
  })

  it('throws when fiscal period not found', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: null, error: null })

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      generateResultatrapport(q.supabase as any, 'company-1', 'missing')
    ).rejects.toThrow('Fiscal period not found')
  })
})
