export const SKATTEVERKET_FLOW_STEPS = [
  { key: 'prepared', label: 'Förberedd i Nordklart' },
  { key: 'sent_to_skatteverket', label: 'Skickad till Skatteverket' },
  { key: 'waiting_for_signature', label: 'Väntar signering' },
  { key: 'signed_submitted', label: 'Signerad/inlämnad' },
  { key: 'receipt_received', label: 'Kvittens mottagen' },
] as const

export function taxSubmissionStatusLabel(status?: string | null) {
  const labels: Record<string, string> = {
    draft: 'Utkast',
    prepared: 'Förberedd',
    sent_to_skatteverket: 'Skickad',
    waiting_for_signature: 'Väntar signering',
    signed_submitted: 'Signerad/inlämnad',
    receipt_received: 'Kvittens mottagen',
    failed: 'Fel',
    cancelled: 'Avbruten',
  }
  return labels[status ?? ''] ?? status ?? 'Okänd'
}

export function taxSubmissionTypeLabel(type?: string | null) {
  const labels: Record<string, string> = {
    vat_return: 'Momsdeklaration',
    agi: 'AGI',
    skattekonto_reconciliation: 'Skattekontoavstämning',
    income_tax: 'Inkomstdeklaration',
    other: 'Annat',
  }
  return labels[type ?? ''] ?? type ?? 'Skatteärende'
}
