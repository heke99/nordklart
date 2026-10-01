import { describe, it, expect, vi } from 'vitest'
import {
  applySuggestion,
  proposalIsComplete,
  quickApproveBlockers,
  suggestAccountsForSupplier,
  type AccountSuggestion,
} from '../booking-proposal'

function chain(result: { data: unknown }) {
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'order', 'limit']) c[m] = vi.fn().mockReturnValue(c)
  c.maybeSingle = vi.fn().mockResolvedValue(result)
  c.then = (resolve: (v: unknown) => void) => resolve(result)
  return c
}

function fakeSupabase(supplier: unknown, lines: unknown[]) {
  const supplierChain = chain({ data: supplier })
  const linesChain = chain({ data: lines })
  return {
    client: { from: vi.fn((table: string) => (table === 'suppliers' ? supplierChain : linesChain)) },
    supplierChain,
    linesChain,
  }
}

const line = (account_number: string, vat_rate: number, invoice_date = '2026-05-01') => ({
  account_number,
  vat_rate,
  supplier_invoices: { invoice_date },
})

const SUPPLIER = {
  name: 'Kontorsgrossisten AB',
  supplier_type: 'swedish_business',
  default_payment_terms: 30,
  default_expense_account: '6110',
}

describe('suggestAccountsForSupplier', () => {
  it('picks the most used account per VAT rate and overall, scoped to company and supplier', async () => {
    const { client, linesChain, supplierChain } = fakeSupabase(SUPPLIER, [
      line('5410', 0.25),
      line('5410', 0.25),
      line('6110', 0.25),
      line('6110', 0.25, '2026-06-01'),
      line('6110', 0.25, '2026-06-01'),
      line('5460', 0.12),
    ])
    const s = await suggestAccountsForSupplier(client as never, 'company-1', 'supplier-1')
    expect(s.byVatRate).toEqual({ '0.25': '6110', '0.12': '5460' })
    expect(s.primary).toBe('6110')
    expect(s.primarySource).toBe('history_any_rate')
    expect(s.historyLines).toBe(6)
    expect(s.supplier).toEqual({ name: 'Kontorsgrossisten AB', supplierType: 'swedish_business', defaultPaymentTerms: 30 })
    expect(supplierChain.eq).toHaveBeenCalledWith('company_id', 'company-1')
    expect(linesChain.eq).toHaveBeenCalledWith('supplier_invoices.company_id', 'company-1')
    expect(linesChain.eq).toHaveBeenCalledWith('supplier_invoices.supplier_id', 'supplier-1')
  })

  it('breaks a tie by the most recent invoice', async () => {
    const { client } = fakeSupabase(SUPPLIER, [line('5410', 0.25, '2026-01-01'), line('6110', 0.25, '2026-03-01')])
    const s = await suggestAccountsForSupplier(client as never, 'company-1', 'supplier-1')
    expect(s.byVatRate['0.25']).toBe('6110')
  })

  it('ignores lines that are not expense accounts (class 4–7)', async () => {
    const { client } = fakeSupabase(SUPPLIER, [line('2440', 0.25), line('1930', 0.25)])
    const s = await suggestAccountsForSupplier(client as never, 'company-1', 'supplier-1')
    expect(s.byVatRate).toEqual({})
    expect(s.primary).toBe('6110')
    expect(s.primarySource).toBe('supplier_default')
  })

  it('proposes nothing without history or a default account', async () => {
    const { client } = fakeSupabase({ ...SUPPLIER, default_expense_account: null }, [])
    const s = await suggestAccountsForSupplier(client as never, 'company-1', 'supplier-1')
    expect(s.primary).toBeNull()
    expect(s.primarySource).toBeNull()
  })

  it('returns no supplier when it belongs to another company', async () => {
    const { client } = fakeSupabase(null, [])
    const s = await suggestAccountsForSupplier(client as never, 'company-1', 'supplier-x')
    expect(s.supplier).toBeNull()
    expect(s.primary).toBeNull()
  })
})

const suggestion: AccountSuggestion = {
  byVatRate: { '0.25': '6110' },
  primary: '5410',
  primarySource: 'history_any_rate',
  historyLines: 3,
  supplier: null,
}

describe('applySuggestion', () => {
  it('uses the exact-rate account, then the primary account, and rounds to öre', () => {
    const lines = applySuggestion(
      [
        { description: 'Papper', amount: 100.004, vatRate: 0.25 },
        { description: 'Böcker', amount: 50, vatRate: 0.06 },
      ],
      suggestion,
    )
    expect(lines).toEqual([
      { description: 'Papper', amount: 100, vatRate: 0.25, accountNumber: '6110', source: 'history' },
      { description: 'Böcker', amount: 50, vatRate: 0.06, accountNumber: '5410', source: 'history_any_rate' },
    ])
  })

  it('leaves the account empty when there is nothing to propose', () => {
    const [l] = applySuggestion([{ description: 'X', amount: 1, vatRate: 0.12 }], {
      ...suggestion,
      byVatRate: {},
      primary: null,
      primarySource: null,
    })
    expect(l.accountNumber).toBeNull()
    expect(l.source).toBeNull()
    expect(proposalIsComplete([l])).toBe(false)
  })
})

describe('quickApproveBlockers', () => {
  const base = {
    lines: applySuggestion([{ description: 'Papper', amount: 800, vatRate: 0.25 }], suggestion),
    supplierType: 'swedish_business',
    currency: 'SEK',
    invoiceNumber: 'F-1001',
    invoiceDate: '2026-09-01',
    dueDate: '2026-10-01',
    extractedTotal: 1000,
  }

  it('allows a plain domestic invoice whose lines match the total', () => {
    expect(quickApproveBlockers(base)).toEqual([])
  })

  it('tolerates öre rounding up to 1 kr', () => {
    expect(quickApproveBlockers({ ...base, extractedTotal: 1000.9 })).toEqual([])
    expect(quickApproveBlockers({ ...base, extractedTotal: 1002 })).toEqual(['totals_mismatch'])
  })

  it('requires the full editor for reverse charge, foreign currency and representation', () => {
    expect(quickApproveBlockers({ ...base, supplierType: 'eu_business' })).toContain('foreign_supplier')
    expect(quickApproveBlockers({ ...base, supplierType: 'non_eu_business' })).toContain('foreign_supplier')
    expect(quickApproveBlockers({ ...base, currency: 'EUR' })).toContain('foreign_currency')
    const representation = applySuggestion([{ description: 'Lunch', amount: 800, vatRate: 0.25 }], {
      ...suggestion,
      byVatRate: { '0.25': '6071' },
    })
    expect(quickApproveBlockers({ ...base, lines: representation })).toContain('representation')
  })

  it('requires invoice number, both dates, a known total and accounts on every line', () => {
    expect(
      quickApproveBlockers({ ...base, invoiceNumber: null, dueDate: null, extractedTotal: null, lines: [] }),
    ).toEqual(['incomplete_accounts', 'missing_invoice_number', 'missing_dates', 'totals_mismatch'])
  })
})
