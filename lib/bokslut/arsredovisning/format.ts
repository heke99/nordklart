/**
 * Annual-report text and number normalization.
 *
 * PDF, extracted PDF text and iXBRL must expose the same visible sign. We use
 * the ASCII hyphen-minus (`-`) because Helvetica and every supported browser
 * contain it; no private/control glyphs or font-specific Unicode minus are
 * allowed in the document pipeline.
 */

const FORBIDDEN_CONTROLS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g
const FORBIDDEN_CONTROLS_TEST = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/
const UNICODE_MINUS_VARIANTS = /[\u2212\u2010\u2011\u2012\u2013\u2014\uFE58\uFE63\uFF0D]/g
const NON_CANONICAL_NUMERIC_MINUS_TEST = /[\u2212\uFE63\uFF0D]/

export function stripAnnualReportControlCharacters(value: string): string {
  return value.replace(FORBIDDEN_CONTROLS, '').replace(UNICODE_MINUS_VARIANTS, '-')
}

export function normalizeAnnualReportText(value: string | null | undefined): string {
  return stripAnnualReportControlCharacters(value ?? '').normalize('NFC')
}

export function formatAnnualReportAmount(
  amount: number,
  options: { decimals?: number; missing?: string } = {},
): string {
  if (!Number.isFinite(amount)) return options.missing ?? '—'
  const decimals = options.decimals ?? 0
  const factor = 10 ** decimals
  // Annual reports use conventional half-away-from-zero rounding. Native
  // Math.round() rounds negative halves towards +Infinity, so -1455.5 would
  // incorrectly become -1455 instead of -1456.
  const scaledAbsolute = Math.abs(amount) * factor
  const roundedAbsolute = Math.round(
    scaledAbsolute + Number.EPSILON * Math.max(1, scaledAbsolute),
  ) / factor
  const rounded = amount < 0 ? -roundedAbsolute : roundedAbsolute
  const absolute = Math.abs(rounded)
  const formatted = new Intl.NumberFormat('sv-SE', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: true,
  }).format(absolute)
  return rounded < 0 ? `-${formatted}` : formatted
}

export function annualReportFileSlug(value: string): string {
  const normalized = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('sv-SE')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || 'bolag'
}

export function containsForbiddenAnnualReportCharacters(value: string): boolean {
  return FORBIDDEN_CONTROLS_TEST.test(value) || NON_CANONICAL_NUMERIC_MINUS_TEST.test(value)
}
