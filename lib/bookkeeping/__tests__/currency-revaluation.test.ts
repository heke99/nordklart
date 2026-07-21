import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Currency, Invoice, JournalEntry, RevaluationItem, SupplierInvoice } from '@/types'
import { makeInvoice, makeJournalEntry, makeSupplierInvoice } from '@/tests/helpers'
import { BookkeepingDatabaseError } from '@/lib/bookkeeping/errors'

// Mock riksbanken
vi.mock('@/lib/currency/riksbanken', () => ({
  fetchMultipleRates: vi.fn(),
}))

import { fetchMultipleRates } from '@/lib/currency/riksbanken'
import {
  getOpenForeignCurrencyReceivables,
  getOpenForeignCurrencyPayables,
  previewCurrencyRevaluation,
  executeCurrencyRevaluation,
  computeRevaluationSnapshotKey,
  buildRevaluationRpcPayload,
} from '../currency-revaluation'

const mockedFetchRates = vi.mocked(fetchMultipleRates)

const BALANCE_DATE = '2024-12-31'

// ============================================================
// Table-routed mock supabase
//
// The revaluation now reconstructs HISTORICAL open amounts through
// lib/invoices/historical-open-items.ts: it queries invoices /
// supplier_invoices plus invoice_payments / supplier_invoice_payments via
// fetchAllRows (query builders receive .range(from, to)) and posts through
// the post_currency_revaluation RPC. The mock routes .from(table) to
// per-table fixtures and actually applies the filters the production code
// uses, so date-based exclusion (B06) is exercised for real.
// ============================================================

type Row = Record<string, unknown>

interface MockPayment {
  company_id?: string
  invoice_id?: string
  supplier_invoice_id?: string
  payment_date: string
  amount: number
}

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
  chain.single = vi.fn().mockImplementation(async () => {
    if (errorMessage) return { data: null, error: { message: errorMessage } }
    return {
      data: filtered[0] ?? null,
      error: filtered.length > 0 ? null : { message: 'Row not found' },
    }
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

function createRevaluationMockSupabase(config: {
  invoices?: Invoice[]
  supplierInvoices?: SupplierInvoice[]
  invoicePayments?: MockPayment[]
  supplierInvoicePayments?: MockPayment[]
  journalEntries?: JournalEntry[]
  rpcResult?: { data?: unknown; error?: { message: string } | null }
  errors?: Partial<Record<string, string>>
}) {
  const withCompany = (payments: MockPayment[] = []): Row[] =>
    payments.map((p) => ({ company_id: 'company-1', ...p }))

  const tables: Record<string, Row[]> = {
    invoices: (config.invoices ?? []) as unknown as Row[],
    supplier_invoices: (config.supplierInvoices ?? []) as unknown as Row[],
    invoice_payments: withCompany(config.invoicePayments),
    supplier_invoice_payments: withCompany(config.supplierInvoicePayments),
    journal_entries: (config.journalEntries ?? []) as unknown as Row[],
  }

  const rpc = vi.fn().mockImplementation((name: string) => {
    if (name === 'historical_open_items_at') {
      // These unit cases intentionally exercise the table fallback. Production
      // uses the canonical RPC after the migration is present.
      return Promise.resolve({
        data: null,
        error: { code: '42883', message: 'function historical_open_items_at does not exist' },
      })
    }
    if (name === 'register_year_end_fx_rate_snapshots') {
      return Promise.resolve({ data: null, error: null })
    }
    return Promise.resolve(
      config.rpcResult ?? {
        data: { run_id: 'run-1', entry_id: 'entry-1', reused: false },
        error: null,
      },
    )
  })

  const supabase = {
    from: vi
      .fn()
      .mockImplementation((table: string) =>
        buildTableChain(tables[table] ?? [], config.errors?.[table])
      ),
    rpc,
  }

  return { supabase: supabase as unknown as SupabaseClient, rpc }
}

function mockRates(rates: Partial<Record<Currency, number>>) {
  mockedFetchRates.mockResolvedValue(
    new Map(
      (Object.entries(rates) as [Currency, number][]).map(([currency, rate]) => [
        currency,
        { currency, rate, date: BALANCE_DATE },
      ])
    )
  )
}

function makeRevaluationItem(overrides: Partial<RevaluationItem> = {}): RevaluationItem {
  return {
    type: 'receivable',
    source_id: 'inv-1',
    reference: 'F-001',
    currency: 'EUR' as Currency,
    amount_in_currency: 1000,
    original_rate: 11,
    closing_rate: 11.5,
    original_sek: 11000,
    closing_sek: 11500,
    difference_sek: 500,
    ...overrides,
  }
}

describe('currency-revaluation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getOpenForeignCurrencyReceivables', () => {
    it('returns non-SEK invoices open at the balance date as historical open items', async () => {
      const eurInvoice = makeInvoice({
        id: 'inv-eur',
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.5,
        total: 1000,
        invoice_number: 'F-001',
      })
      const sekInvoice = makeInvoice({
        status: 'sent',
        currency: 'SEK',
        total: 5000,
      })

      const { supabase } = createRevaluationMockSupabase({ invoices: [eurInvoice, sekInvoice] })
      const result = await getOpenForeignCurrencyReceivables(supabase, 'company-1', BALANCE_DATE)

      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        id: 'inv-eur',
        type: 'invoice',
        reference: 'F-001',
        currency: 'EUR',
        exchange_rate: 11.5,
        total: 1000,
        open_amount: 1000,
        current_status: 'sent',
      })
    })

    it('excludes invoices fully paid on or before the balance date', async () => {
      const eurInvoice = makeInvoice({
        id: 'inv-1',
        status: 'paid',
        currency: 'EUR',
        exchange_rate: 11.5,
        total: 1000,
      })

      const { supabase } = createRevaluationMockSupabase({
        invoices: [eurInvoice],
        invoicePayments: [{ invoice_id: 'inv-1', payment_date: '2024-11-30', amount: 1000 }],
      })
      const result = await getOpenForeignCurrencyReceivables(supabase, 'company-1', BALANCE_DATE)

      expect(result).toHaveLength(0)
    })

    it('reduces the open amount by partial payments made on or before the balance date (B07)', async () => {
      const eurInvoice = makeInvoice({
        id: 'inv-1',
        status: 'partially_paid',
        currency: 'EUR',
        exchange_rate: 11.5,
        total: 1000,
      })

      const { supabase } = createRevaluationMockSupabase({
        invoices: [eurInvoice],
        invoicePayments: [{ invoice_id: 'inv-1', payment_date: '2024-10-01', amount: 400 }],
      })
      const result = await getOpenForeignCurrencyReceivables(supabase, 'company-1', BALANCE_DATE)

      expect(result).toHaveLength(1)
      expect(result[0].open_amount).toBe(600)
    })

    it('includes an invoice paid after the balance date with its historical open amount (B06)', async () => {
      const eurInvoice = makeInvoice({
        id: 'inv-1',
        status: 'paid', // current status — irrelevant to the historical math
        currency: 'EUR',
        exchange_rate: 11.5,
        total: 1000,
      })

      const { supabase } = createRevaluationMockSupabase({
        invoices: [eurInvoice],
        invoicePayments: [{ invoice_id: 'inv-1', payment_date: '2025-01-15', amount: 1000 }],
      })
      const result = await getOpenForeignCurrencyReceivables(supabase, 'company-1', BALANCE_DATE)

      expect(result).toHaveLength(1)
      expect(result[0].open_amount).toBe(1000)
      expect(result[0].current_status).toBe('paid')
    })

    it('excludes invoices created after the balance date (B06)', async () => {
      const futureInvoice = makeInvoice({
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.5,
        total: 1000,
        invoice_date: '2025-01-10',
      })

      const { supabase } = createRevaluationMockSupabase({ invoices: [futureInvoice] })
      const result = await getOpenForeignCurrencyReceivables(supabase, 'company-1', BALANCE_DATE)

      expect(result).toHaveLength(0)
    })

    it('excludes invoices without exchange_rate', async () => {
      const noRateInvoice = makeInvoice({
        status: 'sent',
        currency: 'EUR',
        exchange_rate: null,
        total: 1000,
      })

      const { supabase } = createRevaluationMockSupabase({ invoices: [noRateInvoice] })
      const result = await getOpenForeignCurrencyReceivables(supabase, 'company-1', BALANCE_DATE)

      expect(result).toHaveLength(0)
    })

    it('excludes draft and cancelled invoices', async () => {
      const draftInvoice = makeInvoice({
        status: 'draft',
        currency: 'EUR',
        exchange_rate: 11.5,
        total: 1000,
      })
      const cancelledInvoice = makeInvoice({
        status: 'cancelled',
        currency: 'EUR',
        exchange_rate: 11.5,
        total: 2000,
      })

      const { supabase } = createRevaluationMockSupabase({
        invoices: [draftInvoice, cancelledInvoice],
      })
      const result = await getOpenForeignCurrencyReceivables(supabase, 'company-1', BALANCE_DATE)

      expect(result).toHaveLength(0)
    })

    it('nets credit notes dated on or before the balance date against the credited invoice', async () => {
      const eurInvoice = makeInvoice({
        id: 'inv-1',
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.5,
        total: 1000,
      })
      const creditNote = makeInvoice({
        id: 'kr-1',
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.5,
        total: -400, // credit note totals are negative by convention
        credited_invoice_id: 'inv-1',
      })

      const { supabase } = createRevaluationMockSupabase({ invoices: [eurInvoice, creditNote] })
      const result = await getOpenForeignCurrencyReceivables(supabase, 'company-1', BALANCE_DATE)

      // The credit note is netted, not listed as its own item
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('inv-1')
      expect(result[0].open_amount).toBe(600)
    })

    it('throws on query error instead of returning an empty result', async () => {
      const { supabase } = createRevaluationMockSupabase({
        errors: { invoices: 'DB error' },
      })

      await expect(
        getOpenForeignCurrencyReceivables(supabase, 'company-1', BALANCE_DATE)
      ).rejects.toThrow('DB error')
    })
  })

  describe('getOpenForeignCurrencyPayables', () => {
    it('returns non-SEK supplier invoices open at the balance date', async () => {
      const eurSI = makeSupplierInvoice({
        id: 'si-eur',
        status: 'registered',
        currency: 'EUR',
        exchange_rate: 11.5,
        total: 5000,
        supplier_invoice_number: 'LF-001',
      })
      const sekSI = makeSupplierInvoice({
        status: 'registered',
        currency: 'SEK',
        total: 3000,
      })

      const { supabase } = createRevaluationMockSupabase({
        supplierInvoices: [eurSI, sekSI],
      })
      const result = await getOpenForeignCurrencyPayables(supabase, 'company-1', BALANCE_DATE)

      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        id: 'si-eur',
        type: 'supplier_invoice',
        reference: 'LF-001',
        currency: 'EUR',
        exchange_rate: 11.5,
        total: 5000,
        open_amount: 5000,
      })
    })

    it('reduces the open amount by partial payments made on or before the balance date (B07)', async () => {
      const partialSI = makeSupplierInvoice({
        id: 'si-1',
        status: 'partially_paid',
        currency: 'USD',
        exchange_rate: 10.5,
        total: 10000,
      })

      const { supabase } = createRevaluationMockSupabase({
        supplierInvoices: [partialSI],
        supplierInvoicePayments: [
          { supplier_invoice_id: 'si-1', payment_date: '2024-11-01', amount: 8000 },
        ],
      })
      const result = await getOpenForeignCurrencyPayables(supabase, 'company-1', BALANCE_DATE)

      expect(result).toHaveLength(1)
      expect(result[0].open_amount).toBe(2000)
    })

    it('excludes supplier invoices fully paid on or before the balance date', async () => {
      const paidSI = makeSupplierInvoice({
        id: 'si-1',
        status: 'paid',
        currency: 'EUR',
        exchange_rate: 11.5,
        total: 10000,
      })

      const { supabase } = createRevaluationMockSupabase({
        supplierInvoices: [paidSI],
        supplierInvoicePayments: [
          { supplier_invoice_id: 'si-1', payment_date: '2024-12-01', amount: 10000 },
        ],
      })
      const result = await getOpenForeignCurrencyPayables(supabase, 'company-1', BALANCE_DATE)

      expect(result).toHaveLength(0)
    })

    it('includes a supplier invoice paid after the balance date with its historical open amount (B06)', async () => {
      const laterPaidSI = makeSupplierInvoice({
        id: 'si-1',
        status: 'paid',
        currency: 'EUR',
        exchange_rate: 11.5,
        total: 10000,
      })

      const { supabase } = createRevaluationMockSupabase({
        supplierInvoices: [laterPaidSI],
        supplierInvoicePayments: [
          { supplier_invoice_id: 'si-1', payment_date: '2025-01-05', amount: 10000 },
        ],
      })
      const result = await getOpenForeignCurrencyPayables(supabase, 'company-1', BALANCE_DATE)

      expect(result).toHaveLength(1)
      expect(result[0].open_amount).toBe(10000)
    })

    it('excludes supplier invoices created after the balance date (B06)', async () => {
      const futureSI = makeSupplierInvoice({
        status: 'registered',
        currency: 'EUR',
        exchange_rate: 11.5,
        total: 5000,
        invoice_date: '2025-01-10',
      })

      const { supabase } = createRevaluationMockSupabase({ supplierInvoices: [futureSI] })
      const result = await getOpenForeignCurrencyPayables(supabase, 'company-1', BALANCE_DATE)

      expect(result).toHaveLength(0)
    })

    it('excludes reversed supplier invoices', async () => {
      const reversedSI = makeSupplierInvoice({
        status: 'reversed',
        currency: 'EUR',
        exchange_rate: 11.5,
        total: 5000,
      })

      const { supabase } = createRevaluationMockSupabase({ supplierInvoices: [reversedSI] })
      const result = await getOpenForeignCurrencyPayables(supabase, 'company-1', BALANCE_DATE)

      expect(result).toHaveLength(0)
    })

    it('throws on query error instead of returning an empty result', async () => {
      const { supabase } = createRevaluationMockSupabase({
        errors: { supplier_invoices: 'DB error' },
      })

      await expect(
        getOpenForeignCurrencyPayables(supabase, 'company-1', BALANCE_DATE)
      ).rejects.toThrow('DB error')
    })
  })

  describe('official rate policy', () => {
    it('requests Riksbanken observations with fallback disabled', async () => {
      const eurInvoice = makeInvoice({
        id: 'inv-rate-policy',
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11,
        total: 100,
      })
      mockRates({ EUR: 11.5 })
      const { supabase } = createRevaluationMockSupabase({ invoices: [eurInvoice] })

      await previewCurrencyRevaluation(supabase, 'company-1', BALANCE_DATE)

      expect(mockedFetchRates).toHaveBeenCalledWith(
        ['EUR'],
        new Date(BALANCE_DATE),
        { allowFallback: false },
      )
    })
  })

  describe('previewCurrencyRevaluation', () => {
    it('returns empty preview when no foreign currency items', async () => {
      const { supabase } = createRevaluationMockSupabase({})

      const preview = await previewCurrencyRevaluation(supabase, 'company-1', BALANCE_DATE)

      expect(preview.items).toHaveLength(0)
      expect(preview.lines).toHaveLength(0)
      expect(preview.netEffect).toBe(0)
      expect(mockedFetchRates).not.toHaveBeenCalled()
    })

    it('computes receivable gain (closing rate > original rate)', async () => {
      const eurInvoice = makeInvoice({
        id: 'inv-1',
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
        invoice_number: 'F-001',
      })

      mockRates({ EUR: 11.5 })

      const { supabase } = createRevaluationMockSupabase({ invoices: [eurInvoice] })
      const preview = await previewCurrencyRevaluation(supabase, 'company-1', BALANCE_DATE)

      expect(preview.items).toHaveLength(1)
      expect(preview.items[0].type).toBe('receivable')
      expect(preview.items[0].difference_sek).toBe(500) // 1000 * (11.5 - 11.0)

      // Should debit 1510 (receivable up), credit 3960 (gain)
      const debit1510 = preview.lines.find(l => l.account_number === '1510' && l.debit_amount > 0)
      const credit3960 = preview.lines.find(l => l.account_number === '3960' && l.credit_amount > 0)
      expect(debit1510).toBeDefined()
      expect(debit1510!.debit_amount).toBe(500)
      expect(credit3960).toBeDefined()
      expect(credit3960!.credit_amount).toBe(500)

      expect(preview.totalGain).toBe(500)
      expect(preview.totalLoss).toBe(0)
      expect(preview.netEffect).toBe(500)
    })

    it('computes receivable loss (closing rate < original rate)', async () => {
      const eurInvoice = makeInvoice({
        id: 'inv-2',
        status: 'overdue',
        currency: 'EUR',
        exchange_rate: 12.0,
        total: 1000,
        invoice_number: 'F-002',
      })

      mockRates({ EUR: 11.5 })

      const { supabase } = createRevaluationMockSupabase({ invoices: [eurInvoice] })
      const preview = await previewCurrencyRevaluation(supabase, 'company-1', BALANCE_DATE)

      expect(preview.items[0].difference_sek).toBe(-500) // 1000 * (11.5 - 12.0)

      // Should credit 1510 (receivable down), debit 7960 (loss)
      const credit1510 = preview.lines.find(l => l.account_number === '1510' && l.credit_amount > 0)
      const debit7960 = preview.lines.find(l => l.account_number === '7960' && l.debit_amount > 0)
      expect(credit1510).toBeDefined()
      expect(credit1510!.credit_amount).toBe(500)
      expect(debit7960).toBeDefined()
      expect(debit7960!.debit_amount).toBe(500)

      expect(preview.totalLoss).toBe(500)
      expect(preview.totalGain).toBe(0)
      expect(preview.netEffect).toBe(-500)
    })

    it('computes payable loss (closing rate > original rate — liability grew)', async () => {
      const eurSI = makeSupplierInvoice({
        id: 'si-1',
        status: 'registered',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 2000,
        supplier_invoice_number: 'LF-001',
      })

      mockRates({ EUR: 11.5 })

      const { supabase } = createRevaluationMockSupabase({ supplierInvoices: [eurSI] })
      const preview = await previewCurrencyRevaluation(supabase, 'company-1', BALANCE_DATE)

      expect(preview.items[0].type).toBe('payable')
      expect(preview.items[0].difference_sek).toBe(1000) // 2000 * (11.5 - 11.0)

      // Should debit 7960 (loss), credit 2440 (liability up)
      const debit7960 = preview.lines.find(l => l.account_number === '7960' && l.debit_amount > 0)
      const credit2440 = preview.lines.find(l => l.account_number === '2440' && l.credit_amount > 0)
      expect(debit7960).toBeDefined()
      expect(debit7960!.debit_amount).toBe(1000)
      expect(credit2440).toBeDefined()
      expect(credit2440!.credit_amount).toBe(1000)
    })

    it('computes payable gain (closing rate < original rate — liability shrank)', async () => {
      const eurSI = makeSupplierInvoice({
        id: 'si-2',
        status: 'approved',
        currency: 'EUR',
        exchange_rate: 12.0,
        total: 2000,
        supplier_invoice_number: 'LF-002',
      })

      mockRates({ EUR: 11.5 })

      const { supabase } = createRevaluationMockSupabase({ supplierInvoices: [eurSI] })
      const preview = await previewCurrencyRevaluation(supabase, 'company-1', BALANCE_DATE)

      expect(preview.items[0].difference_sek).toBe(-1000) // 2000 * (11.5 - 12.0)

      // Should debit 2440 (liability down), credit 3960 (gain)
      const debit2440 = preview.lines.find(l => l.account_number === '2440' && l.debit_amount > 0)
      const credit3960 = preview.lines.find(l => l.account_number === '3960' && l.credit_amount > 0)
      expect(debit2440).toBeDefined()
      expect(debit2440!.debit_amount).toBe(1000)
      expect(credit3960).toBeDefined()
      expect(credit3960!.credit_amount).toBe(1000)
    })

    it('handles mixed currencies correctly', async () => {
      const eurInvoice = makeInvoice({
        id: 'inv-eur',
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
        invoice_number: 'F-EUR',
      })
      const usdInvoice = makeInvoice({
        id: 'inv-usd',
        status: 'sent',
        currency: 'USD',
        exchange_rate: 10.0,
        total: 500,
        invoice_number: 'F-USD',
      })

      mockRates({ EUR: 11.5, USD: 10.5 })

      const { supabase } = createRevaluationMockSupabase({ invoices: [eurInvoice, usdInvoice] })
      const preview = await previewCurrencyRevaluation(supabase, 'company-1', BALANCE_DATE)

      expect(preview.items).toHaveLength(2)
      // EUR: 1000 * (11.5 - 11.0) = 500
      // USD: 500 * (10.5 - 10.0) = 250
      expect(preview.totalGain).toBe(750)
    })

    it('aggregates journal lines correctly with mixed gains and losses', async () => {
      const gainInvoice = makeInvoice({
        id: 'inv-gain',
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
        invoice_number: 'F-GAIN',
      })
      const lossSI = makeSupplierInvoice({
        id: 'si-loss',
        status: 'registered',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 2000,
        supplier_invoice_number: 'LF-LOSS',
      })

      // EUR went up to 11.5
      mockRates({ EUR: 11.5 })

      const { supabase } = createRevaluationMockSupabase({
        invoices: [gainInvoice],
        supplierInvoices: [lossSI],
      })
      const preview = await previewCurrencyRevaluation(supabase, 'company-1', BALANCE_DATE)

      // Receivable gain: 1000 * 0.5 = 500 → Debit 1510, Credit 3960
      // Payable loss: 2000 * 0.5 = 1000 → Debit 7960, Credit 2440
      expect(preview.totalGain).toBe(500)
      expect(preview.totalLoss).toBe(1000)
      expect(preview.netEffect).toBe(-500)

      // Verify all entries balance
      const totalDebit = preview.lines.reduce((sum, l) => sum + l.debit_amount, 0)
      const totalCredit = preview.lines.reduce((sum, l) => sum + l.credit_amount, 0)
      expect(Math.round(totalDebit * 100) / 100).toBe(Math.round(totalCredit * 100) / 100)
    })

    it('revalues only the historically open amount of a partially paid invoice (B06/B07)', async () => {
      const partialInvoice = makeInvoice({
        id: 'inv-partial',
        status: 'partially_paid',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 10000,
        invoice_number: 'F-PARTIAL',
      })

      mockRates({ EUR: 11.5 })

      const { supabase } = createRevaluationMockSupabase({
        invoices: [partialInvoice],
        invoicePayments: [
          { invoice_id: 'inv-partial', payment_date: '2024-11-15', amount: 5000 },
        ],
      })
      const preview = await previewCurrencyRevaluation(supabase, 'company-1', BALANCE_DATE)

      // Only the open 5000 EUR is revalued, not the full 10000
      expect(preview.items).toHaveLength(1)
      expect(preview.items[0].amount_in_currency).toBe(5000)
      expect(preview.items[0].difference_sek).toBe(2500) // 5000 * (11.5 - 11.0)
    })

    it('revalues only the historically open amount of a partially paid supplier invoice (B07)', async () => {
      const partialSI = makeSupplierInvoice({
        id: 'si-partial',
        status: 'partially_paid',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 10000,
        supplier_invoice_number: 'LF-PARTIAL',
      })

      mockRates({ EUR: 11.5 })

      const { supabase } = createRevaluationMockSupabase({
        supplierInvoices: [partialSI],
        supplierInvoicePayments: [
          { supplier_invoice_id: 'si-partial', payment_date: '2024-11-15', amount: 5000 },
        ],
      })
      const preview = await previewCurrencyRevaluation(supabase, 'company-1', BALANCE_DATE)

      // Only remaining 5000 EUR is revalued, not full 10000
      expect(preview.items[0].amount_in_currency).toBe(5000)
      expect(preview.items[0].difference_sek).toBe(2500) // 5000 * (11.5 - 11.0)
    })

    it('excludes invoices created after the balance date (B06)', async () => {
      const futureInvoice = makeInvoice({
        id: 'inv-future',
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
        invoice_date: '2025-01-10',
      })

      mockRates({ EUR: 11.5 })

      const { supabase } = createRevaluationMockSupabase({ invoices: [futureInvoice] })
      const preview = await previewCurrencyRevaluation(supabase, 'company-1', BALANCE_DATE)

      expect(preview.items).toHaveLength(0)
      expect(preview.lines).toHaveLength(0)
    })

    it('includes an invoice paid after the balance date with its historical open amount (B06)', async () => {
      const laterPaidInvoice = makeInvoice({
        id: 'inv-later-paid',
        status: 'paid', // settled in January — but open on the balance date
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
        invoice_number: 'F-LATER',
      })

      mockRates({ EUR: 11.5 })

      const { supabase } = createRevaluationMockSupabase({
        invoices: [laterPaidInvoice],
        invoicePayments: [
          { invoice_id: 'inv-later-paid', payment_date: '2025-01-15', amount: 1000 },
        ],
      })
      const preview = await previewCurrencyRevaluation(supabase, 'company-1', BALANCE_DATE)

      expect(preview.items).toHaveLength(1)
      expect(preview.items[0].amount_in_currency).toBe(1000)
      expect(preview.items[0].difference_sek).toBe(500)
    })

    it('retains zero-difference exposure in the verified snapshot without journal lines', async () => {
      const eurInvoice = makeInvoice({
        id: 'inv-same',
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.5,
        total: 1000,
        invoice_number: 'F-SAME',
      })

      // Closing rate equals original rate
      mockRates({ EUR: 11.5 })

      const { supabase } = createRevaluationMockSupabase({ invoices: [eurInvoice] })
      const preview = await previewCurrencyRevaluation(supabase, 'company-1', BALANCE_DATE)

      expect(preview.items).toHaveLength(1)
      expect(preview.items[0].difference_sek).toBe(0)
      expect(preview.lines).toHaveLength(0)
    })

    it('all generated journal lines balance (debits === credits)', async () => {
      const eurInvoice = makeInvoice({
        id: 'inv-bal',
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1234.56,
        invoice_number: 'F-BAL',
      })
      const gbpSI = makeSupplierInvoice({
        id: 'si-bal',
        status: 'overdue',
        currency: 'GBP',
        exchange_rate: 14.0,
        total: 789.12,
        supplier_invoice_number: 'LF-BAL',
      })

      mockRates({ EUR: 11.8, GBP: 13.5 })

      const { supabase } = createRevaluationMockSupabase({
        invoices: [eurInvoice],
        supplierInvoices: [gbpSI],
      })
      const preview = await previewCurrencyRevaluation(supabase, 'company-1', BALANCE_DATE)

      const totalDebit = preview.lines.reduce((sum, l) => sum + l.debit_amount, 0)
      const totalCredit = preview.lines.reduce((sum, l) => sum + l.credit_amount, 0)
      expect(Math.round(totalDebit * 100)).toBe(Math.round(totalCredit * 100))
    })
  })

  describe('computeRevaluationSnapshotKey', () => {
    it('returns a sha256 hex string', () => {
      const key = computeRevaluationSnapshotKey('company-1', BALANCE_DATE, [makeRevaluationItem()])
      expect(key).toMatch(/^[0-9a-f]{64}$/)
    })

    it('is deterministic — the same items produce the same key regardless of order', () => {
      const a = makeRevaluationItem({ source_id: 'inv-a' })
      const b = makeRevaluationItem({
        source_id: 'si-b',
        type: 'payable',
        currency: 'USD' as Currency,
        amount_in_currency: 500,
        original_rate: 10,
        closing_rate: 10.5,
      })

      const key1 = computeRevaluationSnapshotKey('company-1', BALANCE_DATE, [a, b])
      const key2 = computeRevaluationSnapshotKey('company-1', BALANCE_DATE, [b, a])

      expect(key1).toBe(key2)
    })

    it('changes when a closing rate changes', () => {
      const item = makeRevaluationItem({ closing_rate: 11.5 })
      const rerated = makeRevaluationItem({ closing_rate: 12.0 })

      const key1 = computeRevaluationSnapshotKey('company-1', BALANCE_DATE, [item])
      const key2 = computeRevaluationSnapshotKey('company-1', BALANCE_DATE, [rerated])

      expect(key1).not.toBe(key2)
    })

    it('changes when the balance date or company changes', () => {
      const items = [makeRevaluationItem()]

      const base = computeRevaluationSnapshotKey('company-1', BALANCE_DATE, items)
      expect(computeRevaluationSnapshotKey('company-1', '2025-12-31', items)).not.toBe(base)
      expect(computeRevaluationSnapshotKey('company-2', BALANCE_DATE, items)).not.toBe(base)
    })
  })

  describe('buildRevaluationRpcPayload', () => {
    it('maps receivables to invoice_id and payables to supplier_invoice_id with the snapshot key', () => {
      const receivable = makeRevaluationItem({ source_id: 'inv-1', type: 'receivable' })
      const payable = makeRevaluationItem({
        source_id: 'si-1',
        type: 'payable',
        amount_in_currency: 2000,
        original_sek: 22000,
        closing_sek: 23000,
        difference_sek: 1000,
      })
      const preview = {
        items: [receivable, payable],
        lines: [
          {
            account_number: '1510',
            debit_amount: 500,
            credit_amount: 0,
            line_description: 'x',
          },
        ],
        closingRates: { EUR: 11.5 },
        totalGain: 500,
        totalLoss: 0,
        netEffect: 500,
      }

      const payload = buildRevaluationRpcPayload('company-1', BALANCE_DATE, preview)

      expect(payload.balance_date).toBe(BALANCE_DATE)
      expect(payload.snapshot_key).toBe(
        computeRevaluationSnapshotKey('company-1', BALANCE_DATE, preview.items)
      )
      expect(payload.lines).toEqual(preview.lines)
      expect(payload.items).toEqual([
        {
          invoice_id: 'inv-1',
          supplier_invoice_id: null,
          currency: 'EUR',
          open_amount_currency: 1000,
          open_amount_sek_original: 11000,
          rate_original: 11,
          rate_closing: 11.5,
          rate_closing_date: BALANCE_DATE,
          rate_source: 'riksbanken',
          unrealized_diff_sek: 500,
        },
        {
          invoice_id: null,
          supplier_invoice_id: 'si-1',
          currency: 'EUR',
          open_amount_currency: 2000,
          open_amount_sek_original: 22000,
          rate_original: 11,
          rate_closing: 11.5,
          rate_closing_date: BALANCE_DATE,
          rate_source: 'riksbanken',
          unrealized_diff_sek: 1000,
        },
      ])
    })
  })

  describe('executeCurrencyRevaluation', () => {
    it('returns null when no foreign currency items exist', async () => {
      const { supabase, rpc } = createRevaluationMockSupabase({})

      const result = await executeCurrencyRevaluation(
        supabase,
        'company-1',
        BALANCE_DATE,
        'period-1',
        'user-1'
      )

      expect(result).toBeNull()
      expect(rpc.mock.calls.map(([name]) => name)).not.toContain('post_currency_revaluation')
      expect(rpc.mock.calls.map(([name]) => name)).not.toContain('register_year_end_fx_rate_snapshots')
    })

    it('posts through the post_currency_revaluation RPC with the deterministic payload', async () => {
      const eurInvoice = makeInvoice({
        id: 'inv-1',
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
        invoice_number: 'F-001',
      })

      mockRates({ EUR: 11.5 })

      const { supabase, rpc } = createRevaluationMockSupabase({
        invoices: [eurInvoice],
        journalEntries: [
          makeJournalEntry({ id: 'entry-1', source_type: 'currency_revaluation' }),
        ],
      })

      const result = await executeCurrencyRevaluation(
        supabase,
        'company-1',
        BALANCE_DATE,
        'period-1',
        'user-1'
      )

      expect(result).not.toBeNull()
      const postCall = rpc.mock.calls.find(([name]) => name === 'post_currency_revaluation')
      expect(postCall).toBeTruthy()

      const [rpcName, rpcArgs] = postCall as [string, Record<string, unknown>]
      expect(rpcName).toBe('post_currency_revaluation')
      expect(rpcArgs.p_company_id).toBe('company-1')
      expect(rpcArgs.p_fiscal_period_id).toBe('period-1')
      expect(rpcArgs.p_user_id).toBe('user-1')
      expect(rpcArgs.p_balance_date).toBe(BALANCE_DATE)
      expect(rpcArgs.p_snapshot_key).toBe(
        computeRevaluationSnapshotKey('company-1', BALANCE_DATE, result!.preview.items)
      )
      expect(rpcArgs.p_lines).toEqual(result!.preview.lines)
      expect(rpcArgs.p_items).toEqual([
        expect.objectContaining({
          invoice_id: 'inv-1',
          supplier_invoice_id: null,
          currency: 'EUR',
          open_amount_currency: 1000,
          rate_original: 11,
          rate_closing: 11.5,
          unrealized_diff_sek: 500,
        }),
      ])
    })

    it('rejects execution when no verified actor is supplied', async () => {
      const { supabase, rpc } = createRevaluationMockSupabase({})

      await expect(
        executeCurrencyRevaluation(
          supabase,
          'company-1',
          BALANCE_DATE,
          'period-1',
          undefined as unknown as string,
        ),
      ).rejects.toThrow(/YEAR_END_ACTOR_REQUIRED/)

      expect(rpc).not.toHaveBeenCalled()
    })

    it('returns the posted entry and the preview', async () => {
      const eurInvoice = makeInvoice({
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
        invoice_number: 'F-001',
      })

      mockRates({ EUR: 12.0 })

      const { supabase } = createRevaluationMockSupabase({
        invoices: [eurInvoice],
        journalEntries: [
          makeJournalEntry({ id: 'entry-1', source_type: 'currency_revaluation' }),
        ],
      })

      const result = await executeCurrencyRevaluation(
        supabase,
        'company-1',
        BALANCE_DATE,
        'period-1',
        'user-1'
      )

      expect(result).not.toBeNull()
      expect(result!.entry.id).toBe('entry-1')
      expect(result!.preview.items).toHaveLength(1)
      expect(result!.preview.totalGain).toBe(1000) // 1000 * (12 - 11)
    })

    it('reuses the existing entry when the RPC reports an identical snapshot (idempotent, B05)', async () => {
      const eurInvoice = makeInvoice({
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
      })

      mockRates({ EUR: 11.5 })

      const { supabase } = createRevaluationMockSupabase({
        invoices: [eurInvoice],
        journalEntries: [
          makeJournalEntry({ id: 'entry-1', source_type: 'currency_revaluation' }),
        ],
        rpcResult: {
          data: { run_id: 'run-1', entry_id: 'entry-1', reused: true },
          error: null,
        },
      })

      // No CurrencyRevaluationAlreadyExistsError anymore — the existing entry
      // is returned instead.
      const result = await executeCurrencyRevaluation(
        supabase,
        'company-1',
        BALANCE_DATE,
        'period-1',
        'user-1'
      )

      expect(result).not.toBeNull()
      expect(result!.entry.id).toBe('entry-1')
    })

    it('returns null when the RPC posts no entry', async () => {
      const eurInvoice = makeInvoice({
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
      })

      mockRates({ EUR: 11.5 })

      const { supabase } = createRevaluationMockSupabase({
        invoices: [eurInvoice],
        rpcResult: {
          data: { run_id: 'run-1', entry_id: null, reused: false },
          error: null,
        },
      })

      const result = await executeCurrencyRevaluation(
        supabase,
        'company-1',
        BALANCE_DATE,
        'period-1',
        'user-1'
      )

      expect(result).toBeNull()
    })

    it('throws BookkeepingDatabaseError when the RPC fails', async () => {
      const eurInvoice = makeInvoice({
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
      })

      mockRates({ EUR: 11.5 })

      const { supabase } = createRevaluationMockSupabase({
        invoices: [eurInvoice],
        rpcResult: { data: null, error: { message: 'period is locked' } },
      })

      await expect(
        executeCurrencyRevaluation(supabase, 'company-1', BALANCE_DATE, 'period-1', 'user-1')
      ).rejects.toThrow(BookkeepingDatabaseError)
      await expect(
        executeCurrencyRevaluation(supabase, 'company-1', BALANCE_DATE, 'period-1', 'user-1')
      ).rejects.toThrow('post_currency_revaluation')
    })

    it('throws BookkeepingDatabaseError when the posted entry cannot be fetched', async () => {
      const eurInvoice = makeInvoice({
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
      })

      mockRates({ EUR: 11.5 })

      const { supabase } = createRevaluationMockSupabase({
        invoices: [eurInvoice],
        errors: { journal_entries: 'connection lost' },
      })

      await expect(
        executeCurrencyRevaluation(supabase, 'company-1', BALANCE_DATE, 'period-1', 'user-1')
      ).rejects.toThrow('fetch_revaluation_entry')
    })
  })
})
