import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'

export const NORDKLART_FEATURES = {
  bookkeepingCore: 'bookkeeping.core',
  invoicingCore: 'invoicing.core',
  reportsCore: 'reports.core',
  onboardingPaths: 'onboarding.paths',
  bankAutomation: 'bank.automation',
  bankProviderModel: 'bank.provider_model',
  bankTransactionIngest: 'bank.transaction_ingest',
  bankMatching: 'bank.matching',
  bankAutobook: 'bank.autobook',
  agencyClients: 'agency.clients',
  agencyDeadlines: 'agency.deadlines',
  agencyReviewQueue: 'agency.review_queue',
  yearEndProjects: 'year_end.projects',
  yearEndIxbrl: 'year_end.ixbrl',
  bankgiroOnboarding: 'bankgiro.onboarding',
  apiAccess: 'api.access',
  webhookDelivery: 'webhooks.delivery',
} as const

export type NordklartFeatureCode = (typeof NORDKLART_FEATURES)[keyof typeof NORDKLART_FEATURES]
export type FeatureCode = NordklartFeatureCode | (string & {})

export interface FeatureAccessResult {
  allowed: boolean
  reason?: 'missing_entitlement' | 'expired' | 'disabled'
  entitlementId?: string
  expiresAt?: string | null
}

export const NORDKLART_PLAN_CODES = [
  'start_monthly',
  'auto_monthly',
  'agency_monthly',
  'year_end_one_time',
  'bankgiro_addon_monthly',
] as const

export type NordklartPlanCode = (typeof NORDKLART_PLAN_CODES)[number]

export type CompanyFeatureAccess = {
  feature_code: string
  feature_name: string
  category: string
  risk_level: 'low' | 'normal' | 'high'
  enabled: boolean
  limit_value: number | null
  limit_unit: string | null
}

function isActivePeriod(startsAt?: string | null, expiresAt?: string | null) {
  const now = Date.now()
  if (startsAt && new Date(startsAt).getTime() > now) return false
  if (expiresAt && new Date(expiresAt).getTime() < now) return false
  return true
}

export async function checkFeatureAccess(
  supabase: SupabaseClient,
  companyId: string,
  featureCode: FeatureCode,
): Promise<FeatureAccessResult> {
  const rpc = await supabase.rpc('company_has_feature', {
    p_company_id: companyId,
    p_feature_code: featureCode,
  })

  if (!rpc.error && rpc.data === true) return { allowed: true }

  const entitlement = await supabase
    .from('company_entitlements')
    .select('id, enabled, starts_at, expires_at')
    .eq('company_id', companyId)
    .eq('feature_code', featureCode)
    .order('expires_at', { ascending: false, nullsFirst: true })
    .limit(1)
    .maybeSingle()

  if (entitlement.error || !entitlement.data) {
    return { allowed: false, reason: 'missing_entitlement' }
  }

  const row = entitlement.data as {
    id: string
    enabled: boolean
    starts_at?: string | null
    expires_at?: string | null
  }

  if (!row.enabled) return { allowed: false, reason: 'disabled', entitlementId: row.id }
  if (!isActivePeriod(row.starts_at, row.expires_at)) {
    return { allowed: false, reason: 'expired', entitlementId: row.id, expiresAt: row.expires_at ?? null }
  }

  return { allowed: true, entitlementId: row.id, expiresAt: row.expires_at ?? null }
}

export function featureAccessError(featureCode: string): Response {
  return Response.json(
    {
      error: 'FEATURE_NOT_ENABLED',
      message: `Funktionen ${featureCode} är inte aktiverad för bolaget. Aktivera rätt plan, tillägg eller engångsköp i plattformen.`,
    },
    { status: 403 },
  )
}

export async function hasCompanyFeature(
  supabase: SupabaseClient,
  companyId: string,
  featureCode: FeatureCode,
): Promise<boolean> {
  const access = await checkFeatureAccess(supabase, companyId, featureCode)
  return access.allowed
}

export async function listCompanyFeatureAccess(
  supabase: SupabaseClient,
  companyId: string,
): Promise<CompanyFeatureAccess[]> {
  const { data, error } = await supabase
    .from('company_feature_access_v')
    .select('feature_code, feature_name, category, risk_level, enabled, limit_value, limit_unit')
    .eq('company_id', companyId)
    .order('category', { ascending: true })
    .order('feature_code', { ascending: true })

  if (error) return []
  return (data ?? []) as CompanyFeatureAccess[]
}

export function gateCopy(enabled: boolean) {
  return enabled ? 'Aktiv' : 'Ej aktiverad'
}
