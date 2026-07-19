import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'

export interface SupplierLedgerEntry {
  supplier_id: string
  supplier_name: string
  current: number
  days_1_30: number
  days_31_60: number
  days_61_90: number
  days_90_plus: number
  total_outstanding: number
}

export interface SupplierLedgerReport {
  entries: SupplierLedgerEntry[]
  total_outstanding: number
  total_current: number
  total_overdue: number
  unpaid_count: number
  /**
   * Number of foreign-currency invoices excluded from the SEK totals because
   * they had no exchange_rate. Adding them would mix currencies; surfacing
   * the count lets the UI tell the user a row could not be converted.
   */
  unconverted_fx_count: number
}

/**
 * Generate supplier ledger (leverantörsreskontra) with aging analysis
 */
export async function generateSupplierLedger(
  supabase: SupabaseClient,
  companyId: string,
  asOfDate?: string
): Promise<SupplierLedgerReport> {
  const refDate = asOfDate ? new Date(asOfDate) : new Date()

  // Historical snapshot (A09): with asOfDate the open set and amounts are
  // reconstructed as of that date via the shared historical module.
  const historicalOpenByInvoice = new Map<string, number>()
  let historicalIds: Set<string> | null = null
  if (asOfDate) {
    const { getHistoricalOpenSupplierInvoices } = await import(
      '@/lib/invoices/historical-open-items'
    )
    const openItems = await getHistoricalOpenSupplierInvoices(supabase, companyId, asOfDate)
    historicalIds = new Set(openItems.map((i) => i.id))
    for (const item of openItems) historicalOpenByInvoice.set(item.id, item.open_amount)
  }

  // Fetch supplier invoices. For the historical path we fetch by id set (the
  // statuses today say nothing about what was open on the date). Fails closed
  // (A10): query errors throw — never an empty zero report.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const invoices: any[] = await fetchAllRows(({ from, to }) => {
    let q = supabase
      .from('supplier_invoices')
      .select('*, supplier:suppliers(id, name)')
      .eq('company_id', companyId)
    if (historicalIds) {
      q = q.in('id', [...historicalIds])
    } else {
      q = q.in('status', ['registered', 'approved', 'partially_paid', 'overdue'])
    }
    return q.range(from, to)
  }).catch((err: Error) => {
    throw new Error(`Leverantörsreskontran kunde inte läsas: ${err.message}`)
  })

  // Group by supplier and calculate aging
  const bySupplier = new Map<string, SupplierLedgerEntry>()
  let unconvertedFxCount = 0

  for (const inv of invoices) {
    const supplierId = inv.supplier_id
    const supplierName = inv.supplier?.name || 'Okänd leverantör'

    // Foreign-currency invoice with no exchange_rate cannot be converted to
    // SEK; adding the raw foreign amount to a SEK total would be unsound, so
    // the row is excluded from sums and only counted.
    const isFx = inv.currency && inv.currency !== 'SEK'
    const hasRate = inv.exchange_rate != null && Number(inv.exchange_rate) > 0
    if (isFx && !hasRate) {
      unconvertedFxCount += 1
      continue
    }

    if (!bySupplier.has(supplierId)) {
      bySupplier.set(supplierId, {
        supplier_id: supplierId,
        supplier_name: supplierName,
        current: 0,
        days_1_30: 0,
        days_31_60: 0,
        days_61_90: 0,
        days_90_plus: 0,
        total_outstanding: 0,
      })
    }

    const entry = bySupplier.get(supplierId)!
    const dueDate = new Date(inv.due_date)
    const daysOverdue = Math.floor((refDate.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
    // Outstanding in invoice currency: the HISTORICAL open amount when an
    // asOfDate snapshot was requested (A09), otherwise the current
    // remaining_amount. The 2440 GL line was posted in SEK at the
    // invoice-date rate, so convert for the reconciliation.
    const outstandingCurrency = historicalIds
      ? (historicalOpenByInvoice.get(inv.id) ?? 0)
      : Number(inv.remaining_amount) || 0
    const amount = resolveSekAmount(
      outstandingCurrency,
      null,
      inv.currency,
      inv.exchange_rate
    )

    if (daysOverdue <= 0) {
      entry.current += amount
    } else if (daysOverdue <= 30) {
      entry.days_1_30 += amount
    } else if (daysOverdue <= 60) {
      entry.days_31_60 += amount
    } else if (daysOverdue <= 90) {
      entry.days_61_90 += amount
    } else {
      entry.days_90_plus += amount
    }

    entry.total_outstanding += amount
  }

  const entries = Array.from(bySupplier.values())
    .sort((a, b) => b.total_outstanding - a.total_outstanding)

  const total_outstanding = entries.reduce((sum, e) => sum + e.total_outstanding, 0)
  const total_current = entries.reduce((sum, e) => sum + e.current, 0)
  const total_overdue = total_outstanding - total_current

  return {
    entries,
    total_outstanding: Math.round(total_outstanding * 100) / 100,
    total_current: Math.round(total_current * 100) / 100,
    total_overdue: Math.round(total_overdue * 100) / 100,
    unpaid_count: invoices.length,
    unconverted_fx_count: unconvertedFxCount,
  }
}
