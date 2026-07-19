import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

/**
 * Historical open-item reconstruction (revision items B06, B07, B14, A06, A09).
 *
 * Answers "what was open on the balance date?" — not "what is open now".
 * Used by currency revaluation, AR/AP ledgers with asOfDate, AR/AP
 * reconciliation and year-end readiness so every module shares ONE
 * canonical definition of an open item (B14).
 *
 * Rules:
 *   - an invoice created after the balance date is excluded,
 *   - an invoice open on the balance date but settled later is included
 *     with the amount that was open on the balance date,
 *   - payments/refunds are counted only when payment_date <= asOfDate
 *     (partial payments reduce the open amount, B07),
 *   - credit notes dated on/before the balance date net against the
 *     credited invoice,
 *   - write-offs dated on/before the balance date zero the open amount.
 */

export interface HistoricalOpenItem {
  id: string
  type: 'invoice' | 'supplier_invoice'
  reference: string
  currency: string
  /** Original booking rate (invoice-date rate). Null when never converted. */
  exchange_rate: number | null
  invoice_date: string
  due_date: string | null
  customer_id?: string | null
  supplier_id?: string | null
  /** Document total in document currency. */
  total: number
  /** Amount open at the balance date, in document currency. */
  open_amount: number
  /** The invoice's current status (informational — not used in the math). */
  current_status: string
}

const round2 = (x: number): number => Math.round(x * 100) / 100

interface InvoiceRow {
  id: string
  invoice_number: string | null
  external_invoice_number: string | null
  invoice_date: string | null
  due_date: string | null
  customer_id: string | null
  status: string
  currency: string | null
  exchange_rate: number | null
  total: number | null
  credited_invoice_id: string | null
  written_off_at: string | null
}

interface SupplierInvoiceRow {
  id: string
  supplier_invoice_number: string | null
  invoice_date: string | null
  due_date: string | null
  supplier_id: string | null
  status: string
  currency: string | null
  exchange_rate: number | null
  total: number | null
  is_credit_note: boolean | null
  credited_invoice_id: string | null
  reversed_at: string | null
}

interface PaymentRow {
  invoice_id?: string
  supplier_invoice_id?: string
  payment_date: string
  amount: number | null
}

/**
 * Customer invoices open at `asOfDate` with the historically open amount.
 * Throws on database errors — never silently returns an empty ledger (A10).
 */
export async function getHistoricalOpenInvoices(
  supabase: SupabaseClient,
  companyId: string,
  asOfDate: string,
): Promise<HistoricalOpenItem[]> {
  const invoices = await fetchAllRows<InvoiceRow>(({ from, to }) =>
    supabase
      .from('invoices')
      .select(
        'id, invoice_number, external_invoice_number, invoice_date, due_date, customer_id, status, currency, exchange_rate, total, credited_invoice_id, written_off_at',
      )
      .eq('company_id', companyId)
      .lte('invoice_date', asOfDate)
      .not('status', 'in', '("draft","cancelled")')
      .order('id', { ascending: true })
      .range(from, to),
  )

  const payments = await fetchAllRows<PaymentRow>(({ from, to }) =>
    supabase
      .from('invoice_payments')
      .select('invoice_id, payment_date, amount')
      .eq('company_id', companyId)
      .lte('payment_date', asOfDate)
      .order('id', { ascending: true })
      .range(from, to),
  )

  const paidByInvoice = new Map<string, number>()
  for (const p of payments) {
    if (!p.invoice_id) continue
    paidByInvoice.set(
      p.invoice_id,
      round2((paidByInvoice.get(p.invoice_id) ?? 0) + (Number(p.amount) || 0)),
    )
  }

  // Credit notes dated on/before the balance date net against the credited
  // invoice. Credit note totals are negative by convention.
  const creditByInvoice = new Map<string, number>()
  for (const inv of invoices) {
    if (!inv.credited_invoice_id) continue
    creditByInvoice.set(
      inv.credited_invoice_id,
      round2((creditByInvoice.get(inv.credited_invoice_id) ?? 0) + Math.abs(Number(inv.total) || 0)),
    )
  }

  const items: HistoricalOpenItem[] = []
  for (const inv of invoices) {
    if (inv.credited_invoice_id) continue // credit notes are netted, not listed
    if (inv.written_off_at && inv.written_off_at.slice(0, 10) <= asOfDate) continue

    const total = Number(inv.total) || 0
    const paid = paidByInvoice.get(inv.id) ?? 0
    const credited = creditByInvoice.get(inv.id) ?? 0
    const open = round2(total - paid - credited)
    if (Math.abs(open) < 0.005) continue

    items.push({
      id: inv.id,
      type: 'invoice',
      reference: inv.invoice_number || inv.external_invoice_number || '',
      currency: inv.currency || 'SEK',
      exchange_rate: inv.exchange_rate != null ? Number(inv.exchange_rate) : null,
      invoice_date: inv.invoice_date || '',
      due_date: inv.due_date,
      customer_id: inv.customer_id,
      total,
      open_amount: open,
      current_status: inv.status,
    })
  }

  return items
}

/**
 * Supplier invoices open at `asOfDate` with the historically open amount.
 * Symmetric with getHistoricalOpenInvoices (B07).
 */
export async function getHistoricalOpenSupplierInvoices(
  supabase: SupabaseClient,
  companyId: string,
  asOfDate: string,
): Promise<HistoricalOpenItem[]> {
  const invoices = await fetchAllRows<SupplierInvoiceRow>(({ from, to }) =>
    supabase
      .from('supplier_invoices')
      .select(
        'id, supplier_invoice_number, invoice_date, due_date, supplier_id, status, currency, exchange_rate, total, is_credit_note, credited_invoice_id, reversed_at',
      )
      .eq('company_id', companyId)
      .lte('invoice_date', asOfDate)
      .neq('status', 'reversed')
      .order('id', { ascending: true })
      .range(from, to),
  )

  const payments = await fetchAllRows<PaymentRow>(({ from, to }) =>
    supabase
      .from('supplier_invoice_payments')
      .select('supplier_invoice_id, payment_date, amount')
      .eq('company_id', companyId)
      .lte('payment_date', asOfDate)
      .order('id', { ascending: true })
      .range(from, to),
  )

  const paidByInvoice = new Map<string, number>()
  for (const p of payments) {
    if (!p.supplier_invoice_id) continue
    paidByInvoice.set(
      p.supplier_invoice_id,
      round2((paidByInvoice.get(p.supplier_invoice_id) ?? 0) + (Number(p.amount) || 0)),
    )
  }

  const creditByInvoice = new Map<string, number>()
  for (const si of invoices) {
    if (!si.is_credit_note || !si.credited_invoice_id) continue
    creditByInvoice.set(
      si.credited_invoice_id,
      round2(
        (creditByInvoice.get(si.credited_invoice_id) ?? 0) + Math.abs(Number(si.total) || 0),
      ),
    )
  }

  const items: HistoricalOpenItem[] = []
  for (const si of invoices) {
    if (si.is_credit_note) continue

    const total = Number(si.total) || 0
    const paid = paidByInvoice.get(si.id) ?? 0
    const credited = creditByInvoice.get(si.id) ?? 0
    const open = round2(total - paid - credited)
    if (Math.abs(open) < 0.005) continue

    items.push({
      id: si.id,
      type: 'supplier_invoice',
      reference: si.supplier_invoice_number || '',
      currency: si.currency || 'SEK',
      exchange_rate: si.exchange_rate != null ? Number(si.exchange_rate) : null,
      invoice_date: si.invoice_date || '',
      due_date: si.due_date,
      supplier_id: si.supplier_id,
      total,
      open_amount: open,
      current_status: si.status,
    })
  }

  return items
}

/**
 * Foreign-currency subset with a known booking rate — the canonical FX
 * exposure used by revaluation, readiness and reports (B14).
 */
export async function getHistoricalFxExposure(
  supabase: SupabaseClient,
  companyId: string,
  asOfDate: string,
): Promise<{ receivables: HistoricalOpenItem[]; payables: HistoricalOpenItem[] }> {
  const [receivables, payables] = await Promise.all([
    getHistoricalOpenInvoices(supabase, companyId, asOfDate),
    getHistoricalOpenSupplierInvoices(supabase, companyId, asOfDate),
  ])
  const fx = (i: HistoricalOpenItem) =>
    i.currency !== 'SEK' && i.exchange_rate != null && i.open_amount > 0
  return {
    receivables: receivables.filter(fx),
    payables: payables.filter(fx),
  }
}
