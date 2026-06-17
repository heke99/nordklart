export type AgencyClientOverview = {
  agency_id: string
  company_id: string
  company_name: string
  org_number: string | null
  agency_client_status: string
  primary_accountant_id: string | null
  primary_accountant_name: string | null
  bank_status: string
  review_items_count: number
  vat_status: string
  year_end_status: string
  invoice_status: string
  supplier_invoice_status: string
  bankgiro_status: string
  next_deadline_at: string | null
}

export function agencyStatusTone(status: string): 'success' | 'warning' | 'destructive' | 'secondary' {
  if (['connected', 'ok', 'ready', 'submitted', 'completed', 'locked', 'active'].includes(status)) return 'success'
  if (['overdue', 'needs_attention', 'rejected', 'suspended'].includes(status)) return 'destructive'
  if (['unpaid', 'in_progress', 'ready_for_review', 'under_review', 'provider_setup', 'needs_information'].includes(status)) return 'warning'
  return 'secondary'
}

export function formatAgencyStatus(status: string | null | undefined) {
  const value = status || 'unknown'
  const labels: Record<string, string> = {
    unknown: 'Okänd',
    not_connected: 'Ej kopplad',
    connected: 'Kopplad',
    needs_attention: 'Behöver åtgärd',
    not_started: 'Ej startad',
    in_progress: 'Pågår',
    ready: 'Klar',
    ready_for_review: 'Klar för granskning',
    submitted: 'Inskickad',
    completed: 'Klar',
    locked: 'Låst',
    ok: 'OK',
    unpaid: 'Obetalt',
    overdue: 'Försenat',
    not_requested: 'Ej begärt',
    draft: 'Utkast',
    needs_information: 'Behöver komplettering',
    under_review: 'Granskas',
    approved: 'Godkänd',
    provider_setup: 'Provider setup',
    active: 'Aktiv',
    rejected: 'Avslagen',
    suspended: 'Pausad',
  }
  return labels[value] ?? value.replaceAll('_', ' ')
}
