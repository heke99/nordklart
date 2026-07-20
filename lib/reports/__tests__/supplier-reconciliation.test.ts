import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HistoricalOpenItem } from '@/lib/invoices/historical-open-items'
import type { TrialBalanceRow } from '@/types'

// The reconciliation now measures BOTH sides at the same date (A06):
//   - subledger: historically open supplier invoices via
//     getHistoricalOpenSupplierInvoices,
//   - GL: the CLOSING balance of 2440 (credit-normal) via
//     generateTrialBalance(toDate).
// Both collaborators are mocked so the tests assert the comparison logic.
vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))
vi.mock('@/lib/invoices/historical-open-items', () => ({
  getHistoricalOpenSupplierInvoices: vi.fn(),
}))

import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { getHistoricalOpenSupplierInvoices } from '@/lib/invoices/historical-open-items'
import { generateReconciliation } from '../supplier-reconciliation'

const mockedTrialBalance = vi.mocked(generateTrialBalance)
const mockedOpenSupplierInvoices = vi.mocked(getHistoricalOpenSupplierInvoices)

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
    id: 'si-1',
    type: 'supplier_invoice',
    reference: 'LF-001',
    currency: 'SEK',
    exchange_rate: null,
    invoice_date: '2024-06-01',
    due_date: '2024-07-01',
    supplier_id: 'sup-1',
    total: 1000,
    open_amount: 1000,
    current_status: 'registered',
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
  mockedOpenSupplierInvoices.mockResolvedValue([])
  mockTrialBalanceRows([])
})

describe('generateReconciliation', () => {
  it('returns reconciled when the supplier subledger matches the 2440 closing balance', async () => {
    mockedOpenSupplierInvoices.mockResolvedValue([
      makeOpenItem({ id: 'si-1', total: 5000, open_amount: 5000 }),
      makeOpenItem({ id: 'si-2', total: 3000, open_amount: 3000 }),
    ])
    mockTrialBalanceRows([tbRow('2440', { credit: 10000, debit: 2000 })])

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    // Supplier total: 5000 + 3000 = 8000
    expect(result.supplier_ledger_total).toBe(8000)
    // Account 2440 (credit-normal) closing: credits - debits = 10000 - 2000 = 8000
    expect(result.account_2440_balance).toBe(8000)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
    expect(result.fx_revaluation_adjustment).toBe(0)
  })

  it('detects mismatch when difference != 0', async () => {
    mockedOpenSupplierInvoices.mockResolvedValue([
      makeOpenItem({ total: 5000, open_amount: 5000 }),
    ])
    mockTrialBalanceRows([tbRow('2440', { credit: 7000 })])

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    expect(result.supplier_ledger_total).toBe(5000)
    expect(result.account_2440_balance).toBe(7000)
    expect(result.difference).toBe(-2000)
    expect(result.is_reconciled).toBe(false)
  })

  it('returns reconciled when both are zero/empty', async () => {
    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    expect(result.supplier_ledger_total).toBe(0)
    expect(result.account_2440_balance).toBe(0)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })

  it('throws when the fiscal period cannot be read', async () => {
    results = [{ data: null, error: { message: 'not found' } }]

    await expect(
      generateReconciliation(supabase, 'company-1', 'period-1')
    ).rejects.toThrow('Räkenskapsperioden kunde inte läsas: not found')
  })

  it('measures both sides at the explicit asOfDate when provided', async () => {
    const result = await generateReconciliation(
      supabase,
      'company-1',
      'period-1',
      '2024-06-30'
    )

    expect(result.as_of_date).toBe('2024-06-30')
    expect(mockedOpenSupplierInvoices).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      '2024-06-30'
    )
    expect(mockedTrialBalance).toHaveBeenCalledWith(expect.anything(), 'company-1', 'period-1', {
      toDate: '2024-06-30',
    })
  })

  it('defaults the reconciliation date to period_end for past periods and today for running periods', async () => {
    // Past period (period_end 2024-12-31 < today) → period_end
    const past = await generateReconciliation(supabase, 'company-1', 'period-1')
    expect(past.as_of_date).toBe('2024-12-31')
    expect(mockedOpenSupplierInvoices).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      '2024-12-31'
    )

    // Running period (period_end in the future) → today
    const today = new Date().toISOString().split('T')[0]
    resultIdx = 0
    results = [
      { data: { period_start: '2024-01-01', period_end: '2099-12-31' }, error: null },
      EMPTY_REVAL,
    ]
    const running = await generateReconciliation(supabase, 'company-1', 'period-1')
    expect(running.as_of_date).toBe(today)
  })

  it('computes the CLOSING credit-normal balance for account 2440 (liability)', async () => {
    mockTrialBalanceRows([tbRow('2440', { credit: 15000, debit: 8000 })])

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    // Balance = closing credits - closing debits = 15000 - 8000 = 7000
    expect(result.account_2440_balance).toBe(7000)
  })

  it('converts foreign-currency open amounts at the invoice exchange_rate before reconciliation', async () => {
    // Reproduces the production bug: 225 EUR + 1 000 SEK was reported as 1 225
    // against a 2440 balance of 3 475, flagging a false discrepancy.
    mockedOpenSupplierInvoices.mockResolvedValue([
      makeOpenItem({ id: 'si-1', currency: 'EUR', exchange_rate: 11, total: 225, open_amount: 225 }),
      makeOpenItem({ id: 'si-2', total: 1000, open_amount: 1000 }),
    ])
    mockTrialBalanceRows([tbRow('2440', { credit: 3475 })])

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    expect(result.supplier_ledger_total).toBe(3475)
    expect(result.account_2440_balance).toBe(3475)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
    expect(result.unconverted_fx_count).toBe(0)
  })

  it('excludes FX invoices without exchange_rate from the SEK total and counts them', async () => {
    // An FX invoice without an exchange rate cannot be converted to SEK; the
    // sum must not silently add raw foreign currency. The row is excluded and
    // counted, so the UI can warn that the reconciliation may be unreliable.
    mockedOpenSupplierInvoices.mockResolvedValue([
      makeOpenItem({ id: 'si-1', currency: 'EUR', exchange_rate: null, total: 100, open_amount: 100 }),
      makeOpenItem({ id: 'si-2', total: 1000, open_amount: 1000 }),
    ])
    mockTrialBalanceRows([tbRow('2440', { credit: 1000 })])

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    expect(result.unconverted_fx_count).toBe(1)
    // EUR row excluded → ledger total is just the SEK 1 000
    expect(result.supplier_ledger_total).toBe(1000)
    expect(result.account_2440_balance).toBe(1000)
    // Numbers match, but the calculation is incomplete (a row was excluded);
    // BFL 5 kap requires the period not be stamped Avstämd until the missing
    // exchange rate is filled in.
    expect(result.is_reconciled).toBe(false)
  })

  it('adds posted FX revaluation adjustments to the subledger side (A08)', async () => {
    mockedOpenSupplierInvoices.mockResolvedValue([
      makeOpenItem({ total: 1000, open_amount: 1000 }),
    ])
    // A posted revaluation grew the liability by 50 (positive
    // unrealized_diff_sek credits 2440), so the GL balance includes it — the
    // subledger side must too.
    results = [
      PERIOD_RESULT,
      { data: [{ unrealized_diff_sek: 50, supplier_invoice_id: 'si-1' }], error: null },
    ]
    mockTrialBalanceRows([tbRow('2440', { credit: 1050 })])

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    expect(result.fx_revaluation_adjustment).toBe(50)
    expect(result.supplier_ledger_total).toBe(1050)
    expect(result.account_2440_balance).toBe(1050)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })

  it('throws when the revaluation snapshot cannot be read', async () => {
    results = [PERIOD_RESULT, { data: null, error: { message: 'boom' } }]

    await expect(
      generateReconciliation(supabase, 'company-1', 'period-1')
    ).rejects.toThrow('Valutaomvärderingsunderlaget kunde inte läsas: boom')
  })

  it('uses Math.round for monetary precision', async () => {
    mockedOpenSupplierInvoices.mockResolvedValue([
      makeOpenItem({ id: 'si-1', total: 33.33, open_amount: 33.33 }),
      makeOpenItem({ id: 'si-2', total: 33.34, open_amount: 33.34 }),
    ])
    mockTrialBalanceRows([tbRow('2440', { credit: 66.67 })])

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    expect(result.supplier_ledger_total).toBe(66.67)
    expect(result.account_2440_balance).toBe(66.67)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })
})
