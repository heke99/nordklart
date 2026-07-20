import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { generateARLedger } from '../ar-ledger'

// ============================================================
// Table-routed mock supabase
//
// Without asOfDate the ledger reads current statuses/remaining amounts from
// `invoices`. With asOfDate it reconstructs the HISTORICAL snapshot (A09)
// through lib/invoices/historical-open-items.ts — `invoices` +
// `invoice_payments` filtered by date, plus a `customers` lookup — all
// paginated via .range(from, to). The mock routes .from(table) to per-table
// fixtures and applies the filters for real so the date cutoffs are tested.
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
  chain.not = vi.fn().mockImplementation((col: string, op: string, val: unknown) => {
    if (op === 'in') {
      const excluded = String(val).replace(/[()"]/g, '').split(',')
      filtered = filtered.filter((r) => !excluded.includes(String(r[col])))
    } else if (op === 'is') {
      filtered = filtered.filter((r) => r[col] != null)
    }
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
  invoices?: Row[]
  invoicePayments?: Row[]
  customers?: Row[]
  errors?: Partial<Record<string, string>>
}) {
  const tables: Record<string, Row[]> = {
    invoices: config.invoices ?? [],
    invoice_payments: (config.invoicePayments ?? []).map((p) => ({
      company_id: 'company-1',
      ...p,
    })),
    customers: (config.customers ?? []).map((c) => ({ company_id: 'company-1', ...c })),
  }
  return {
    from: vi
      .fn()
      .mockImplementation((table: string) =>
        buildTableChain(tables[table] ?? [], config.errors?.[table])
      ),
  } as unknown as SupabaseClient
}

/** Invoice row with the columns both ledger paths read. */
function invoiceRow(overrides: Row = {}): Row {
  return {
    id: 'inv-1',
    company_id: 'company-1',
    customer_id: 'cust-a',
    customer: { id: 'cust-a', name: 'Test AB' },
    invoice_number: 'F001',
    external_invoice_number: null,
    invoice_date: '2024-05-01',
    due_date: '2024-06-01',
    status: 'sent',
    currency: 'SEK',
    exchange_rate: null,
    total: 1000,
    paid_amount: 0,
    credited_invoice_id: null,
    written_off_at: null,
    ...overrides,
  }
}

describe('generateARLedger', () => {
  describe('current ledger (no asOfDate)', () => {
    it('returns empty report when no invoices found', async () => {
      const supabase = makeClient({})

      const report = await generateARLedger(supabase, 'company-1')
      expect(report.entries).toEqual([])
      expect(report.total_outstanding).toBe(0)
      expect(report.unpaid_count).toBe(0)
    })

    it('throws on query error instead of returning an empty zero report (A10)', async () => {
      const supabase = makeClient({ errors: { invoices: 'DB error' } })

      await expect(generateARLedger(supabase, 'company-1')).rejects.toThrow(
        'Kundreskontran kunde inte läsas: DB error'
      )
    })

    it('uses current remaining_amount and open statuses', async () => {
      const supabase = makeClient({
        invoices: [
          invoiceRow({
            id: 'inv-1',
            status: 'partially_paid',
            due_date: '2099-01-01', // far future → always "current"
            total: 10000,
            paid_amount: 7500,
            remaining_amount: 2500,
          }),
          // Paid invoices are not part of the current open set
          invoiceRow({ id: 'inv-2', status: 'paid', total: 5000, remaining_amount: 0 }),
        ],
      })

      const report = await generateARLedger(supabase, 'company-1')

      expect(report.entries).toHaveLength(1)
      expect(report.entries[0].invoices).toHaveLength(1)
      expect(report.entries[0].invoices[0].outstanding).toBe(2500)
      expect(report.entries[0].current).toBe(2500)
      expect(report.total_outstanding).toBe(2500)
    })
  })

  describe('historical ledger (with asOfDate, A09)', () => {
    it('throws on query error instead of returning an empty zero report (A10)', async () => {
      const supabase = makeClient({ errors: { invoices: 'DB error' } })

      await expect(generateARLedger(supabase, 'company-1', '2024-06-15')).rejects.toThrow(
        'DB error'
      )
    })

    it('groups invoices by customer with correct aging buckets', async () => {
      // Reference date: 2024-06-15
      const asOfDate = '2024-06-15'

      const supabase = makeClient({
        invoices: [
          // Customer A: one current, one 1-30 days overdue
          invoiceRow({
            id: 'inv-1',
            customer_id: 'cust-a',
            invoice_number: 'F001',
            invoice_date: '2024-05-01',
            due_date: '2024-06-20', // not yet due
            total: 5000,
          }),
          invoiceRow({
            id: 'inv-2',
            customer_id: 'cust-a',
            invoice_number: 'F002',
            invoice_date: '2024-04-01',
            due_date: '2024-06-01', // 14 days overdue
            total: 3000,
            status: 'overdue',
          }),
          // Customer B: 90+ days overdue
          invoiceRow({
            id: 'inv-3',
            customer_id: 'cust-b',
            invoice_number: 'F003',
            invoice_date: '2024-01-01',
            due_date: '2024-02-01', // 135 days overdue
            total: 10000,
            status: 'overdue',
          }),
        ],
        invoicePayments: [
          // inv-2 partially paid before the snapshot date
          { invoice_id: 'inv-2', payment_date: '2024-06-10', amount: 1000 },
        ],
        customers: [
          { id: 'cust-a', name: 'Acme AB' },
          { id: 'cust-b', name: 'Beta Corp' },
        ],
      })

      const report = await generateARLedger(supabase, 'company-1', asOfDate)

      expect(report.unpaid_count).toBe(3)
      expect(report.entries).toHaveLength(2)

      // Sorted by total outstanding descending: Beta Corp (10000), then Acme (7000)
      expect(report.entries[0].customer_name).toBe('Beta Corp')
      expect(report.entries[0].total_outstanding).toBe(10000)
      expect(report.entries[0].days_90_plus).toBe(10000)

      expect(report.entries[1].customer_name).toBe('Acme AB')
      expect(report.entries[1].total_outstanding).toBe(7000)
      expect(report.entries[1].current).toBe(5000)     // inv-1
      expect(report.entries[1].days_1_30).toBe(2000)    // inv-2 (3000 - 1000 paid)
      expect(report.entries[1].invoices).toHaveLength(2)

      // Totals
      expect(report.total_outstanding).toBe(17000)
      expect(report.total_current).toBe(5000)
      expect(report.total_overdue).toBe(12000)
    })

    it('reconstructs outstanding from payments made on or before the asOfDate', async () => {
      const supabase = makeClient({
        invoices: [
          invoiceRow({
            id: 'inv-1',
            invoice_date: '2024-06-01',
            due_date: '2024-07-01',
            total: 10000,
          }),
        ],
        invoicePayments: [{ invoice_id: 'inv-1', payment_date: '2024-06-10', amount: 7500 }],
        customers: [{ id: 'cust-a', name: 'Test AB' }],
      })

      const report = await generateARLedger(supabase, 'company-1', '2024-06-15')

      expect(report.entries[0].invoices[0].outstanding).toBe(2500)
      expect(report.entries[0].invoices[0].paid_amount).toBe(7500)
      expect(report.total_outstanding).toBe(2500)
    })

    it('ignores payments made after the asOfDate — the invoice is still open in the snapshot', async () => {
      const supabase = makeClient({
        invoices: [
          invoiceRow({
            id: 'inv-1',
            status: 'paid', // settled later — but open on the snapshot date
            invoice_date: '2024-06-01',
            due_date: '2024-07-01',
            total: 10000,
          }),
        ],
        invoicePayments: [{ invoice_id: 'inv-1', payment_date: '2024-07-05', amount: 10000 }],
        customers: [{ id: 'cust-a', name: 'Test AB' }],
      })

      const report = await generateARLedger(supabase, 'company-1', '2024-06-15')

      expect(report.entries).toHaveLength(1)
      expect(report.entries[0].invoices[0].outstanding).toBe(10000)
      expect(report.total_outstanding).toBe(10000)
    })

    it('excludes invoices created after the asOfDate', async () => {
      const supabase = makeClient({
        invoices: [
          invoiceRow({
            id: 'inv-1',
            invoice_date: '2024-07-01', // created after the snapshot date
            due_date: '2024-08-01',
            total: 5000,
          }),
        ],
        customers: [{ id: 'cust-a', name: 'Test AB' }],
      })

      const report = await generateARLedger(supabase, 'company-1', '2024-06-15')

      expect(report.entries).toEqual([])
      expect(report.total_outstanding).toBe(0)
    })

    it('sorts invoices within customer by due_date', async () => {
      const supabase = makeClient({
        invoices: [
          invoiceRow({
            id: 'inv-2',
            invoice_number: 'F002',
            invoice_date: '2024-05-01',
            due_date: '2024-07-01',
            total: 1000,
          }),
          invoiceRow({
            id: 'inv-1',
            invoice_number: 'F001',
            invoice_date: '2024-04-01',
            due_date: '2024-06-01',
            total: 2000,
          }),
        ],
        customers: [{ id: 'cust-a', name: 'Test AB' }],
      })

      const report = await generateARLedger(supabase, 'company-1', '2024-05-15')

      // Sorted by due_date: F001 (June 1) before F002 (July 1)
      expect(report.entries[0].invoices[0].invoice_number).toBe('F001')
      expect(report.entries[0].invoices[1].invoice_number).toBe('F002')
    })

    it('aggregates foreign-currency invoices into SEK aging buckets but preserves original currency on detail rows', async () => {
      // The aging totals reconcile against account 1510 (SEK), but the per-invoice
      // detail row keeps `outstanding` in invoice currency for display.
      const supabase = makeClient({
        invoices: [
          // 225 EUR at 11 → 2 475 SEK
          invoiceRow({
            id: 'inv-1',
            customer_id: 'cust-a',
            invoice_number: 'F100',
            invoice_date: '2024-05-01',
            due_date: '2024-06-01', // 14 days overdue at 2024-06-15
            total: 225,
            currency: 'EUR',
            exchange_rate: 11,
            status: 'overdue',
          }),
          // 1 000 SEK (control)
          invoiceRow({
            id: 'inv-2',
            customer_id: 'cust-a',
            invoice_number: 'F101',
            invoice_date: '2024-05-01',
            due_date: '2024-06-01',
            total: 1000,
            status: 'overdue',
          }),
        ],
        customers: [{ id: 'cust-a', name: 'Foreign AB' }],
      })

      const report = await generateARLedger(supabase, 'company-1', '2024-06-15')

      const entry = report.entries[0]
      // Aging bucket sums in SEK: 2 475 + 1 000 = 3 475
      expect(entry.days_1_30).toBe(3475)
      expect(entry.total_outstanding).toBe(3475)

      // Per-invoice detail keeps original currency for display, with the
      // converted SEK value alongside so callers don't accidentally mix.
      const eurInv = entry.invoices.find(i => i.invoice_number === 'F100')!
      expect(eurInv.outstanding).toBe(225)
      expect(eurInv.currency).toBe('EUR')
      expect(eurInv.outstanding_sek).toBe(2475)

      const sekInv = entry.invoices.find(i => i.invoice_number === 'F101')!
      expect(sekInv.outstanding_sek).toBe(1000)

      expect(report.total_outstanding).toBe(3475)
      expect(report.unconverted_fx_count).toBe(0)
    })

    it('lists FX invoices without exchange_rate but excludes them from totals (outstanding_sek = null)', async () => {
      const supabase = makeClient({
        invoices: [
          // 100 EUR with no rate — listed in detail but excluded from buckets
          invoiceRow({
            id: 'inv-1',
            invoice_number: 'F200',
            invoice_date: '2024-05-01',
            due_date: '2024-06-01',
            total: 100,
            currency: 'EUR',
            exchange_rate: null,
            status: 'overdue',
          }),
          // 500 SEK control
          invoiceRow({
            id: 'inv-2',
            invoice_number: 'F201',
            invoice_date: '2024-05-01',
            due_date: '2024-06-01',
            total: 500,
            status: 'overdue',
          }),
        ],
        customers: [{ id: 'cust-a', name: 'Foreign AB' }],
      })

      const report = await generateARLedger(supabase, 'company-1', '2024-06-15')

      expect(report.unconverted_fx_count).toBe(1)
      // EUR row excluded from total — only the 500 SEK invoice contributes
      expect(report.total_outstanding).toBe(500)

      const entry = report.entries[0]
      expect(entry.total_outstanding).toBe(500)
      // Both detail rows are still visible to the user
      expect(entry.invoices).toHaveLength(2)
      const eurInv = entry.invoices.find(i => i.invoice_number === 'F200')!
      expect(eurInv.outstanding).toBe(100)
      expect(eurInv.outstanding_sek).toBeNull()
    })

    it('uses Math.round for monetary precision', async () => {
      const supabase = makeClient({
        invoices: [
          invoiceRow({
            id: 'inv-1',
            invoice_date: '2024-06-01',
            due_date: '2024-07-01',
            total: 100.1,
          }),
        ],
        invoicePayments: [{ invoice_id: 'inv-1', payment_date: '2024-06-05', amount: 33.33 }],
        customers: [{ id: 'cust-a', name: 'Test' }],
      })

      const report = await generateARLedger(supabase, 'company-1', '2024-06-15')
      expect(report.entries[0].invoices[0].outstanding).toBe(66.77)
      expect(report.total_outstanding).toBe(66.77)
    })

    it('nets a credited invoice with its credit note to zero outstanding', async () => {
      // Original was sent (unpaid) and then fully credited.
      // Journal-level AR is 0; the ledger should match.
      const supabase = makeClient({
        invoices: [
          invoiceRow({
            id: 'inv-1',
            invoice_number: '2026001',
            invoice_date: '2026-05-05',
            due_date: '2026-06-05',
            total: 1241.25,
            status: 'credited',
          }),
          invoiceRow({
            id: 'inv-2',
            invoice_number: 'KR-2026001',
            invoice_date: '2026-05-05',
            due_date: '2026-05-05',
            total: -1241.25,
            credited_invoice_id: 'inv-1',
          }),
        ],
        customers: [{ id: 'cust-a', name: 'Test AB' }],
      })

      const report = await generateARLedger(supabase, 'company-1', '2026-05-05')

      expect(report.entries).toEqual([])
      expect(report.total_outstanding).toBe(0)
      expect(report.total_current).toBe(0)
      expect(report.total_overdue).toBe(0)
      expect(report.unpaid_count).toBe(0)
    })

    it('keeps the customer negative when a credit note offsets an already-paid invoice', async () => {
      // Original was paid in full, then credited — we owe the customer the refund.
      const supabase = makeClient({
        invoices: [
          invoiceRow({
            id: 'inv-1',
            invoice_number: '2026001',
            invoice_date: '2026-04-01',
            due_date: '2026-05-01',
            total: 1000,
            status: 'credited',
          }),
          invoiceRow({
            id: 'inv-2',
            invoice_number: 'KR-2026001',
            invoice_date: '2026-05-05',
            due_date: '2026-05-05',
            total: -1000,
            credited_invoice_id: 'inv-1',
          }),
        ],
        invoicePayments: [{ invoice_id: 'inv-1', payment_date: '2026-04-15', amount: 1000 }],
        customers: [{ id: 'cust-a', name: 'Test AB' }],
      })

      const report = await generateARLedger(supabase, 'company-1', '2026-05-05')

      expect(report.entries).toHaveLength(1)
      expect(report.entries[0].total_outstanding).toBe(-1000)
      expect(report.total_outstanding).toBe(-1000)
      expect(report.unpaid_count).toBe(1)
    })

    it('handles missing customer name gracefully', async () => {
      const supabase = makeClient({
        invoices: [
          invoiceRow({
            id: 'inv-1',
            invoice_date: '2024-06-01',
            due_date: '2024-07-01',
            total: 1000,
          }),
        ],
        customers: [], // no matching customer row
      })

      const report = await generateARLedger(supabase, 'company-1', '2024-06-15')
      expect(report.entries[0].customer_name).toBe('Okänd kund')
    })
  })
})
