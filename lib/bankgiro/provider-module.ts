export const BANKGIRO_APPLICATION_STEPS = [
  'Utkast',
  'Inskickad',
  'Behöver komplettering',
  'Under granskning',
  'Godkänd',
  'Aktivering',
  'Aktiv',
] as const

export function bankgiroStatusLabel(status?: string | null) {
  const labels: Record<string, string> = {
    not_requested: 'Ej påbörjad',
    draft: 'Utkast',
    submitted: 'Inskickad',
    needs_information: 'Behöver komplettering',
    under_review: 'Under granskning',
    approved: 'Godkänd',
    provider_setup: 'Aktivering',
    active: 'Aktiv',
    rejected: 'Avslagen',
    suspended: 'Pausad',
  }
  return labels[status ?? ''] ?? status ?? 'Ej påbörjad'
}

export function providerSetupLabel(status?: string | null) {
  const labels: Record<string, string> = {
    not_started: 'Ej startad',
    waiting_provider: 'Väntar på betalpartner',
    active: 'Aktiv',
    failed: 'Fel',
    paused: 'Pausad',
  }
  return labels[status ?? ''] ?? status ?? 'Ej startad'
}
