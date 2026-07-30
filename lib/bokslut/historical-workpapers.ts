export const HISTORICAL_WORKPAPER_STATUSES = [
  'automatically_reconciled',
  'imported_from_sie',
  'sie_balance_accepted',
  'external_evidence_verified',
  'manually_adjusted',
  'actual_difference',
  'completion_required',
  'blocking_accounting_error',
] as const

export type HistoricalWorkpaperStatus =
  (typeof HISTORICAL_WORKPAPER_STATUSES)[number]

export type LegacyYearEndControlStatus =
  | 'reconciled'
  | 'manual_verification_required'
  | 'accounting_error'

export type YearEndControlStatusCode =
  | HistoricalWorkpaperStatus
  | LegacyYearEndControlStatus

export const HISTORICAL_WORKPAPER_CATEGORIES = [
  'customer_receivables',
  'supplier_payables',
  'bank',
  'cash',
  'vat',
  'tax',
  'equity',
  'accruals',
  'fixed_assets',
  'loans',
  'other_receivables',
  'other_liabilities',
] as const

export type HistoricalWorkpaperCategory =
  (typeof HISTORICAL_WORKPAPER_CATEGORIES)[number]

export const HISTORICAL_WORKPAPER_LABELS: Record<HistoricalWorkpaperCategory, string> = {
  customer_receivables: 'Kundfordringar',
  supplier_payables: 'Leverantörsskulder',
  bank: 'Bank',
  cash: 'Kassa',
  vat: 'Moms',
  tax: 'Skatt',
  equity: 'Eget kapital',
  accruals: 'Periodiseringar',
  fixed_assets: 'Anläggningstillgångar',
  loans: 'Lån',
  other_receivables: 'Övriga fordringar',
  other_liabilities: 'Övriga skulder',
}

export function isConfirmationStatus(status: YearEndControlStatusCode): boolean {
  return status === 'imported_from_sie'
    || status === 'completion_required'
    || status === 'manual_verification_required'
}

export function isAccountingErrorStatus(status: YearEndControlStatusCode): boolean {
  return status === 'actual_difference'
    || status === 'blocking_accounting_error'
    || status === 'accounting_error'
}

export function isCompletedStatus(status: YearEndControlStatusCode): boolean {
  return !isConfirmationStatus(status) && !isAccountingErrorStatus(status)
}

export function historicalWorkpaperStatusLabel(status: YearEndControlStatusCode): string {
  const labels: Record<YearEndControlStatusCode, string> = {
    automatically_reconciled: 'Automatiskt avstämt',
    imported_from_sie: 'Importerat från SIE',
    sie_balance_accepted: 'SIE-saldo accepterat',
    external_evidence_verified: 'Externt underlag verifierat',
    manually_adjusted: 'Manuellt justerat',
    actual_difference: 'Verklig differens',
    completion_required: 'Behöver kompletteras',
    blocking_accounting_error: 'Blockerande bokföringsfel',
    reconciled: 'Avstämt',
    manual_verification_required: 'Behöver bekräftas',
    accounting_error: 'Bokföringsfel',
  }
  return labels[status]
}

export function historicalWorkpaperSourceLabel(sourceType: string): string {
  const labels: Record<string, string> = {
    system_calculation: 'Automatisk beräkning',
    sie_ledger: 'SIE-import',
    internal_support_register: 'Internt stödregister',
    external_evidence: 'Externt underlag',
    manual_confirmation: 'Manuell bekräftelse',
    manual_adjustment: 'Manuell justering',
    structured_profit_disposition: 'Beräknat förslag',
    year_end_snapshot: 'Företagssnapshot',
  }
  return labels[sourceType] ?? sourceType
}
