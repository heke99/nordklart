import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { generateSupplierLedger } from '../supplier-ledger'

// ============================================================
// Table-routed mock supabase
//
// Without asOfDate the ledger reads current statuses/remaining amounts. With
// asOfDate the open set and amounts are reconstructed as of that date (A09):
// getHistoricalOpenSupplierInvoices queries `supplier_invoices` +
// `supplier_invoice_payments` (filtered by date, paginated via .range), and
// the ledger then re-fetches `supplier_invoices` by the historical id set.
// The mock routes .from(table) to per-table fixtures and applies the filters
// for real so the date cutoffs are tested.
// ============================================================

type Row = Record<string, unknown>

function buildTableChain(rows: Row[], errorMessage?: string) {
  let filtered = [...rows]
  let rangeFrom = 0
  let rangeTo: number | null = null

  const chain: Record<string, unknown> = {}
  chain.select = vi.fn().mockReturnValue(chain)
  chain.order = vi.fn().mockReturnValue(chain)
  chain.eq = vi.fn().mockImplementation((col: string, val: unknown) => {
    filtered = filtered.filter((r) => r[col] === val)
    return chain
  })
  chain.neq = vi.fn().mockImplementation((col: string, val: unknown) => {
    filtered = filtered.filter((r) => r[col] !== val)
    return chain
  })
  chain.lte = vi.fn().mockImplementation((col: string, val: unknown) => {
    filtered = filtered.filter((r) => r[col] != null && String(r[col]) <= String(val))
    return chain
  })
  chain.in = vi.fn().mockImplementation((col: string, vals: unknown[]) => {
    filtered = filtered.filter((r) => vals.includes(r[col]))
    return chain
  })
  chain.range = vi.fn().mockImplementation((from: number, to: number) => {
    rangeFrom = from
    rangeTo = to
    return chain
  })
  chain.then = (resolve: (v: unknown) => void) => {
    if (errorMessage) {
      resolve({ data: null, error: { message: errorMessage } })
      return
    }
    const sliced = rangeTo == null ? filtered : filtered.slice(rangeFrom, rangeTo + 1)
    resolve({ data: sliced, error: null })
  }
  return chain
}

function makeClient(config: {
  supplierInvoices?: Row[]
  supplierInvoicePayments?: Row[]
  errors?: Partial<Record<string, string>>
}) {
  const tables: Record<string, Row[]> = {
    supplier_invoices: config.supplierInvoices ?? [],
    supplier_invoice_payments: (config.supplierInvoicePayments ?? []).map((p) => ({
      company_id: 'company-1',
      ...p,
    })),
  }
  return {
    from: vi
      .fn()
      .mockImplementation((table: string) =>
        buildTableChain(tables[table] ?? [], config.errors?.[table])
      ),
  } as unknown as SupabaseClient
}

let siCounter = 0

/** Supplier invoice row with the columns both ledger paths read. */
function siRow(overrides: Row = {}): Row {
  return {
    id: `si-${++siCounter}`,
    company_id: 'company-1',
    supplier_id: 'sup-1',
    supplier: { id: 'sup-1', name: 'Leverantör A' },
    supplier_invoice_number: 'LF-001',
    invoice_date: '2024-01-15',
    due_date: '2024-06-01',
    status: 'registered',
    currency: 'SEK',
    exchange_rate: null,
    total: 1000,
    is_credit_note: false,
    credited_invoice_id: null,
    reversed_at: null,
    ...overrides,
  }
}

describe('generateSupplierLedger', () => {
  describe('current ledger (no asOfDate)', () => {
    it('returns empty report when no invoices found', async () => {
      const supabase = makeClient({})

      const report = await generateSupplierLedger(supabase, 'company-1')
      expect(report.entries).toEqual([])
      expect(report.total_outstanding).toBe(0)
      expect(report.total_current).toBe(0)
      expect(report.total_overdue).toBe(0)
      expect(report.unpaid_count).toBe(0)
    })

    it('throws on query error instead of returning an empty zero report (A10)', async () => {
      const supabase = makeClient({ errors: { supplier_invoices: 'DB error' } })

      await expect(generateSupplierLedger(supabase, 'company-1')).rejects.toThrow(
        'Leverantörsreskontran kunde inte läsas: DB error'
      )
    })

    it('uses current remaining_amount and open statuses', async () => {
      const supabase = makeClient({
        supplierInvoices: [
          siRow({
            status: 'partially_paid',
            due_date: '2099-01-01', // far future → always "current"
            total: 10000,
            remaining_amount: 2500,
          }),
          // Paid invoices are not part of the current open set
          siRow({ status: 'paid', total: 5000, remaining_amount: 0 }),
        ],
      })

      const report = await generateSupplierLedger(supabase, 'company-1')

      expect(report.entries).toHaveLength(1)
      expect(report.entries[0].current).toBe(2500)
      expect(report.total_outstanding).toBe(2500)
      expect(report.unpaid_count).toBe(1)
    })
  })

  describe('historical ledger (with asOfDate, A09)', () => {
    it('throws on query error instead of returning an empty zero report (A10)', async () => {
      const supabase = makeClient({ errors: { supplier_invoices: 'DB error' } })

      await expect(generateSupplierLedger(supabase, 'company-1', '2024-06-15')).rejects.toThrow(
        'DB error'
      )
    })

    it('places invoices in correct aging buckets', async () => {
      // Reference date: 2024-06-15
      const asOfDate = '2024-06-15'

      const supabase = makeClient({
        supplierInvoices: [
          // Current: due in the future (days overdue <= 0)
          siRow({ due_date: '2024-06-20', total: 5000 }),
          // 1-30 days overdue: due_date 2024-06-01 (14 days overdue)
          siRow({ due_date: '2024-06-01', total: 3000 }),
          // 31-60 days overdue: due_date 2024-05-01 (45 days overdue)
          siRow({ due_date: '2024-05-01', total: 2000 }),
          // 61-90 days overdue: due_date 2024-04-01 (75 days overdue)
          siRow({ due_date: '2024-04-01', total: 1500 }),
          // 90+ days overdue: due_date 2024-02-01 (135 days overdue)
          siRow({ due_date: '2024-02-01', total: 1000 }),
        ],
      })

      const report = await generateSupplierLedger(supabase, 'company-1', asOfDate)

      expect(report.entries).toHaveLength(1)
      const entry = report.entries[0]
      expect(entry.current).toBe(5000)
      expect(entry.days_1_30).toBe(3000)
      expect(entry.days_31_60).toBe(2000)
      expect(entry.days_61_90).toBe(1500)
      expect(entry.days_90_plus).toBe(1000)
      expect(entry.total_outstanding).toBe(12500)
    })

    it('reconstructs the historically open amount from payments on or before the date', async () => {
      const supabase = makeClient({
        supplierInvoices: [
          siRow({ id: 'si-partial', due_date: '2024-07-01', total: 10000 }),
        ],
        supplierInvoicePayments: [
          { supplier_invoice_id: 'si-partial', payment_date: '2024-06-10', amount: 4000 },
        ],
      })

      const report = await generateSupplierLedger(supabase, 'company-1', '2024-06-15')

      expect(report.entries).toHaveLength(1)
      expect(report.entries[0].total_outstanding).toBe(6000)
    })

    it('ignores payments made after the asOfDate — the invoice is still open in the snapshot', async () => {
      const supabase = makeClient({
        supplierInvoices: [
          siRow({
            id: 'si-later-paid',
            status: 'paid', // settled later — but open on the snapshot date
            due_date: '2024-07-01',
            total: 10000,
          }),
        ],
        supplierInvoicePayments: [
          { supplier_invoice_id: 'si-later-paid', payment_date: '2024-07-05', amount: 10000 },
        ],
      })

      const report = await generateSupplierLedger(supabase, 'company-1', '2024-06-15')

      expect(report.entries).toHaveLength(1)
      expect(report.entries[0].total_outstanding).toBe(10000)
    })

    it('excludes supplier invoices created after the asOfDate', async () => {
      const supabase = makeClient({
        supplierInvoices: [
          siRow({ invoice_date: '2024-07-01', due_date: '2024-08-01', total: 5000 }),
        ],
      })

      const report = await generateSupplierLedger(supabase, 'company-1', '2024-06-15')

      expect(report.entries).toEqual([])
      expect(report.total_outstanding).toBe(0)
      expect(report.unpaid_count).toBe(0)
    })

    it('groups by supplier and uses fallback name for missing supplier', async () => {
      const supabase = makeClient({
        supplierInvoices: [
          siRow({
            supplier_id: 'sup-1',
            supplier: { id: 'sup-1', name: 'Leverantör A' },
            due_date: '2024-07-01',
            total: 5000,
          }),
          siRow({
            supplier_id: 'sup-2',
            supplier: null,
            due_date: '2024-07-01',
            total: 3000,
          }),
        ],
      })

      const report = await generateSupplierLedger(supabase, 'company-1', '2024-06-15')

      expect(report.entries).toHaveLength(2)
      const names = report.entries.map(e => e.supplier_name)
      expect(names).toContain('Leverantör A')
      expect(names).toContain('Okänd leverantör')
    })

    it('sorts entries by outstanding descending', async () => {
      const supabase = makeClient({
        supplierInvoices: [
          siRow({
            supplier_id: 'sup-1',
            supplier: { id: 'sup-1', name: 'Small' },
            due_date: '2024-07-01',
            total: 1000,
          }),
          siRow({
            supplier_id: 'sup-2',
            supplier: { id: 'sup-2', name: 'Large' },
            due_date: '2024-07-01',
            total: 10000,
          }),
          siRow({
            supplier_id: 'sup-3',
            supplier: { id: 'sup-3', name: 'Medium' },
            due_date: '2024-07-01',
            total: 5000,
          }),
        ],
      })

      const report = await generateSupplierLedger(supabase, 'company-1', '2024-06-15')

      expect(report.entries[0].supplier_name).toBe('Large')
      expect(report.entries[1].supplier_name).toBe('Medium')
      expect(report.entries[2].supplier_name).toBe('Small')
    })

    it('calculates grand totals correctly', async () => {
      const supabase = makeClient({
        supplierInvoices: [
          // Supplier A: current 5000
          siRow({
            supplier_id: 'sup-1',
            supplier: { id: 'sup-1', name: 'A' },
            due_date: '2024-07-01',
            total: 5000,
          }),
          // Supplier B: 1-30 days overdue 3000
          siRow({
            supplier_id: 'sup-2',
            supplier: { id: 'sup-2', name: 'B' },
            due_date: '2024-06-01',
            total: 3000,
          }),
        ],
      })

      const report = await generateSupplierLedger(supabase, 'company-1', '2024-06-15')

      expect(report.total_outstanding).toBe(8000)
      expect(report.total_current).toBe(5000)
      expect(report.total_overdue).toBe(3000) // outstanding - current
      expect(report.unpaid_count).toBe(2)
    })

    it('converts foreign-currency invoices to SEK using exchange_rate', async () => {
      // Reproduces the production bug: EUR/USD invoices were summed as if SEK,
      // making the ledger total drift from the 2440 GL balance.
      const supabase = makeClient({
        supplierInvoices: [
          // 225 EUR at 11.00 → 2 475 SEK
          siRow({
            supplier_id: 'sup-1',
            supplier: { id: 'sup-1', name: 'Anthropic' },
            due_date: '2024-06-01',
            total: 225,
            currency: 'EUR',
            exchange_rate: 11,
          }),
          // 6.25 USD at 10.00 → 62.50 SEK
          siRow({
            supplier_id: 'sup-1',
            supplier: { id: 'sup-1', name: 'Anthropic' },
            due_date: '2024-06-01',
            total: 6.25,
            currency: 'USD',
            exchange_rate: 10,
          }),
          // 1 000 SEK (no conversion)
          siRow({
            supplier_id: 'sup-2',
            supplier: { id: 'sup-2', name: 'Svensk leverantör' },
            due_date: '2024-06-01',
            total: 1000,
          }),
        ],
      })

      const report = await generateSupplierLedger(supabase, 'company-1', '2024-06-15')

      // Anthropic: 2 475 + 62.50 = 2 537.50 SEK (all in 1-30 days bucket)
      const anthropic = report.entries.find(e => e.supplier_name === 'Anthropic')!
      expect(anthropic.days_1_30).toBe(2537.5)
      expect(anthropic.total_outstanding).toBe(2537.5)

      // Swedish supplier unchanged
      const swedish = report.entries.find(e => e.supplier_name === 'Svensk leverantör')!
      expect(swedish.days_1_30).toBe(1000)

      // Grand total in SEK: 2 537.50 + 1 000 = 3 537.50
      expect(report.total_outstanding).toBe(3537.5)
    })

    it('excludes FX invoices without exchange_rate from totals and counts them', async () => {
      // Legacy data: an FX invoice without an exchange rate cannot be converted
      // to SEK without falsifying the total. The row is excluded from sums and
      // surfaced via unconverted_fx_count so the UI can warn the user.
      const supabase = makeClient({
        supplierInvoices: [
          siRow({
            supplier_id: 'sup-1',
            supplier: { id: 'sup-1', name: 'Legacy' },
            due_date: '2024-06-01',
            total: 100,
            currency: 'EUR',
            exchange_rate: null,
          }),
          siRow({
            supplier_id: 'sup-2',
            supplier: { id: 'sup-2', name: 'SEK supplier' },
            due_date: '2024-06-01',
            total: 500,
          }),
        ],
      })

      const report = await generateSupplierLedger(supabase, 'company-1', '2024-06-15')
      expect(report.total_outstanding).toBe(500)
      expect(report.unconverted_fx_count).toBe(1)
      expect(report.entries.map(e => e.supplier_name)).toEqual(['SEK supplier'])
    })

    it('uses Math.round for monetary precision', async () => {
      const supabase = makeClient({
        supplierInvoices: [
          siRow({ due_date: '2024-07-01', total: 33.33 }),
          siRow({ due_date: '2024-07-02', total: 33.33 }),
          siRow({ due_date: '2024-07-03', total: 33.34 }),
        ],
      })

      const report = await generateSupplierLedger(supabase, 'company-1', '2024-06-15')

      expect(report.total_outstanding).toBe(100)
      expect(report.total_current).toBe(100)
    })
  })
})
