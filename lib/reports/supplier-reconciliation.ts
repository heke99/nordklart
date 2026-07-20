import type { SupabaseClient } from '@supabase/supabase-js'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { getHistoricalOpenSupplierInvoices } from '@/lib/invoices/historical-open-items'
import { roundOre } from '@/lib/money'

export interface ReconciliationResult {
  supplier_ledger_total: number
  /** Closing balance on 2440 AS OF the reconciliation date (A06). */
  account_2440_balance: number
  difference: number
  is_reconciled: boolean
  /** The date both sides were measured at. */
  as_of_date: string
  /**
   * Number of foreign-currency invoices that lacked an exchange_rate, so their
   * remaining_amount could not be converted to SEK. When > 0 the difference
   * field may be misleading: any reported gap could be missing-data rather
   * than a true reconciliation break.
   */
  unconverted_fx_count: number
  /** Unrealized FX revaluation adjustment included in the subledger total so
   *  it reconciles against the revalued GL balance (A08). */
  fx_revaluation_adjustment: number
}

/**
 * Compare the supplier ledger against the 2440 GL balance — BOTH measured at
 * the same date (revision item A06). Symmetric with the AR reconciliation:
 * historical open amounts at the date × invoice-date rate, plus persisted
 * unrealized FX revaluation adjustments (A08), vs the CLOSING 2440 balance
 * from the paginated trial balance (A07). Fails closed on DB errors (A10).
 */
export async function generateReconciliation(
  supabase: SupabaseClient,
  companyId: string,
  periodId: string,
  asOfDate?: string
): Promise<ReconciliationResult> {
  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('period_start, period_end')
    .eq('id', periodId)
    .eq('company_id', companyId)
    .single()
  if (periodError || !period) {
    throw new Error(`Räkenskapsperioden kunde inte läsas: ${periodError?.message ?? 'saknas'}`)
  }

  const today = new Date().toISOString().split('T')[0]
  const effectiveAsOf =
    asOfDate ?? (period.period_end < today ? (period.period_end as string) : today)

  const openItems = await getHistoricalOpenSupplierInvoices(supabase, companyId, effectiveAsOf)

  let unconvertedFxCount = 0
  let supplierLedgerTotal = 0
  for (const item of openItems) {
    const isFx = item.currency !== 'SEK'
    if (isFx && (item.exchange_rate == null || item.exchange_rate <= 0)) {
      unconvertedFxCount += 1
      continue
    }
    const sek = isFx
      ? roundOre(item.open_amount * (item.exchange_rate as number))
      : item.open_amount
    supplierLedgerTotal = roundOre(supplierLedgerTotal + sek)
  }

  // Unrealized FX revaluations on 2440 (A08). For payables the revaluation
  // item's unrealized_diff_sek is positive when the liability GREW, so it
  // adds to the ledger total the same way it adds to the credit balance.
  let fxAdjustment = 0
  const { data: revalItems, error: revalError } = await supabase
    .from('currency_revaluation_items')
    .select('unrealized_diff_sek, supplier_invoice_id, run:currency_revaluation_runs!inner(status, balance_date, company_id)')
    .eq('company_id', companyId)
    .eq('run.company_id', companyId)
    .eq('run.status', 'posted')
    .lte('run.balance_date', effectiveAsOf)
    .not('supplier_invoice_id', 'is', null)
  if (revalError) {
    throw new Error(`Valutaomvärderingsunderlaget kunde inte läsas: ${revalError.message}`)
  }
  for (const item of revalItems ?? []) {
    fxAdjustment = roundOre(fxAdjustment + (Number(item.unrealized_diff_sek) || 0))
  }
  supplierLedgerTotal = roundOre(supplierLedgerTotal + fxAdjustment)

  // GL: CLOSING balance of 2440 (credit-normal) as of the same date.
  const { rows } = await generateTrialBalance(supabase, companyId, periodId, {
    toDate: effectiveAsOf,
  })
  let account2440Balance = 0
  for (const row of rows) {
    if (row.account_number === '2440') {
      account2440Balance =
        roundOre(account2440Balance + row.closing_credit - row.closing_debit)
    }
  }

  const difference = roundOre(supplierLedgerTotal - account2440Balance)

  return {
    supplier_ledger_total: roundOre(supplierLedgerTotal),
    account_2440_balance: roundOre(account2440Balance),
    difference,
    is_reconciled: Math.abs(difference) < 0.01 && unconvertedFxCount === 0,
    as_of_date: effectiveAsOf,
    unconverted_fx_count: unconvertedFxCount,
    fx_revaluation_adjustment: fxAdjustment,
  }
}
