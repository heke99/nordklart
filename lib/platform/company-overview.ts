import 'server-only'

import { createServiceClient } from '@/lib/supabase/server'

export type PlatformCompanyFilters = {
  q?: string | null
  kind?: string | null
  entityType?: string | null
  accessStatus?: string | null
  planCode?: string | null
  bankgiroStatus?: string | null
  accountingStatus?: string | null
}

export type PlatformCompanyOverview = {
  id: string
  name: string
  org_number: string | null
  entity_type: 'enskild_firma' | 'aktiebolag' | string | null
  workspace_kind: 'company' | 'agency' | 'agency_client' | string
  agency_id: string | null
  agency_name: string | null
  client_agency_id: string | null
  client_agency_name: string | null
  member_count: number
  active_member_count: number
  access_source: string | null
  access_status: string | null
  plan_name: string | null
  plan_code: string | null
  subscription_status: string | null
  current_period_end: string | null
  active_grant_count: number
  active_grant_types: string[] | null
  onboarding_status: string | null
  bankgiro_status: string | null
  active_year_end_access_count: number
  open_review_count: number
  journal_entry_count: number
  last_journal_entry_at: string | null
  unlinked_document_count: number
  pending_inbox_count: number
  unbooked_transaction_count: number
  created_at: string
  updated_at: string
  archived_at: string | null
}

export type PlatformCompanyKpis = {
  totalCompanies: number
  activeCompanies: number
  limitedCompanies: number
  soleTraders: number
  agencies: number
  agencyClients: number
  activeAccess: number
  missingAccess: number
  bankgiroReview: number
  accountingIssues: number
}

export type PlatformCompanyListResult = {
  rows: PlatformCompanyOverview[]
  count: number
  kpis: PlatformCompanyKpis
  planOptions: Array<{ code: string; name: string }>
}

const ACTIVE_BANKGIRO_REVIEW_STATUSES = ['submitted', 'needs_information', 'under_review', 'provider_setup']

export function asString(value: unknown): string | null {
  if (Array.isArray(value)) return value[0] ? String(value[0]).trim() : null
  if (value == null) return null
  const text = String(value).trim()
  return text.length > 0 ? text : null
}

export function companyKindLabel(kind: string | null | undefined) {
  switch (kind) {
    case 'agency': return 'Redovisningsbyrå'
    case 'agency_client': return 'Byråkund'
    default: return 'Företag'
  }
}

export function entityTypeLabel(value: string | null | undefined) {
  switch (value) {
    case 'aktiebolag': return 'Aktiebolag'
    case 'enskild_firma': return 'Enskild firma'
    default: return 'Okänd bolagsform'
  }
}

export function accessStatusLabel(value: string | null | undefined) {
  switch (value) {
    case 'active': return 'Aktiv åtkomst'
    case 'trialing': return 'Provperiod'
    case 'past_due': return 'Betalning krävs'
    case 'paused': return 'Pausad'
    case 'cancelled': return 'Avslutad'
    case 'expired': return 'Utgången'
    case 'missing': return 'Saknar plan'
    default: return value || 'Saknar plan'
  }
}

export function bankgiroStatusLabel(value: string | null | undefined) {
  switch (value) {
    case 'not_requested': return 'Ej ansökt'
    case 'draft': return 'Utkast'
    case 'submitted': return 'Inskickad'
    case 'needs_information': return 'Behöver komplettering'
    case 'under_review': return 'Under granskning'
    case 'approved': return 'Godkänd'
    case 'provider_setup': return 'Aktivering pågår'
    case 'active': return 'Aktiv'
    case 'rejected': return 'Nekad'
    case 'suspended': return 'Pausad'
    default: return value || 'Ej ansökt'
  }
}

export async function listPlatformCompanies(filters: PlatformCompanyFilters): Promise<PlatformCompanyListResult> {
  const service = createServiceClient()

  let query = service
    .from('platform_company_overview_v')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .limit(100)

  const q = filters.q?.trim()
  if (q) {
    const safe = q.replaceAll(',', ' ').replaceAll('%', '').replaceAll('*', '')
    query = query.or(`name.ilike.%${safe}%,org_number.ilike.%${safe}%`)
  }
  if (filters.kind && filters.kind !== 'all') query = query.eq('workspace_kind', filters.kind)
  if (filters.entityType && filters.entityType !== 'all') query = query.eq('entity_type', filters.entityType)
  if (filters.accessStatus && filters.accessStatus !== 'all') query = query.eq('access_status', filters.accessStatus)
  if (filters.planCode && filters.planCode !== 'all') query = query.eq('plan_code', filters.planCode)
  if (filters.bankgiroStatus && filters.bankgiroStatus !== 'all') query = query.eq('bankgiro_status', filters.bankgiroStatus)

  const [{ data, error, count }, { data: allRows }, { data: plans }] = await Promise.all([
    query,
    service.from('platform_company_overview_v').select('id,entity_type,workspace_kind,access_status,bankgiro_status,unlinked_document_count,pending_inbox_count,unbooked_transaction_count').limit(10000),
    service.from('platform_price_plans').select('code,name').in('status', ['active', 'paused']).order('name', { ascending: true }),
  ])

  if (error) throw new Error(error.message)

  const all = (allRows ?? []) as Array<Partial<PlatformCompanyOverview>>
  const rows = ((data ?? []) as PlatformCompanyOverview[]).filter((row) => {
    if (filters.accountingStatus === 'issues') {
      return (row.unlinked_document_count || 0) + (row.pending_inbox_count || 0) + (row.unbooked_transaction_count || 0) > 0
    }
    return true
  })

  const kpis: PlatformCompanyKpis = {
    totalCompanies: all.length,
    activeCompanies: all.filter((row) => !row.archived_at).length,
    limitedCompanies: all.filter((row) => row.entity_type === 'aktiebolag').length,
    soleTraders: all.filter((row) => row.entity_type === 'enskild_firma').length,
    agencies: all.filter((row) => row.workspace_kind === 'agency').length,
    agencyClients: all.filter((row) => row.workspace_kind === 'agency_client').length,
    activeAccess: all.filter((row) => row.access_status === 'active').length,
    missingAccess: all.filter((row) => row.access_status === 'missing').length,
    bankgiroReview: all.filter((row) => ACTIVE_BANKGIRO_REVIEW_STATUSES.includes(String(row.bankgiro_status ?? ''))).length,
    accountingIssues: all.filter((row) => Number(row.unlinked_document_count ?? 0) + Number(row.pending_inbox_count ?? 0) + Number(row.unbooked_transaction_count ?? 0) > 0).length,
  }

  const planOptions = ((plans ?? []) as Array<{ code: string | null; name: string | null }>)
    .filter((plan): plan is { code: string; name: string } => Boolean(plan.code && plan.name))

  return { rows, count: count ?? rows.length, kpis, planOptions }
}
