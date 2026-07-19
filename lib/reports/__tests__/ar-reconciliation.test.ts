import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HistoricalOpenItem } from '@/lib/invoices/historical-open-items'
import type { TrialBalanceRow } from '@/types'

// The reconciliation now measures BOTH sides at the same date (A06):
//   - subledger: historically open invoices via getHistoricalOpenInvoices,
//   - GL: the CLOSING balance of 1510/1513 via generateTrialBalance(toDate).
// Both collaborators are mocked so the tests assert the comparison logic.
vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))
vi.mock('@/lib/invoices/historical-open-items', () => ({
  getHistoricalOpenInvoices: vi.fn(),
}))

import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { getHistoricalOpenInvoices } from '@/lib/invoices/historical-open-items'
import { generateARReconciliation } from '../ar-reconciliation'

const mockedTrialBalance = vi.mocked(generateTrialBalance)
const mockedOpenInvoices = vi.mocked(getHistoricalOpenInvoices)

// ============================================================
// Mock — sequential result queue for the direct supabase reads:
//   0: fiscal_periods (.single())
//   1: currency_revaluation_items (awaited chain)
// ============================================================

let resultIdx: number
let results: Array<{ data?: unknown; error?: unknown }>

function makeBuilder() {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'lte', 'not', 'order', 'range']) {
    b[m] = vi.fn().mockReturnValue(b)
  }
  b.single = vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null })
  b.then = (resolve: (v: unknown) => void) => resolve(results[resultIdx++] ?? { data: null, error: null })
  return b
}

function makeClient() {
  return {
    from: vi.fn().mockImplementation(() => makeBuilder()),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

const PERIOD_RESULT = {
  data: { period_start: '2024-01-01', period_end: '2024-12-31' },
  error: null,
}
const EMPTY_REVAL = { data: [], error: null }

function makeOpenItem(overrides: Partial<HistoricalOpenItem> = {}): HistoricalOpenItem {
  return {
    id: 'inv-1',
    type: 'invoice',
    reference: 'F-001',
    currency: 'SEK',
    exchange_rate: null,
    invoice_date: '2024-06-01',
    due_date: '2024-07-01',
    customer_id: 'cust-1',
    total: 1000,
    open_amount: 1000,
    current_status: 'sent',
    ...overrides,
  }
}

function tbRow(
  accountNumber: string,
  closing: { debit?: number; credit?: number }
): TrialBalanceRow {
  return {
    account_number: accountNumber,
    account_name: 'Testkonto',
    account_class: Number(accountNumber[0]),
    opening_debit: 0,
    opening_credit: 0,
    period_debit: 0,
    period_credit: 0,
    closing_debit: closing.debit ?? 0,
    closing_credit: closing.credit ?? 0,
  }
}

function mockTrialBalanceRows(rows: TrialBalanceRow[]) {
  mockedTrialBalance.mockResolvedValue({
    rows,
    totalDebit: 0,
    totalCredit: 0,
    isBalanced: true,
  })
}

let supabase: ReturnType<typeof makeClient>

beforeEach(() => {
  vi.clearAllMocks()
  resultIdx = 0
  results = [PERIOD_RESULT, EMPTY_REVAL]
  supabase = makeClient()
  mockedOpenInvoices.mockResolvedValue([])
  mockTrialBalanceRows([])
})

describe('generateARReconciliation', () => {
  it('returns reconciled when the AR subledger matches the 1510 closing balance', async () => {
    mockedOpenInvoices.mockResolvedValue([
      makeOpenItem({ id: 'inv-1', total: 5000, open_amount: 3000 }),
      makeOpenItem({ id: 'inv-2', total: 3000, open_amount: 3000 }),
    ])
    mockTrialBalanceRows([tbRow('1510', { debit: 8000, credit: 2000 })])

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    // AR: 3000 + 3000 = 6000
    expect(result.ar_ledger_total).toBe(6000)
    // 1510 closing: 8000 - 2000 = 6000
    expect(result.account_1510_balance).toBe(6000)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
    expect(result.fx_revaluation_adjustment).toBe(0)
  })

  it('detects difference when the AR subledger does not match account 1510', async () => {
    mockedOpenInvoices.mockResolvedValue([makeOpenItem({ open_amount: 5000, total: 5000 })])
    // Manual debit on 1510 creates the mismatch
    mockTrialBalanceRows([tbRow('1510', { debit: 6000 })])

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(5000)
    expect(result.account_1510_balance).toBe(6000)
    expect(result.difference).toBe(-1000)
    expect(result.is_reconciled).toBe(false)
  })

  it('returns zero balances when no data exists', async () => {
    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(0)
    expect(result.account_1510_balance).toBe(0)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })

  it('throws when the fiscal period cannot be read', async () => {
    results = [{ data: null, error: { message: 'not found' } }]

    await expect(
      generateARReconciliation(supabase, 'company-1', 'period-1')
    ).rejects.toThrow('Räkenskapsperioden kunde inte läsas: not found')
  })

  it('measures both sides at the explicit asOfDate when provided', async () => {
    const result = await generateARReconciliation(
      supabase,
      'company-1',
      'period-1',
      '2024-06-30'
    )

    expect(result.as_of_date).toBe('2024-06-30')
    expect(mockedOpenInvoices).toHaveBeenCalledWith(expect.anything(), 'company-1', '2024-06-30')
    expect(mockedTrialBalance).toHaveBeenCalledWith(expect.anything(), 'company-1', 'period-1', {
      toDate: '2024-06-30',
    })
  })

  it('defaults the reconciliation date to period_end for past periods and today for running periods', async () => {
    // Past period (period_end 2024-12-31 < today) → period_end
    const past = await generateARReconciliation(supabase, 'company-1', 'period-1')
    expect(past.as_of_date).toBe('2024-12-31')
    expect(mockedOpenInvoices).toHaveBeenCalledWith(expect.anything(), 'company-1', '2024-12-31')

    // Running period (period_end in the future) → today
    const today = new Date().toISOString().split('T')[0]
    resultIdx = 0
    results = [
      { data: { period_start: '2024-01-01', period_end: '2099-12-31' }, error: null },
      EMPTY_REVAL,
    ]
    const running = await generateARReconciliation(supabase, 'company-1', 'period-1')
    expect(running.as_of_date).toBe(today)
  })

  it('converts foreign-currency open amounts at the invoice exchange_rate before reconciliation', async () => {
    mockedOpenInvoices.mockResolvedValue([
      // 200 EUR open at rate 11 → 2 200 SEK
      makeOpenItem({ id: 'inv-1', currency: 'EUR', exchange_rate: 11, total: 225, open_amount: 200 }),
      // 1 000 SEK control
      makeOpenItem({ id: 'inv-2', total: 1000, open_amount: 1000 }),
    ])
    mockTrialBalanceRows([tbRow('1510', { debit: 3200 })])

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(3200)
    expect(result.account_1510_balance).toBe(3200)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
    expect(result.unconverted_fx_count).toBe(0)
  })

  it('excludes FX invoices without exchange_rate from the SEK total and counts them', async () => {
    mockedOpenInvoices.mockResolvedValue([
      makeOpenItem({ id: 'inv-1', currency: 'EUR', exchange_rate: null, total: 100, open_amount: 100 }),
      makeOpenItem({ id: 'inv-2', total: 500, open_amount: 500 }),
    ])
    mockTrialBalanceRows([tbRow('1510', { debit: 500 })])

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.unconverted_fx_count).toBe(1)
    // EUR row excluded → ledger total is just the SEK 500
    expect(result.ar_ledger_total).toBe(500)
    expect(result.account_1510_balance).toBe(500)
    // Numbers match, but the calculation is incomplete (a row was excluded);
    // BFL 5 kap requires the period not be stamped Avstämd until the missing
    // exchange rate is filled in.
    expect(result.is_reconciled).toBe(false)
  })

  it('adds posted FX revaluation adjustments to the subledger side (A08)', async () => {
    mockedOpenInvoices.mockResolvedValue([makeOpenItem({ total: 1000, open_amount: 1000 })])
    // A posted revaluation debited 1510 by 50 (unrealized gain), so the GL
    // balance includes it — the subledger side must too.
    results = [
      PERIOD_RESULT,
      { data: [{ unrealized_diff_sek: 50, invoice_id: 'inv-1' }], error: null },
    ]
    mockTrialBalanceRows([tbRow('1510', { debit: 1050 })])

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.fx_revaluation_adjustment).toBe(50)
    expect(result.ar_ledger_total).toBe(1050)
    expect(result.account_1510_balance).toBe(1050)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })

  it('throws when the revaluation snapshot cannot be read', async () => {
    results = [PERIOD_RESULT, { data: null, error: { message: 'boom' } }]

    await expect(
      generateARReconciliation(supabase, 'company-1', 'period-1')
    ).rejects.toThrow('Valutaomvärderingsunderlaget kunde inte läsas: boom')
  })

  it('uses the CLOSING debit-normal balance (closing_debit - closing_credit) for 1510', async () => {
    mockTrialBalanceRows([tbRow('1510', { debit: 10000, credit: 7000 })])

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.account_1510_balance).toBe(3000)
  })

  it('sums 1510 + 1513 in the GL balance for ROT/RUT fakturamodellen', async () => {
    // If a fakturamodellen invoice splits the AR receivable across 1510
    // (customer portion) and 1513 (Skatteverket claim), both must be included
    // to reconcile.
    mockedOpenInvoices.mockResolvedValue([makeOpenItem({ total: 1500, open_amount: 1500 })])
    mockTrialBalanceRows([
      tbRow('1510', { debit: 1200 }),
      tbRow('1513', { debit: 300 }),
    ])

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(1500)
    expect(result.account_1510_balance).toBe(1500)
    expect(result.is_reconciled).toBe(true)
  })

  it('uses Math.round for monetary precision', async () => {
    mockedOpenInvoices.mockResolvedValue([
      makeOpenItem({ total: 100.1, open_amount: 66.77 }),
    ])
    mockTrialBalanceRows([tbRow('1510', { debit: 66.77 })])

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(66.77)
    expect(result.account_1510_balance).toBe(66.77)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })
})
