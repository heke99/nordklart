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

/**
 * P&L fixture rows carry the PERIOD MOVEMENT in period_debit/period_credit
 * (R02): the report renders `period_credit - period_debit`, never the
 * cumulative closing balance. For a full fiscal year the movement equals
 * the closing balance on P&L accounts (opening is zero), so closing_* is
 * mirrored for realism.
 */
function makeRow(overrides: Partial<TrialBalanceRow>): TrialBalanceRow {
  const base: TrialBalanceRow = {
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
  // Default closing to the movement when the caller only set period_*.
  if (overrides.closing_debit === undefined) base.closing_debit = base.period_debit
  if (overrides.closing_credit === undefined) base.closing_credit = base.period_credit
  return base
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
        makeRow({ account_number: '3001', account_name: 'Försäljning 25%', account_class: 3, period_credit: 100000 }),
        makeRow({ account_number: '5010', account_name: 'Lokalhyra', account_class: 5, period_debit: 30000 }),
        makeRow({ account_number: '7210', account_name: 'Löner', account_class: 7, period_debit: 50000 }),
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
    // Expense rows shown as negative (period_credit - period_debit)
    expect(report.groups[1].rows[0].current_period).toBe(-30000)
    expect(report.groups[2].rows[0].current_period).toBe(-50000)

    // Net result = revenue - expenses = 100000 - 30000 - 50000 = 20000
    expect(report.net_result_current).toBe(20000)
    expect(report.net_result_prior).toBe(0)
    expect(report.prior_period).toBeNull()
  })

  it('excludes the year-end closing entry from the trial balance (R01)', async () => {
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
        tb([makeRow({ account_number: '3001', account_class: 3, period_credit: 100000 })])
      )
      .mockResolvedValueOnce(
        tb([makeRow({ account_number: '3001', account_class: 3, period_credit: 80000 })])
      )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await generateResultatrapport(q.supabase as any, 'company-1', 'period-1')

    // Both the current AND the prior period trial balance must exclude the
    // year-end closing verifikat (which zeros classes 3–8 into 8999/2099).
    expect(mockTrialBalance).toHaveBeenCalledTimes(2)
    expect(mockTrialBalance).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      'company-1',
      'period-1',
      expect.objectContaining({ excludeYearEndClosing: true })
    )
    expect(mockTrialBalance).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'company-1',
      'period-0',
      expect.objectContaining({ excludeYearEndClosing: true })
    )
  })

  it('uses the period MOVEMENT, not the cumulative closing balance (R02)', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: { period_start: '2026-01-01', period_end: '2026-12-31', previous_period_id: null },
      error: null,
    })

    // A row where the YTD closing balance (120 000) differs from the window
    // movement (10 000): the report must show the movement.
    mockTrialBalance.mockResolvedValueOnce(
      tb([
        makeRow({
          account_number: '3001',
          account_name: 'Försäljning',
          account_class: 3,
          period_credit: 10000,
          closing_credit: 120000,
        }),
        makeRow({
          account_number: '5010',
          account_name: 'Lokalhyra',
          account_class: 5,
          period_debit: 4000,
          closing_debit: 48000,
        }),
      ])
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateResultatrapport(q.supabase as any, 'company-1', 'period-1')

    expect(report.groups[0].rows[0].current_period).toBe(10000)
    expect(report.groups[1].rows[0].current_period).toBe(-4000)
    expect(report.net_result_current).toBe(6000)
  })

  it('a sub-range (March) reflects only that month\'s movement and drops the prior column', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: { period_start: '2026-01-01', period_end: '2026-12-31', previous_period_id: 'period-0' },
      error: null,
    })

    // March movement only: 15 000 revenue, 5 000 rent — while the account
    // has accumulated much more YTD (closing_*).
    mockTrialBalance.mockResolvedValueOnce(
      tb([
        makeRow({
          account_number: '3001',
          account_name: 'Försäljning',
          account_class: 3,
          period_credit: 15000,
          closing_credit: 45000,
        }),
        makeRow({
          account_number: '5010',
          account_name: 'Lokalhyra',
          account_class: 5,
          period_debit: 5000,
          closing_debit: 15000,
        }),
      ])
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateResultatrapport(q.supabase as any, 'company-1', 'period-1', {
      fromDate: '2026-03-01',
      toDate: '2026-03-31',
    })

    // The date window is forwarded to the trial balance, still excluding
    // the year-end closing entry.
    expect(mockTrialBalance).toHaveBeenCalledTimes(1)
    expect(mockTrialBalance).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'period-1',
      { fromDate: '2026-03-01', toDate: '2026-03-31', excludeYearEndClosing: true }
    )

    // Only March's rörelser — never the cumulative YTD balance.
    expect(report.groups[0].rows[0].current_period).toBe(15000)
    expect(report.groups[1].rows[0].current_period).toBe(-5000)
    expect(report.net_result_current).toBe(10000)
    expect(report.period).toEqual({ start: '2026-03-01', end: '2026-03-31' })

    // A narrowed window drops the full-year prior comparison entirely.
    expect(report.prior_period).toBeNull()
    expect(report.net_result_prior).toBe(0)
    expect(report.groups[0].rows[0].prior_period).toBe(0)
  })

  it('report after year-end closing matches the pre-closing report', async () => {
    // Simulates excludeYearEndClosing: the trial balance the report consumes
    // is identical before and after the closing verifikat (which zeroed
    // classes 3–8 into 8999/2099), because the closing entry is filtered out.
    const preClosingRows = [
      makeRow({ account_number: '3001', account_name: 'Försäljning', account_class: 3, period_credit: 100000 }),
      makeRow({ account_number: '5010', account_name: 'Lokalhyra', account_class: 5, period_debit: 30000 }),
    ]

    const runReport = async () => {
      const q = createQueuedMockSupabase()
      q.enqueue({
        data: { period_start: '2026-01-01', period_end: '2026-12-31', previous_period_id: null },
        error: null,
      })
      mockTrialBalance.mockResolvedValueOnce(tb(preClosingRows.map((r) => ({ ...r }))))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return generateResultatrapport(q.supabase as any, 'company-1', 'period-1')
    }

    const before = await runReport()
    // After bokslut, generateTrialBalance({ excludeYearEndClosing: true })
    // returns the SAME P&L movements as before the closing entry.
    const after = await runReport()

    expect(after).toEqual(before)
    expect(after.net_result_current).toBe(70000)
    // Both invocations requested the year-end closing exclusion.
    for (const call of mockTrialBalance.mock.calls) {
      expect(call[3]).toEqual(expect.objectContaining({ excludeYearEndClosing: true }))
    }
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
          makeRow({ account_number: '3001', account_name: 'Försäljning', account_class: 3, period_credit: 200000 }),
          makeRow({ account_number: '5010', account_name: 'Lokalhyra', account_class: 5, period_debit: 60000 }),
        ])
      )
      .mockResolvedValueOnce(
        tb([
          makeRow({ account_number: '3001', account_name: 'Försäljning', account_class: 3, period_credit: 150000 }),
          makeRow({ account_number: '5010', account_name: 'Lokalhyra', account_class: 5, period_debit: 45000 }),
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
          makeRow({ account_number: '3001', account_name: 'Försäljning', account_class: 3, period_credit: 100000 }),
        ])
      )
      .mockResolvedValueOnce(
        tb([
          makeRow({ account_number: '3001', account_name: 'Försäljning', account_class: 3, period_credit: 80000 }),
          // Account discontinued this year
          makeRow({ account_number: '3002', account_name: 'Gammal intäkt', account_class: 3, period_credit: 5000 }),
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
        makeRow({ account_number: '3001', account_name: 'Revenue', account_class: 3, period_credit: 100000 }),
        makeRow({ account_number: '8999', account_name: 'Årets resultat', account_class: 8, period_debit: 100000 }),
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
        makeRow({ account_number: '1930', account_name: 'Bank', account_class: 1, period_debit: 50000 }),
        makeRow({ account_number: '2440', account_name: 'Lev.skuld', account_class: 2, period_credit: 10000 }),
        makeRow({ account_number: '3001', account_name: 'Revenue', account_class: 3, period_credit: 40000 }),
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
        makeRow({ account_number: '3001', account_name: 'Revenue', account_class: 3, period_credit: 50000 }),
        makeRow({ account_number: '3002', account_name: 'Tom rad', account_class: 3, period_credit: 0 }),
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
