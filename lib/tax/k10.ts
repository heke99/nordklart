import { roundOre } from '@/lib/money'

/**
 * Gränsbelopp and tax on dividends for kvalificerade andelar i fåmansföretag
 * (3:12-reglerna, blankett K10) under the rules that apply from inkomstår
 * 2026 (inkomstskattelagen 57 kap. 10–20 a §§ in the wording of SFS
 * 2025:1361). Verified against the statute and Skatteverket, 2026-09-25:
 *
 *  - årets gränsbelopp (57:11) = grundbelopp + lönebaserat utrymme + ränta på
 *    omkostnadsbeloppet, computed at the start of the year for whoever owns
 *    the shares then. The förenklingsregel and the 4 % ownership / wage
 *    requirements are gone.
 *  - grundbelopp = 4 inkomstbasbelopp for the year before the income year
 *    (2026: 4 × 80 600 = 322 400), shared equally per share. An owner of
 *    shares in several companies gets at most one grundbelopp in total,
 *    spread in proportion to the holdings (57:11 a).
 *  - lönebaserat utrymme (57:16) = 50 % of the owner's share of the
 *    löneunderlag above 8 inkomstbasbelopp (2026: 644 800), capped at 50 ×
 *    the cash pay the owner or a närstående received from the company and
 *    its subsidiaries in the year before. The löneunderlag is the cash pay to
 *    employees of the company and its subsidiaries in the year before
 *    (57:17), excluding pay covered by state wage subsidies (57:18).
 *  - ränta på omkostnadsbeloppet: (statslåneräntan + 9 procentenheter) on the
 *    part of the omkostnadsbelopp above 100 000 kr (2026: 2,55 % + 9 % =
 *    11,55 %).
 *  - sparat utdelningsutrymme is carried forward without uplift (57:13).
 *  - utdelning up to the gränsbelopp: 2/3 taxed as capital at 30 % (20 %
 *    effective); above it: inkomstslaget tjänst (57:20), but no more in tjänst
 *    than 90 inkomstbasbelopp for the income year per company and
 *    närståendekrets (57:20 a; 2026: 7 506 000) — the rest is capital at 30 %.
 *
 * Not modelled (enter adjusted inputs): spouses' joint lönebaserat utrymme
 * (57:16 third sentence), shares owned for only part of the previous year
 * (57:16 a), omkostnadsbelopp reductions for non-permanent tillskott (57:12),
 * andelsbyte and partial fission.
 */

export interface K10YearParameters {
  incomeYear: number
  /** Inkomstbasbelopp for the year before the income year (grundbelopp, 8 IBB). */
  ibbPriorYear: number
  /** Inkomstbasbelopp for the income year (90 IBB tak, 57:20 a). */
  ibbIncomeYear: number
  /** Statslåneräntan at the end of November the year before the income year. */
  statslaneranta: number
}

const PARAMETERS: Record<number, K10YearParameters> = {
  // Skatteverket "Belopp och procentsatser (blankett K10)", inkomstår 2026:
  // grundbelopp 322 400, ränta 11,55 %, takbelopp utdelning 7 506 000.
  2026: { incomeYear: 2026, ibbPriorYear: 80_600, ibbIncomeYear: 83_400, statslaneranta: 0.0255 },
}

export const GRUNDBELOPP_IBB = 4
export const WAGE_DEDUCTION_IBB = 8
export const WAGE_SHARE = 0.5
export const WAGE_CAP_MULTIPLE = 50
export const COST_BASIS_THRESHOLD = 100_000
export const COST_BASIS_INTEREST_ADD_ON = 0.09
export const TJANST_CAP_IBB = 90
export const CAPITAL_TAX_RATE = 0.3
export const CAPITAL_SHARE_WITHIN_LIMIT = 2 / 3

export function getK10Parameters(incomeYear: number): K10YearParameters {
  const params = PARAMETERS[incomeYear]
  if (!params) {
    throw new Error(
      incomeYear < 2026
        ? `K10 för inkomstår ${incomeYear} följer de äldre reglerna (förenklingsregel/huvudregel) och beräknas inte här.`
        : `Belopp för K10 inkomstår ${incomeYear} är inte inlagda ännu.`,
    )
  }
  return params
}

export interface K10Input {
  incomeYear: number
  /** Total number of shares in the company. */
  totalShares: number
  /** Shares the owner held at the start of the income year. */
  ownerShares: number
  /**
   * The owner's ownership fractions (0–1) in OTHER companies where a
   * grundbelopp is also claimed. Used for the one-grundbelopp cap (57:11 a).
   */
  otherCompanyOwnershipFractions?: number[]
  /** Löneunderlag: cash pay in the company and its subsidiaries, previous year. */
  wageBase: number
  /** Cash pay to the owner or a närstående from the company group, previous year. */
  ownerOrRelatedCashPay: number
  /** Omkostnadsbelopp for the owner's shares at the start of the year. */
  costBasis: number
  /** Sparat utdelningsutrymme brought forward. */
  savedSpace: number
  /** Dividend the owner receives in the income year. */
  dividend: number
  /**
   * Amounts the owner and närstående in the same krets already took up in
   * tjänst under 57 kap. from this company this year (for the 90 IBB tak).
   */
  relatedTjanstAmountThisYear?: number
}

export interface K10Result {
  parameters: K10YearParameters
  ownershipFraction: number
  grundbelopp: number
  lonebaseratUtrymme: number
  lonebaseratUtrymmeUncapped: number
  rantaPaOmkostnadsbelopp: number
  aretsGransbelopp: number
  gransbelopp: number
  /** Dividend taxed in inkomstslaget kapital under the gränsbelopp. */
  dividendWithinLimit: number
  /** 2/3 of dividendWithinLimit — the taxable capital income. */
  taxableCapitalWithinLimit: number
  /** Dividend taxed in inkomstslaget tjänst. */
  dividendAsTjanst: number
  /** Dividend above the 90 IBB tak, taxed in kapital at 30 % in full. */
  dividendAboveTjanstCap: number
  /** Capital tax on the dividend (30 % × 2/3 within + 30 % above the tak). */
  capitalTax: number
  /** Sparat utdelningsutrymme carried to next year. */
  savedSpaceCarriedForward: number
}

const clamp01 = (x: number) => Math.min(Math.max(x, 0), 1)

export function computeK10(input: K10Input): K10Result {
  const p = getK10Parameters(input.incomeYear)
  if (!(input.totalShares > 0) || input.ownerShares < 0 || input.ownerShares > input.totalShares) {
    throw new Error('Antal aktier är ogiltigt.')
  }
  const fraction = clamp01(input.ownerShares / input.totalShares)

  // Grundbelopp, shared equally per share, at most one in total.
  const fullGrundbelopp = GRUNDBELOPP_IBB * p.ibbPriorYear
  const otherFractions = (input.otherCompanyOwnershipFractions ?? []).map(clamp01)
  const totalFractions = fraction + otherFractions.reduce((a, b) => a + b, 0)
  const grundbelopp = roundOre(
    totalFractions > 1 && totalFractions > 0
      ? fullGrundbelopp * (fraction / totalFractions)
      : fullGrundbelopp * fraction,
  )

  // Lönebaserat utrymme.
  const wageDeduction = WAGE_DEDUCTION_IBB * p.ibbPriorYear
  const uncapped = roundOre(Math.max(input.wageBase * fraction - wageDeduction, 0) * WAGE_SHARE)
  const cap = roundOre(Math.max(input.ownerOrRelatedCashPay, 0) * WAGE_CAP_MULTIPLE)
  const lonebaserat = Math.min(uncapped, cap)

  // Ränta på omkostnadsbeloppet över 100 000 kr.
  const rate = p.statslaneranta + COST_BASIS_INTEREST_ADD_ON
  const ranta = roundOre(Math.max(input.costBasis - COST_BASIS_THRESHOLD, 0) * rate)

  const aretsGransbelopp = roundOre(grundbelopp + lonebaserat + ranta)
  const gransbelopp = roundOre(aretsGransbelopp + Math.max(input.savedSpace, 0))

  const dividend = Math.max(roundOre(input.dividend), 0)
  const within = Math.min(dividend, gransbelopp)
  const above = roundOre(dividend - within)
  const tjanstCap = TJANST_CAP_IBB * p.ibbIncomeYear
  const tjanstRoom = Math.max(tjanstCap - Math.max(input.relatedTjanstAmountThisYear ?? 0, 0), 0)
  const asTjanst = Math.min(above, tjanstRoom)
  const aboveCap = roundOre(above - asTjanst)

  const taxableCapital = roundOre(within * CAPITAL_SHARE_WITHIN_LIMIT)
  const capitalTax = roundOre(taxableCapital * CAPITAL_TAX_RATE + aboveCap * CAPITAL_TAX_RATE)

  return {
    parameters: p,
    ownershipFraction: fraction,
    grundbelopp,
    lonebaseratUtrymme: lonebaserat,
    lonebaseratUtrymmeUncapped: uncapped,
    rantaPaOmkostnadsbelopp: ranta,
    aretsGransbelopp,
    gransbelopp,
    dividendWithinLimit: roundOre(within),
    taxableCapitalWithinLimit: taxableCapital,
    dividendAsTjanst: roundOre(asTjanst),
    dividendAboveTjanstCap: aboveCap,
    capitalTax,
    savedSpaceCarriedForward: roundOre(gransbelopp - within),
  }
}
