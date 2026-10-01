/**
 * executeRecurringSchedule, second version: the billing period on the
 * invoice, period placeholders, lines limited to a period, and VAT handled
 * by the same builder as a manual invoice.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events'

vi.mock('@/lib/invoices/ensure-invoice-number', () => ({ ensureInvoiceNumber: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/currency/riksbanken', () => ({ fetchExchangeRate: vi.fn().mockResolvedValue(null), convertToSEK: vi.fn() }))
vi.mock('@react-pdf/renderer', () => ({ renderToBuffer: vi.fn() }))
vi.mock('@/lib/invoices/pdf-template', () => ({ InvoicePDF: vi.fn(() => ({})) }))

import { executeRecurringSchedule, RecurringRunSkipped } from '@/lib/invoices/recurring-schedule-service'
import type { RecurringInvoiceSchedule, RecurringInvoiceScheduleItem } from '@/types'

// Records inserts; reads are answered per table.
const inserts: Record<string, unknown[]> = {}
let customerRow: Record<string, unknown>
let vatRegistered = true
function chain(table: string): unknown {
  let insertPayload: unknown = null
  const resolve = () => {
    if (table === 'customers') return { data: customerRow, error: null }
    if (table === 'company_settings') return { data: { vat_registered: vatRegistered, accounting_method: 'accrual' }, error: null }
    if (table === 'invoices' && insertPayload) return { data: { id: 'inv-1', ...(insertPayload as object) }, error: null }
    if (table === 'invoices') return { data: { id: 'inv-1', invoice_number: 'F-1', customer: customerRow, items: [] }, error: null }
    return { data: null, error: null }
  }
  const proxy: unknown = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (r: (v: unknown) => void) => r(resolve())
      if (prop === 'insert') {
        return (payload: unknown) => {
          insertPayload = payload
          ;(inserts[table] ??= []).push(payload)
          return proxy
        }
      }
      return () => proxy
    },
  })
  return proxy
}
const supabase = { from: (t: string) => chain(t) }

function item(overrides: Partial<RecurringInvoiceScheduleItem> = {}): RecurringInvoiceScheduleItem {
  return {
    id: 'item-1', schedule_id: 's', sort_order: 0, description: 'Hyra {period}', quantity: 1, unit: 'mån',
    unit_price: 10000, vat_rate: null, article_id: null, revenue_account: null, valid_from: null,
    valid_until: null, remaining_occurrences: null, created_at: '2026-01-01', ...overrides,
  }
}

function schedule(overrides: Partial<RecurringInvoiceSchedule> = {}, items = [item()]) {
  return {
    id: 's', company_id: 'c', user_id: 'u', customer_id: 'cust', name: 'Hyra', day_of_month: 25,
    interval_months: 1, billing_timing: 'next_period', sale_type: 'services', end_date: null,
    max_occurrences: null, ended_at: null, payment_terms_days: 30, currency: 'SEK', your_reference: null,
    our_reference: null, notes: null, auto_send: false, status: 'active', next_run_date: '2026-10-25',
    last_run_at: null, last_invoice_id: null, last_run_warning: null, generated_count: 0,
    created_at: '2026-01-01', updated_at: '2026-01-01', items, ...overrides,
  } as RecurringInvoiceSchedule & { items: RecurringInvoiceScheduleItem[] }
}

const runDay = new Date(Date.UTC(2026, 9, 25))

beforeEach(() => {
  for (const k of Object.keys(inserts)) delete inserts[k]
  vatRegistered = true
  customerRow = { id: 'cust', name: 'Hyresgäst AB', customer_type: 'swedish_business', vat_number_validated: false, email: 'a@b.se' }
  eventBus.clear()
})

describe('executeRecurringSchedule v2', () => {
  it('stores the billing period and fills the period placeholder', async () => {
    const result = await executeRecurringSchedule(supabase as never, schedule(), runDay, '2026-10-25')

    expect(result.period).toEqual({ start: '2026-11-01', end: '2026-11-30' })
    const header = inserts.invoices[0] as Record<string, unknown>
    expect(header).toMatchObject({ period_start: '2026-11-01', period_end: '2026-11-30', invoice_date: '2026-10-25', due_date: '2026-11-24' })
    const rows = inserts.invoice_items[0] as Array<Record<string, unknown>>
    expect(rows[0].description).toBe('Hyra november 2026')
  })

  it('includes a one-month line only in its month', async () => {
    const extra = item({ id: 'item-2', sort_order: 1, description: 'Städning', unit_price: 500, valid_from: '2026-11-01', valid_until: '2026-11-30' })
    const november = await executeRecurringSchedule(supabase as never, schedule({}, [item(), extra]), runDay, '2026-10-25')
    expect(november.usedItemIds).toEqual(['item-1', 'item-2'])

    for (const k of Object.keys(inserts)) delete inserts[k]
    const december = await executeRecurringSchedule(supabase as never, schedule({}, [item(), extra]), new Date(Date.UTC(2026, 10, 25)), '2026-11-25')
    expect(december.usedItemIds).toEqual(['item-1'])
  })

  it('skips the run when no line applies to the period', async () => {
    const onlyDecember = item({ valid_from: '2026-12-01', valid_until: '2026-12-31' })
    await expect(
      executeRecurringSchedule(supabase as never, schedule({}, [onlyDecember]), runDay, '2026-10-25'),
    ).rejects.toBeInstanceOf(RecurringRunSkipped)
    expect(inserts.invoices).toBeUndefined()
  })

  it('charges no VAT when the company is not VAT registered', async () => {
    vatRegistered = false
    await executeRecurringSchedule(supabase as never, schedule({}, [item({ vat_rate: 25 })]), runDay, '2026-10-25')
    const header = inserts.invoices[0] as Record<string, unknown>
    expect(header.vat_amount).toBe(0)
    expect(header.total).toBe(10000)
  })

  it('applies the customer default VAT rate to lines without one', async () => {
    await executeRecurringSchedule(supabase as never, schedule(), runDay, '2026-10-25')
    const header = inserts.invoices[0] as Record<string, unknown>
    expect(header.vat_amount).toBe(2500)
    expect(header.total).toBe(12500)
  })

  it('refuses a reverse-charge invoice without the buyer VAT number', async () => {
    customerRow = { id: 'cust', name: 'EU GmbH', customer_type: 'eu_business', vat_number_validated: true, vat_number: null }
    await expect(
      executeRecurringSchedule(supabase as never, schedule({}, [item({ vat_rate: 0 })]), runDay, '2026-10-25'),
    ).rejects.toThrow(/RC_VAT_NUMBER_MISSING/)
    expect(inserts.invoices).toBeUndefined()
  })
})
