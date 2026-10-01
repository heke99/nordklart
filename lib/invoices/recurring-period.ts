/**
 * Date and period rules for recurring invoices. Pure functions, no I/O.
 *
 * All dates are ISO yyyy-mm-dd strings interpreted as calendar dates; no
 * time zone is involved once a run date has been chosen.
 */

export type BillingTiming = 'current_period' | 'next_period' | 'previous_period'

export const ALLOWED_INTERVAL_MONTHS = [1, 2, 3, 6, 12] as const

export interface BillingPeriod {
  start: string
  end: string
}

const SV_MONTHS = [
  'januari', 'februari', 'mars', 'april', 'maj', 'juni',
  'juli', 'augusti', 'september', 'oktober', 'november', 'december',
]

function pad(n: number, width = 2): string {
  return n.toString().padStart(width, '0')
}

function iso(year: number, month0: number, day: number): string {
  return `${pad(year, 4)}-${pad(month0 + 1)}-${pad(day)}`
}

function parse(date: string): { y: number; m: number; d: number } {
  const [y, m, d] = date.split('-').map(Number)
  return { y, m: m - 1, d }
}

function lastDayOfMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate()
}

/** Year and month index after adding `months` (may be negative). */
function shiftMonth(year: number, month0: number, months: number): { y: number; m: number } {
  const total = year * 12 + month0 + months
  return { y: Math.floor(total / 12), m: ((total % 12) + 12) % 12 }
}

/**
 * The run date `intervalMonths` after `runDate`, on `dayOfMonth` (clamped to
 * the month's last day; the schedule keeps its day so a 31st comes back in
 * months that have one).
 *
 * Advancing from the scheduled run date, not from "today", means a run that
 * was missed (cron outage, paused for a while) is caught up period by period
 * instead of being skipped.
 */
export function nextRunDate(runDate: string, dayOfMonth: number, intervalMonths = 1): string {
  if (dayOfMonth < 1 || dayOfMonth > 31) throw new Error(`invalid day_of_month: ${dayOfMonth}`)
  if (!ALLOWED_INTERVAL_MONTHS.includes(intervalMonths as (typeof ALLOWED_INTERVAL_MONTHS)[number])) {
    throw new Error(`invalid interval_months: ${intervalMonths}`)
  }
  const { y, m } = parse(runDate)
  const next = shiftMonth(y, m, intervalMonths)
  return iso(next.y, next.m, Math.min(dayOfMonth, lastDayOfMonth(next.y, next.m)))
}

/**
 * Calendar months an invoice run covers:
 *   current_period  — the month of the run date and the following interval-1 months
 *   next_period     — the `intervalMonths` months after the run month (paid in advance)
 *   previous_period — the `intervalMonths` months before the run month (in arrears)
 */
export function billingPeriod(runDate: string, intervalMonths: number, timing: BillingTiming): BillingPeriod {
  const { y, m } = parse(runDate)
  const offset = timing === 'next_period' ? intervalMonths : timing === 'previous_period' ? -intervalMonths : 0
  const first = shiftMonth(y, m, offset)
  const last = shiftMonth(first.y, first.m, intervalMonths - 1)
  return { start: iso(first.y, first.m, 1), end: iso(last.y, last.m, lastDayOfMonth(last.y, last.m)) }
}

/** "oktober 2026", "oktober–december 2026", "december 2026–februari 2027". */
export function formatPeriodSv(period: BillingPeriod): string {
  const s = parse(period.start)
  const e = parse(period.end)
  if (s.y === e.y && s.m === e.m) return `${SV_MONTHS[s.m]} ${s.y}`
  if (s.y === e.y) return `${SV_MONTHS[s.m]}–${SV_MONTHS[e.m]} ${s.y}`
  return `${SV_MONTHS[s.m]} ${s.y}–${SV_MONTHS[e.m]} ${e.y}`
}

/**
 * Replace period placeholders in a line description:
 *   {period} → "oktober 2026" / "oktober–december 2026"
 *   {månad}  → "oktober" (first month of the period)
 *   {år}     → "2026" (year of the first month)
 * Unknown placeholders are left as written.
 */
export function applyPeriodPlaceholders(description: string, period: BillingPeriod): string {
  const s = parse(period.start)
  return description
    .replaceAll('{period}', formatPeriodSv(period))
    .replaceAll('{månad}', SV_MONTHS[s.m])
    .replaceAll('{manad}', SV_MONTHS[s.m])
    .replaceAll('{år}', String(s.y))
    .replaceAll('{ar}', String(s.y))
}

/** Does a line limited to valid_from..valid_until apply to this period? */
export function lineAppliesToPeriod(
  line: { valid_from?: string | null; valid_until?: string | null },
  period: BillingPeriod,
): boolean {
  if (line.valid_from && line.valid_from > period.end) return false
  if (line.valid_until && line.valid_until < period.start) return false
  return true
}

/**
 * Whether the schedule is finished after a run that produced invoice number
 * `generatedAfterRun`, given the next run date it would move to.
 */
export function scheduleEndsAfterRun(input: {
  generatedAfterRun: number
  maxOccurrences: number | null
  endDate: string | null
  nextRunDate: string
}): boolean {
  if (input.maxOccurrences != null && input.generatedAfterRun >= input.maxOccurrences) return true
  if (input.endDate && input.nextRunDate > input.endDate) return true
  return false
}
