/**
 * Europe/Stockholm calendar-date helpers (revision item R21).
 *
 * Swedish accounting dates are CALENDAR dates in Sweden's time zone — a raw
 * UTC `toISOString().split('T')[0]` reads a day behind between midnight and
 * 01:00/02:00 Swedish time, shifting period boundaries, "idag" comparisons
 * and YTD windows. Use these helpers wherever a "today" or month/year
 * boundary feeds accounting logic.
 */

const STOCKHOLM_DATE = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** Today's calendar date in Sweden, formatted YYYY-MM-DD. */
export function stockholmToday(now: Date = new Date()): string {
  // sv-SE locale formats as YYYY-MM-DD already.
  return STOCKHOLM_DATE.format(now)
}

/** First day of the current month in Sweden, formatted YYYY-MM-DD. */
export function stockholmStartOfMonth(now: Date = new Date()): string {
  return `${stockholmToday(now).slice(0, 7)}-01`
}

/** First day of the current calendar year in Sweden, formatted YYYY-MM-DD. */
export function stockholmStartOfYear(now: Date = new Date()): string {
  return `${stockholmToday(now).slice(0, 4)}-01-01`
}
