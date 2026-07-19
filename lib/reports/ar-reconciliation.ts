import type { SupabaseClient } from '@supabase/supabase-js'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { getHistoricalOpenInvoices } from '@/lib/invoices/historical-open-items'
import { roundOre } from '@/lib/money'

export interface ARReconciliationResult {
  ar_ledger_total: number
  /**
   * Closing balance on accounts 1510 (Kundfordringar) and 1513
   * (Kundfordringar – delad faktura) AS OF the reconciliation date —
   * opening balance plus movements, not just the period movement (A06).
   */
  account_1510_balance: number
  difference: number
  is_reconciled: boolean
  /** The date both sides were measured at. */
  as_of_date: string
  /**
   * Number of foreign-currency invoices that lacked an exchange_rate, so their
   * outstanding amount could not be converted to SEK. When > 0 the difference
   * field may be misleading: any reported gap could be missing-data rather
   * than a true reconciliation break.
   */
  unconverted_fx_count: number
  /** Unrealized FX revaluation adjustment included in the subledger total so
   *  it reconciles against the revalued GL balance (A08). */
  fx_revaluation_adjustment: number
}

/**
 * Compare the customer ledger against the 1510/1513 GL balance — BOTH
 * measured at the same date (revision item A06):
 *
 *   - Subledger: invoices open AT the reconciliation date with their
 *     historically open amounts (payments/credits after the date excluded),
 *     converted at the invoice-date rate — exactly what was posted to 1510.
 *   - GL: the CLOSING balance (opening + movements) of 1510/1513 as of the
 *     same date, via the paginated trial balance (A07).
 *   - Unrealized FX revaluations posted to 1510 are added to the subledger
 *     side from the persisted revaluation snapshot, so a revalued GL balance
 *     reconciles exactly (A08).
 *
 * Fails closed (A10): database errors throw — never an empty zero report.
 */
export async function generateARReconciliation(
  supabase: SupabaseClient,
  companyId: string,
  periodId: string,
  asOfDate?: string
): Promise<ARReconciliationResult> {
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

  // Subledger: historically open invoices at the reconciliation date.
  const openItems = await getHistoricalOpenInvoices(supabase, companyId, effectiveAsOf)

  let unconvertedFxCount = 0
  let arLedgerTotal = 0
  for (const item of openItems) {
    const isFx = item.currency !== 'SEK'
    if (isFx && (item.exchange_rate == null || item.exchange_rate <= 0)) {
      unconvertedFxCount += 1
      continue
    }
    const sek = isFx
      ? roundOre(item.open_amount * (item.exchange_rate as number))
      : item.open_amount
    arLedgerTotal = roundOre(arLedgerTotal + sek)
  }

  // Unrealized FX adjustments posted to 1510 (A08): the GL balance includes
  // them, so the subledger side must too — from the persisted snapshot.
  let fxAdjustment = 0
  const { data: revalItems, error: revalError } = await supabase
    .from('currency_revaluation_items')
    .select('unrealized_diff_sek, invoice_id, run:currency_revaluation_runs!inner(status, balance_date, company_id)')
    .eq('company_id', companyId)
    .eq('run.company_id', companyId)
    .eq('run.status', 'posted')
    .lte('run.balance_date', effectiveAsOf)
    .not('invoice_id', 'is', null)
  if (revalError) {
    throw new Error(`Valutaomvärderingsunderlaget kunde inte läsas: ${revalError.message}`)
  }
  for (const item of revalItems ?? []) {
    fxAdjustment = roundOre(fxAdjustment + (Number(item.unrealized_diff_sek) || 0))
  }
  arLedgerTotal = roundOre(arLedgerTotal + fxAdjustment)

  // GL: CLOSING balance of 1510 + 1513 as of the same date (opening +
  // movements), via the paginated trial balance (A06/A07).
  const { rows } = await generateTrialBalance(supabase, companyId, periodId, {
    toDate: effectiveAsOf,
  })
  let account1510Balance = 0
  for (const row of rows) {
    if (row.account_number === '1510' || row.account_number === '1513') {
      account1510Balance =
        roundOre(account1510Balance + row.closing_debit - row.closing_credit)
    }
  }

  const difference = roundOre(arLedgerTotal - account1510Balance)

  return {
    ar_ledger_total: roundOre(arLedgerTotal),
    account_1510_balance: roundOre(account1510Balance),
    difference,
    // BFL 5 kap requires the reconciliation to cover all affärshändelser. If
    // any row was excluded for a missing exchange rate, the calculation is
    // incomplete by construction and we cannot honestly stamp the period
    // Avstämd — the user must fix the underlying data first.
    is_reconciled: Math.abs(difference) < 0.01 && unconvertedFxCount === 0,
    as_of_date: effectiveAsOf,
    unconverted_fx_count: unconvertedFxCount,
    fx_revaluation_adjustment: fxAdjustment,
  }
}
