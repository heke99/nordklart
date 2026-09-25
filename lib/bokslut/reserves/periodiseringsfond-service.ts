import type { SupabaseClient } from '@supabase/supabase-js'
import type { ProposedDisposition } from '../types'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { roundOre } from '@/lib/money'

/** Maximum periodiseringsfond avsättning for aktiebolag: 25 % of skattemässigt
 *  resultat före avsättning. Enskild firma uses 30 % but is handled in NE/INK1
 *  rather than booked. */
export const PFOND_AB_RATE = 0.25
export const PFOND_AB_RATE_PCT = '25 %'

/** Mandatory holding period — a fond avsatt år N must be återförd no later
 *  than räkenskapsår N+6 (IL 30 kap 7 §). */
export const PFOND_MAX_HOLD_YEARS = 6

/**
 * BAS account convention: account = '212' + (fiscalYear % 10). 2020 → '2120',
 * 2025 → '2125'. The collision year 2019/2029 maps to '2129' per the BAS
 * 2020 seed; if a company has fonder in both years on the same account, the
 * service surfaces a warning so the user can split the balance manually.
 */
export function getPeriodiseringsfondCohortAccount(fiscalYear: number): string {
  if (fiscalYear === 2019) return '2129'
  return '212' + (fiscalYear % 10).toString()
}

export interface ExistingFond {
  /** BAS account number for the cohort (e.g. '2120'). */
  account_number: string
  /**
   * Year the fund was set aside. Null for the 2110 grouping account, which
   * carries no year — such a fund is still counted for schablonintäkt and
   * flagged, but cannot be forced back automatically.
   */
  cohort_year: number | null
  /** Credit balance at the start of the fiscal year (basis for schablonintäkt). */
  opening_balance: number
  /** Credit balance at the end of the fiscal year (what can be returned). */
  balance: number
  /** True if the fond must be returned this year (cohort_year + 6 ≤ closing_year). */
  must_return_this_year: boolean
}

export interface PfondAvsattningInput {
  /** Skattemässigt resultat före avsättning. 25 % cap is applied to this. */
  skattemassigtResultatBeforeAvsattning: number
  /** Amount the user wants to set aside. Defaults to the maximum (25 %). */
  desiredAmount?: number
  /** Closing year of the fiscal period (e.g. 2025 for FY ending 2025-12-31).
   *  Determines which cohort account to use. */
  fiscalYear: number
  /** Versioned maximum rate from the year-end ruleset. */
  rate?: number
}

export interface PfondAvsattningComputation {
  rate: number
  maxAmount: number
  desiredAmount: number
  actualAmount: number
  cohortAccount: string
  cohortYear: number
  cappedToMax: boolean
}

/**
 * Propose a periodiseringsfond avsättning. Caps the user's desired amount
 * to 25 % of skattemässigt resultat före avsättning (rounded down to whole
 * krona). Returns null when no positive avsättning would result (loss year
 * or zero desired).
 */
export function proposeAvsattning(input: PfondAvsattningInput): ProposedDisposition | null {
  const base = Math.max(0, Math.floor(input.skattemassigtResultatBeforeAvsattning))
  const rate = input.rate ?? PFOND_AB_RATE
  const rateLabel = `${Math.round(rate * 10_000) / 100} %`
  const maxAmount = Math.floor(base * rate)
  const desiredAmount = Math.max(0, Math.floor(input.desiredAmount ?? maxAmount))
  const actualAmount = Math.min(desiredAmount, maxAmount)
  const cohortAccount = getPeriodiseringsfondCohortAccount(input.fiscalYear)
  const cappedToMax = desiredAmount > maxAmount

  if (actualAmount === 0) {
    return null
  }

  const computation: PfondAvsattningComputation = {
    rate,
    maxAmount,
    desiredAmount,
    actualAmount,
    cohortAccount,
    cohortYear: input.fiscalYear,
    cappedToMax,
  }

  const warnings: string[] = []
  if (cappedToMax) {
    warnings.push(
      `Begärt belopp (${desiredAmount} kr) översteg ${rateLabel}-taket. Avsättningen begränsades till ${maxAmount} kr.`,
    )
  }

  return {
    kind: 'periodiseringsfond_avsattning',
    label: `Avsättning till periodiseringsfond ${input.fiscalYear}`,
    description: `Debet 8811, kredit ${cohortAccount}. Max ${rateLabel} av skattemässigt resultat.`,
    amount: actualAmount,
    lines: [
      {
        account_number: '8811',
        debit_amount: actualAmount,
        credit_amount: 0,
        line_description: `Avsättning periodiseringsfond ${input.fiscalYear}`,
      },
      {
        account_number: cohortAccount,
        debit_amount: 0,
        credit_amount: actualAmount,
        line_description: `Periodiseringsfond ${input.fiscalYear}`,
      },
    ],
    warnings,
    computation: computation as unknown as Record<string, unknown>,
  }
}

type BalanceLine = {
  account_number: string
  debit_amount: number | string | null
  credit_amount: number | string | null
}

async function periodFondLines(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  onlyOpeningBalance: boolean,
): Promise<BalanceLine[]> {
  return fetchAllRows<BalanceLine>(({ from, to }) => {
    let query = supabase
      .from('journal_entry_lines')
      .select('account_number, debit_amount, credit_amount, journal_entries!inner(company_id, fiscal_period_id, status, source_type)')
      .eq('journal_entries.company_id', companyId)
      .eq('journal_entries.fiscal_period_id', fiscalPeriodId)
      .in('journal_entries.status', ['posted', 'reversed'])
      .gte('account_number', '2110')
      .lte('account_number', '2139')
    if (onlyOpeningBalance) query = query.eq('journal_entries.source_type', 'opening_balance')
    return query.order('id', { ascending: true }).range(from, to)
  })
}

function creditBalances(lines: BalanceLine[]): Map<string, number> {
  const byAccount = new Map<string, number>()
  for (const row of lines) {
    const balance = (Number(row.credit_amount) || 0) - (Number(row.debit_amount) || 0)
    byAccount.set(row.account_number, (byAccount.get(row.account_number) ?? 0) + balance)
  }
  return byAccount
}

/**
 * List periodiseringsfonder (BAS 2110–2139) for a fiscal period with their
 * opening and closing balances.
 *
 * Balances are PERIOD-scoped. Each new year starts with an opening-balance
 * voucher that restates last year's closing balance, so summing every voucher
 * since inception counts a fund once per year it has existed. Closing balance
 * = this period's vouchers (opening voucher included); opening balance = the
 * opening-balance voucher, or — when the period has none — the previous
 * period's closing balance.
 */
export async function listExistingPeriodiseringsfonder(
  supabase: SupabaseClient,
  companyId: string,
  closingDate: string,
  fiscalPeriodId: string,
): Promise<ExistingFond[]> {
  const closingYear = parseInt(closingDate.slice(0, 4), 10)
  if (Number.isNaN(closingYear)) {
    throw new Error(`Invalid closing date: ${closingDate}`)
  }

  const closing = creditBalances(await periodFondLines(supabase, companyId, fiscalPeriodId, false))
  const openingLines = await periodFondLines(supabase, companyId, fiscalPeriodId, true)
  let opening = creditBalances(openingLines)

  if (openingLines.length === 0) {
    const { data: current } = await supabase
      .from('fiscal_periods')
      .select('period_start')
      .eq('id', fiscalPeriodId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (current?.period_start) {
      const { data: previous } = await supabase
        .from('fiscal_periods')
        .select('id')
        .eq('company_id', companyId)
        .lt('period_end', current.period_start)
        .order('period_end', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (previous?.id) {
        opening = creditBalances(await periodFondLines(supabase, companyId, previous.id, false))
      }
    }
  }

  const accounts = new Set([...closing.keys(), ...opening.keys()])
  const fonder: ExistingFond[] = []
  for (const accountNumber of accounts) {
    const balance = roundOre(closing.get(accountNumber) ?? 0)
    const openingBalance = roundOre(opening.get(accountNumber) ?? 0)
    if (Math.abs(balance) < 0.005 && Math.abs(openingBalance) < 0.005) continue
    const cohortYear = cohortYearFromAccount(accountNumber, closingYear)
    fonder.push({
      account_number: accountNumber,
      cohort_year: cohortYear,
      opening_balance: openingBalance,
      balance,
      must_return_this_year: cohortYear !== null && cohortYear + PFOND_MAX_HOLD_YEARS <= closingYear,
    })
  }

  fonder.sort((a, b) => (a.cohort_year ?? 0) - (b.cohort_year ?? 0))
  return fonder
}

/**
 * Cohort year of a BAS periodiseringsfond account. 212X and 213X ("nr 2")
 * carry the year's last digit; the account is reused every ten years, and a
 * fund must be returned within six, so the cohort is the latest year ending
 * in that digit that is not after the closing year (2129 → 2019 when closing
 * 2025, → 2029 when closing 2029). 2110 is the grouping account: no year.
 */
export function cohortYearFromAccount(accountNumber: string, closingYear: number): number | null {
  if (!/^21[23]\d$/.test(accountNumber)) return null
  const digit = parseInt(accountNumber.slice(-1), 10)
  return closingYear - (((closingYear - digit) % 10) + 10) % 10
}

export interface PfondAteforingProposal {
  /** One proposal per individual fond being returned. The wizard renders these
   *  as separate cards; mandatory ones (must_return_this_year) cannot be skipped. */
  proposals: ProposedDisposition[]
  /** Total schablonintäkt computed on the OPENING balance of 2110–2139.
   *  This is NOT booked — it goes into INK2 as a manual adjustment to taxable
   *  result. Caller (bolagsskatt-calculator) reads this to add to taxable result. */
  schablonintaktAmount: number
}

/**
 * Propose periodiseringsfond reversals. Forces reversal of any fond reaching
 * its 6-year limit; offers optional reversal of newer fonder. Also computes
 * the schablonintäkt on the opening balance of all 21xx accounts (per IL 30
 * kap 6a §) — caller adds this to taxable result when computing bolagsskatt.
 *
 * @param schablonintaktRate Statslåneräntan 30 nov året före beskattningsårets
 *   utgång, min 0,5 % (IL 30 kap. 6 a §) — 1,96 % for 2025, 2,55 % for 2026.
 *   Read from year_end_rulesets.
 */
export function proposeAteforing(
  existingFonder: ExistingFond[],
  options: {
    /** Map from account_number to desired return amount. Omit entries the
     *  user does not want to return (mandatory ones are returned regardless). */
    returns?: Record<string, number>
    /** Schablonintäkt rate as a decimal (0.0196 for 1,96 %). Applied to the
     *  opening balance of every fund. */
    schablonintaktRate: number
  },
): PfondAteforingProposal {
  const proposals: ProposedDisposition[] = []
  let schablonintaktAmount = 0

  for (const fond of existingFonder) {
    // IL 30 kap. 6 a §: on the funds at the START of the tax year.
    schablonintaktAmount += Math.max(0, fond.opening_balance) * options.schablonintaktRate
    if (fond.balance <= 0) continue

    const desiredReturn = options.returns?.[fond.account_number] ?? 0
    const isMandatory = fond.must_return_this_year
    const returnAmount = isMandatory
      ? fond.balance // forced full reversal
      : Math.min(Math.max(0, Math.floor(desiredReturn)), fond.balance)

    if (returnAmount === 0) continue

    const warnings: string[] = []
    if (isMandatory) {
      warnings.push(
        `Periodiseringsfond ${fond.cohort_year} har nått 6-årsgränsen och måste återföras.`,
      )
    }
    if (fond.cohort_year === null) {
      warnings.push(
        `Konto ${fond.account_number} saknar avsättningsår. Flytta fonden till kontot för rätt år (212X) så att sexårsgränsen kan bevakas.`,
      )
    }

    proposals.push({
      kind: 'periodiseringsfond_ateforing',
      label: `Återföring periodiseringsfond ${fond.cohort_year ?? fond.account_number}`,
      description: `Debet ${fond.account_number}, kredit 8819.`,
      amount: returnAmount,
      lines: [
        {
          account_number: fond.account_number,
          debit_amount: returnAmount,
          credit_amount: 0,
          line_description: `Återföring periodiseringsfond ${fond.cohort_year}`,
        },
        {
          account_number: '8819',
          debit_amount: 0,
          credit_amount: returnAmount,
          line_description: `Återföring periodiseringsfond ${fond.cohort_year}`,
        },
      ],
      warnings,
      computation: {
        cohort_year: fond.cohort_year,
        opening_balance: fond.balance,
        return_amount: returnAmount,
        was_mandatory: isMandatory,
      },
      required: isMandatory,
    })
  }

  return {
    proposals,
    // Whole kronor, truncated like the INK2S field it feeds.
    schablonintaktAmount: Math.floor(schablonintaktAmount),
  }
}
