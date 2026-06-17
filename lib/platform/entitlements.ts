import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'

export type FeatureCode =
  | 'bookkeeping.core'
  | 'invoicing.core'
  | 'reports.core'
  | 'bank.automation'
  | 'agency.clients'
  | 'year_end.projects'
  | 'year_end.ixbrl'
  | 'bankgiro.onboarding'
  | 'api.access'
  | 'webhooks.delivery'

export interface FeatureAccessResult {
  allowed: boolean
  reason?: 'missing_entitlement' | 'expired' | 'disabled'
  entitlementId?: string
  expiresAt?: string | null
}

export async function checkFeatureAccess(
  supabase: SupabaseClient,
  companyId: string,
  featureCode: FeatureCode | string,
): Promise<FeatureAccessResult> {
  const { data, error } = await supabase
    .from('company_entitlements')
    .select('id, enabled, expires_at')
    .eq('company_id', companyId)
    .eq('feature_code', featureCode)
    .eq('enabled', true)
    .order('expires_at', { ascending: false, nullsFirst: true })
    .limit(1)
    .maybeSingle()

  if (error || !data) return { allowed: false, reason: 'missing_entitlement' }

  const row = data as { id: string; enabled: boolean; expires_at: string | null }
  if (!row.enabled) return { allowed: false, reason: 'disabled', entitlementId: row.id }
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    return { allowed: false, reason: 'expired', entitlementId: row.id, expiresAt: row.expires_at }
  }

  return { allowed: true, entitlementId: row.id, expiresAt: row.expires_at }
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
