import { roundOre } from '@/lib/money'

/**
 * Statutory late-payment interest (dröjsmålsränta) per Räntelagen §6.
 *
 * The default rate is Riksbankens referensränta + 8 percentage points,
 * applied as a simple annual interest on the overdue amount over the
 * number of days the invoice has been overdue.
 *
 * Formula, per calendar half-year segment (räntelagen 6 §: "den vid varje
 * tidpunkt gällande referensräntan"; the rate is fixed for each half-year):
 *   interest = Σ overdueAmount × (referensränta_segment + 8 pe) × days_segment / 365
 *
 * We use 365 days (not 360) — this matches Swedish practice and is what
 * Skatteverket / Kronofogden use in their late-payment calculators.
 *
 * Companies may override the statutory rate via
 * `company_settings.reminder_interest_rate_override`. When an override is
 * supplied we apply it directly (i.e. NOT referensränta + override) since
 * that's the simpler mental model for users entering "11.5% per year".
 *
 * Referensränta is set by Riksbanken twice a year on January 1 and July 1.
 * We hardcode the lookup table here to avoid a network call on every
 * reminder; the table is small (one row per six months) and the values
 * are public, durable records. Update this table when Riksbanken publishes
 * a new rate.
 */

/**
 * Riksbankens referensränta history. Each entry is the rate effective from
 * the given date onward (until the next entry). Most recent first is more
 * efficient to search but for clarity we keep them in ascending order and
 * walk from newest to oldest at lookup time.
 *
 * Source: https://www.riksbank.se/sv/statistik/rantor-och-valutakurser/referensranta/
 * (checked 2026-09-24; 2024-07 … 2026-07 per Riksbanken's announcements
 * "Referensräntan fastställd till …").
 *
 * The "annual default rate" applied to invoices is referensränta + 0.08
 * (eight percentage points, Räntelagen §6).
 */
const REFERENSRANTA_HISTORY: ReadonlyArray<{ from: string; rate: number }> = [
  { from: '2022-01-01', rate: 0.0 },
  { from: '2022-07-01', rate: 0.005 },
  { from: '2023-01-01', rate: 0.025 },
  { from: '2023-07-01', rate: 0.035 },
  { from: '2024-01-01', rate: 0.04 },
  { from: '2024-07-01', rate: 0.04 },
  { from: '2025-01-01', rate: 0.03 },
  { from: '2025-07-01', rate: 0.02 },
  { from: '2026-01-01', rate: 0.02 },
  { from: '2026-07-01', rate: 0.02 },
] as const

const LATE_PAYMENT_PREMIUM = 0.08 // 8 procentenheter per Räntelagen §6

/**
 * Look up the Riksbanken referensränta that was effective on a given date.
 * Returns the rate as a decimal fraction (e.g. 0.025 = 2.5%).
 *
 * If the requested date is before the earliest entry in the table we fall
 * back to the earliest entry (this is a defensive measure — should never
 * happen in practice since Nordklart was launched after 2022).
 */
export function getReferensrantaAt(date: string): number {
  // Walk newest-first so the first match wins.
  for (let i = REFERENSRANTA_HISTORY.length - 1; i >= 0; i--) {
    const entry = REFERENSRANTA_HISTORY[i]
    if (date >= entry.from) {
      return entry.rate
    }
  }
  return REFERENSRANTA_HISTORY[0].rate
}

/**
 * Compute the statutory annual late-payment interest rate for a given
 * "from date" (typically the invoice due date). If an override is
 * supplied, it is returned as-is.
 */
export function getAnnualInterestRate(fromDate: string, overrideRate?: number | null): number {
  if (overrideRate !== undefined && overrideRate !== null) {
    return overrideRate
  }
  return getReferensrantaAt(fromDate) + LATE_PAYMENT_PREMIUM
}

export interface LatePaymentInterestInput {
  /** Outstanding overdue amount (the invoice total or remaining balance). */
  overdueAmount: number
  /** Invoice due date (YYYY-MM-DD). Interest starts the day AFTER due date. */
  dueDate: string
  /** Reference date for the calculation (YYYY-MM-DD). Defaults to today. */
  asOfDate: string
  /**
   * Optional annual rate override (e.g. 0.115 for 11.5%). When supplied
   * we use this verbatim instead of looking up Räntelagen §6.
   */
  overrideRate?: number | null
}

export interface LatePaymentInterestResult {
  /**
   * Annual rate at the start of the overdue period (decimal fraction). When
   * the period spans half-years, `segments` holds each rate actually applied.
   */
  rate: number
  /** One entry per calendar half-year the overdue period touches. */
  segments?: Array<{ from: string; to: string; days: number; rate: number }>
  /** Computed interest amount in SEK, rounded to 2 decimals. */
  amount: number
  /** Start date used for the interest calc (= dueDate). */
  fromDate: string
  /** Number of overdue days (positive integer, 0 if not overdue). */
  days: number
}

/**
 * Compute statutory late-payment interest (dröjsmålsränta).
 *
 * Returns the rate that was applied, the rounded amount, the from-date
 * used (= dueDate), and the number of overdue days. If the invoice is
 * not yet overdue the amount and days are both 0.
 *
 * Throws if `overdueAmount` is negative (callers should clamp to 0 if
 * they want to silently no-op, but this is almost always a bug).
 */
export function calculateLatePaymentInterest(
  input: LatePaymentInterestInput,
): LatePaymentInterestResult {
  const { overdueAmount, dueDate, asOfDate, overrideRate } = input

  if (overdueAmount < 0) {
    throw new Error('overdueAmount must be non-negative')
  }

  const days = daysBetween(dueDate, asOfDate)
  const rate = getAnnualInterestRate(dueDate, overrideRate)

  if (days <= 0 || overdueAmount === 0) {
    return { rate, amount: 0, fromDate: dueDate, days: 0 }
  }

  // Split the overdue period at every 1 January / 1 July: the referensränta
  // changes there, and räntelagen applies the rate in force on each day.
  // An override is a flat contractual rate, so it is not segmented.
  const segments: Array<{ from: string; to: string; days: number; rate: number }> = []
  let cursor = dueDate
  while (cursor < asOfDate) {
    const boundary = nextHalfYearBoundary(cursor)
    const to = boundary < asOfDate ? boundary : asOfDate
    const segmentDays = daysBetween(cursor, to)
    if (segmentDays > 0) {
      // Interest for a day accrues at the rate in force that day; the first
      // accruing day of the segment is cursor + 1.
      const segmentRate = getAnnualInterestRate(addDays(cursor, 1), overrideRate)
      segments.push({ from: cursor, to, days: segmentDays, rate: segmentRate })
    }
    cursor = to
  }

  const raw = segments.reduce((sum, seg) => sum + overdueAmount * seg.rate * (seg.days / 365), 0)
  const amount = roundOre(raw)

  return { rate, amount, fromDate: dueDate, days, segments }
}

/**
 * Last day of the calendar half-year that `date` falls in — or of the next
 * half-year when `date` already is that last day, so the caller always moves.
 */
function nextHalfYearBoundary(date: string): string {
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(5, 7))
  const end = month < 7 ? `${year}-06-30` : `${year}-12-31`
  if (end > date) return end
  return month < 7 ? `${year}-12-31` : `${year + 1}-06-30`
}

function addDays(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * Compute whole-day difference between two YYYY-MM-DD dates. Positive if
 * `to` is after `from`. Returns 0 if `to <= from`.
 *
 * We use UTC midnight to avoid DST artifacts (Sweden observes DST). The
 * inputs are date-only strings so timezone doesn't affect the result as
 * long as we anchor both at UTC.
 */
function daysBetween(from: string, to: string): number {
  const fromMs = Date.parse(`${from}T00:00:00Z`)
  const toMs = Date.parse(`${to}T00:00:00Z`)
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
    return 0
  }
  const diff = Math.floor((toMs - fromMs) / 86_400_000)
  return diff > 0 ? diff : 0
}
