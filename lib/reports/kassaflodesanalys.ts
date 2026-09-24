import type { SupabaseClient } from '@supabase/supabase-js'
import { generateTrialBalance } from './trial-balance'
import type { TrialBalanceRow } from '@/types'
import { roundOre } from '@/lib/money'

/**
 * Kassaflödesanalys (Cash Flow Statement) — indirect method per BFNAR 2012:1 ch 7.
 *
 * Three sections:
 *   - Löpande verksamhet (Operating activities)
 *   - Investeringsverksamhet (Investing activities)
 *   - Finansieringsverksamhet (Financing activities)
 *
 * The indirect method starts from "Resultat efter finansiella poster", adds
 * back non-cash items (avskrivningar, periodiseringar), and adjusts for
 * working-capital movements. The sum across all three sections must equal
 * the actual change in cash & bank (19xx) balance over the period.
 *
 * Account-class mapping (BAS 2026):
 *   14xx  Lager / varulager                          → operating (Δ inventory)
 *   15xx  Kortfristiga fordringar (kundfordringar)   → operating (Δ receivables)
 *   24xx  Kortfristiga skulder (leverantörsskulder)  → operating (Δ payables)
 *   26xx  Moms och punktskatter                      → operating (Δ VAT)
 *   29xx  Upplupna kostnader/förutbetalda intäkter   → operating (Δ accruals)
 *   2510  Skatteskuld (income tax)                   → operating (skatt betald)
 *
 *   10xx-13xx  Anläggningstillgångar (capital goods) → investing
 *
 *   20xx  Eget kapital (nyemission, utdelning)       → financing
 *   23xx  Långfristiga skulder (lån)                 → financing
 *
 *   19xx  Kassa och bank                             → reconciliation (target)
 *
 * The reconciliation invariant: total_cash_flow MUST equal
 *   closing(19xx) - opening(19xx)
 * within 1 öre. Any mismatch signals a bookkeeping invariant violation
 * (e.g., journal entry posted to an account class we haven't mapped) and is
 * surfaced as a warning in the report so a human can investigate.
 */

export type KassaflodesanalysReport = {
  fiscal_period_id: string
  period_start: string
  period_end: string
  lopande: {
    resultat_efter_finansiella_poster: number
    avskrivningar: number
    ovriga_ej_kassaflodesposter: number
    delta_kortfristiga_fordringar: number
    delta_varulager: number
    delta_kortfristiga_skulder: number
    skatt_betald: number
    total: number
  }
  investerings: {
    forvarv_anlaggningar: number
    avyttring_anlaggningar: number
    total: number
  }
  finansierings: {
    delta_lan: number
    utdelningar: number
    nyemission: number
    /** Koncernbidrag, aktieägartillskott, egna uttag/insättningar (EF) m.m. */
    ovriga_finansiering: number
    total: number
  }
  total_cash_flow: number
  reconciliation: {
    opening_cash_1xxx: number
    closing_cash_1xxx: number
    delta_actual: number
    delta_calculated: number
    mismatch_amount: number
    is_reconciled: boolean
  }
}

// Normalize -0 → 0 so callers (and tests) never observe a signed zero.
// roundOre(0) happens to be 0, but roundOre(-0.001)
// returns -0 because Math.round preserves the sign of zero.
const r2 = (n: number) => {
  const rounded = roundOre(n)
  return rounded === 0 ? 0 : rounded
}

/**
 * Returns the signed balance change for an account between IB and UB.
 *
 * For asset accounts (debit-normal): positive = increase, negative = decrease
 * For liability/equity accounts (credit-normal): positive = increase
 *
 * We always compute `(closing_debit - closing_credit) - (opening_debit - opening_credit)`,
 * which gives the signed *debit-side* movement. Callers negate as needed for
 * credit-normal accounts.
 */
function debitSideDelta(row: TrialBalanceRow): number {
  const opening = (row.opening_debit || 0) - (row.opening_credit || 0)
  const closing = (row.closing_debit || 0) - (row.closing_credit || 0)
  return closing - opening
}

export async function generateKassaflodesanalys(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string
): Promise<KassaflodesanalysReport> {
  // Fetch period info for the report header.
  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('period_start, period_end')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  if (periodError) throw new Error(periodError.message)
  if (!period) throw new Error('Fiscal period not found')

  // Trial balance gives us opening + closing per account for the period.
  // We pass excludeYearEndClosing=true so that the working-capital movements
  // reflect actual transactional activity, not the year-end reclassification
  // entries that move resultaträkning balances into equity (8999 → 2099).
  // Without this filter, the closing entry for class 3-8 would inflate
  // "övriga ej-kassaflödesposter" and break the reconciliation.
  const { rows } = await generateTrialBalance(supabase, companyId, fiscalPeriodId, {
    excludeYearEndClosing: true,
  })

  // ── Classification ─────────────────────────────────────────────────────
  // Indirect method (K3 kap. 7; BFNAR 2012:1). Every balance-sheet account
  // belongs to exactly one bucket below, and every income-statement account
  // is either in the result or paired with a balance-sheet bucket that is
  // left out — so Δ cash reconciles by construction and a mismatch means data
  // the classification does not know, not an arithmetic slip.
  //
  //   19xx                      cash (reconciled against)
  //   10–13xx, 18xx             investing (incl. accumulated depreciation)
  //   14xx / 15–17xx            working capital: varulager / fordringar
  //   22xx                      avsättningar — non-cash adjustment
  //   21xx ↔ 88xx (ex 882–883)  bokslutsdispositioner — non-cash, both out
  //   25xx ↔ 89xx               tax: expense out of result, cash via liability
  //   23xx, 2410–2419,
  //   2480–2489, 2893           financing: loans
  //   2898                      financing: decided dividends
  //   20xx                      financing: equity
  //   882x–883x                 financing: koncernbidrag
  //   other 24xx, 26–29xx       working capital: kortfristiga skulder
  const inPrefixes = (account: string, prefixes: string[]) => prefixes.some((p) => account.startsWith(p))
  const between = (account: string, from: string, to: string) => account >= from && account <= to
  const isShortTermLoan = (a: string) => between(a, '2410', '2419') || between(a, '2480', '2489') || a === '2893'

  const periodNet = (predicate: (account: string) => boolean) =>
    rows
      .filter((r) => predicate(r.account_number))
      .reduce((sum, r) => sum + ((r.period_debit || 0) - (r.period_credit || 0)), 0)
  const deltaOf = (predicate: (account: string) => boolean) =>
    rows.filter((r) => predicate(r.account_number)).reduce((sum, r) => sum + debitSideDelta(r), 0)

  // Resultat efter finansiella poster: classes 3–8 excluding bokslutsdispositioner
  // (88xx) and skatt/årets resultat (89xx). Income is negative on the debit side.
  const resultatEfterFinansiella = r2(
    -periodNet((a) => a >= '3000' && a <= '8799'),
  )

  // ─── Löpande verksamhet ────────────────────────────────────────────────
  // Av- och nedskrivningar (77xx–78xx) reduced the result without moving cash.
  const avskrivningar = r2(periodNet((a) => between(a, '7700', '7899')))

  // Avsättningar (22xx): an increase was expensed but not paid.
  const ovrigaEjKassaflodesposter = r2(-deltaOf((a) => a.startsWith('22')))

  // Working capital. Asset growth consumes cash; liability growth retains it.
  const deltaKortfristigaFordringar = r2(-deltaOf((a) => inPrefixes(a, ['15', '16', '17'])))
  const deltaVarulager = r2(-deltaOf((a) => a.startsWith('14')))
  const deltaKortfristigaSkulder = r2(
    -deltaOf(
      (a) =>
        (a.startsWith('24') || inPrefixes(a, ['26', '27', '28', '29'])) &&
        !isShortTermLoan(a) &&
        a !== '2898',
    ),
  )

  // Betald skatt = −(årets skattekostnad 89xx ex 899x) + ökning av skatteskulder (25xx).
  const taxExpense = periodNet((a) => between(a, '8900', '8989'))
  const skattBetald = r2(-taxExpense - deltaOf((a) => a.startsWith('25')))

  const totalLopande = r2(
    resultatEfterFinansiella +
      avskrivningar +
      ovrigaEjKassaflodesposter +
      deltaKortfristigaFordringar +
      deltaVarulager +
      deltaKortfristigaSkulder +
      skattBetald
  )

  // ─── Investeringsverksamhet ────────────────────────────────────────────
  // Change in the NET carrying amount of 10–13xx (accumulated depreciation
  // included, whatever its account number) plus this year's depreciation is
  // the net investment. 18xx kortfristiga placeringar are investing too.
  const fixedAssetNetInvestment = deltaOf((a) => inPrefixes(a, ['10', '11', '12', '13'])) + avskrivningar
  const placeringar = deltaOf((a) => a.startsWith('18'))
  const netInvestment = fixedAssetNetInvestment + placeringar
  const forvarv = r2(netInvestment > 0 ? -netInvestment : 0)
  const avyttring = r2(netInvestment < 0 ? -netInvestment : 0)

  const totalInvesterings = r2(forvarv + avyttring)

  // ─── Finansieringsverksamhet ───────────────────────────────────────────
  const deltaLan = r2(-deltaOf((a) => a.startsWith('23') || isShortTermLoan(a)))

  // Decided dividends are credited to 2898 (against equity) and paid from it:
  // the cash paid is the debit movement on 2898.
  const dividendRows = rows.filter((r) => r.account_number === '2898')
  const dividendsPaid = dividendRows.reduce((sum, r) => sum + (r.period_debit || 0), 0)
  const dividendsDecided = dividendRows.reduce((sum, r) => sum + (r.period_credit || 0), 0)
  const utdelningar = r2(-dividendsPaid)

  // Nyemission: aktiekapital, ej registrerat aktiekapital, överkursfond.
  const nyemission = r2(-deltaOf((a) => inPrefixes(a, ['2081', '2082', '2087', '2097'])))

  // Remaining equity movements (aktieägartillskott, egna uttag/insättningar in
  // enskild firma, the equity side of dividends) and koncernbidrag.
  const otherEquity = -deltaOf(
    (a) => a.startsWith('20') && !inPrefixes(a, ['2081', '2082', '2087', '2097']),
  )
  const koncernbidrag = -periodNet((a) => between(a, '8820', '8839'))
  // The equity debit of a decided dividend is matched by its 2898 credit —
  // neither is cash until 2898 is paid, which utdelningar already shows.
  const ovrigaFinansiering = r2(otherEquity + dividendsDecided + koncernbidrag)

  const totalFinansierings = r2(deltaLan + utdelningar + nyemission + ovrigaFinansiering)

  // ─── Total cash flow ───────────────────────────────────────────────────
  const totalCashFlow = r2(totalLopande + totalInvesterings + totalFinansierings)

  // ─── Reconciliation against 19xx ───────────────────────────────────────
  const cash1xxxRows = rows.filter((r) => r.account_number.startsWith('19'))
  const openingCash = r2(
    cash1xxxRows.reduce(
      (sum, r) => sum + ((r.opening_debit || 0) - (r.opening_credit || 0)),
      0
    )
  )
  const closingCash = r2(
    cash1xxxRows.reduce(
      (sum, r) => sum + ((r.closing_debit || 0) - (r.closing_credit || 0)),
      0
    )
  )
  const deltaActual = r2(closingCash - openingCash)
  const mismatchAmount = r2(deltaActual - totalCashFlow)
  const isReconciled = Math.abs(mismatchAmount) < 0.01

  return {
    fiscal_period_id: fiscalPeriodId,
    period_start: period.period_start,
    period_end: period.period_end,
    lopande: {
      resultat_efter_finansiella_poster: resultatEfterFinansiella,
      avskrivningar,
      ovriga_ej_kassaflodesposter: ovrigaEjKassaflodesposter,
      delta_kortfristiga_fordringar: deltaKortfristigaFordringar,
      delta_varulager: deltaVarulager,
      delta_kortfristiga_skulder: deltaKortfristigaSkulder,
      skatt_betald: skattBetald,
      total: totalLopande,
    },
    investerings: {
      forvarv_anlaggningar: forvarv,
      avyttring_anlaggningar: avyttring,
      total: totalInvesterings,
    },
    finansierings: {
      delta_lan: deltaLan,
      utdelningar,
      nyemission,
      ovriga_finansiering: ovrigaFinansiering,
      total: totalFinansierings,
    },
    total_cash_flow: totalCashFlow,
    reconciliation: {
      opening_cash_1xxx: openingCash,
      closing_cash_1xxx: closingCash,
      delta_actual: deltaActual,
      delta_calculated: totalCashFlow,
      mismatch_amount: mismatchAmount,
      is_reconciled: isReconciled,
    },
  }
}
