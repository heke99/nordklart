import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { FeatureCode } from '@/lib/platform/feature-codes'

// Feature/plan codes live in feature-codes.ts (no server-only import) so the
// CI coverage script can read them. Re-exported here so application code
// keeps a single import path.
export {
  NORDKLART_FEATURES,
  NORDKLART_PLAN_CODES,
  type NordklartFeatureCode,
  type NordklartPlanCode,
  type FeatureCode,
} from '@/lib/platform/feature-codes'

export type FeatureAccessReason =
  | 'missing_entitlement'
  | 'expired'
  | 'disabled'
  | 'provisioning_pending'
  | 'unauthorized'

export interface FeatureAccessResult {
  allowed: boolean
  reason?: FeatureAccessReason
  sourceType?: 'manual_entitlement' | 'commercial_grant' | 'subscription_item' | string
  sourceId?: string
  expiresAt?: string | null
  limitValue?: number | null
  limitUnit?: string | null
}

export type CompanyFeatureAccess = {
  feature_code: string
  feature_name: string
  category: string
  risk_level: 'low' | 'normal' | 'high'
  enabled: boolean
  limit_value: number | null
  limit_unit: string | null
}

type FeatureAccessRpcRow = {
  allowed: boolean
  reason: FeatureAccessReason | null
  source_type: string | null
  source_id: string | null
  expires_at: string | null
  limit_value: number | string | null
  limit_unit: string | null
}

function toNumber(value: number | string | null): number | null {
  if (value === null) return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Resolves feature access through the database source of truth.
 *
 * The resolver intentionally does not fall back to raw entitlement rows: a
 * legacy plan row may be stale, a grant may have been revoked, and Bankgiro
 * operations must remain blocked until provider provisioning is complete.
 */
export async function checkFeatureAccess(
  supabase: SupabaseClient,
  companyId: string,
  featureCode: FeatureCode,
): Promise<FeatureAccessResult> {
  const { data, error } = await supabase.rpc('company_feature_access', {
    p_company_id: companyId,
    p_feature_code: featureCode,
  })

  const row = (Array.isArray(data) ? data[0] : null) as FeatureAccessRpcRow | null
  if (error || !row) {
    return { allowed: false, reason: 'missing_entitlement' }
  }

  return {
    allowed: row.allowed === true,
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.source_type ? { sourceType: row.source_type } : {}),
    ...(row.source_id ? { sourceId: row.source_id } : {}),
    ...(row.expires_at !== undefined ? { expiresAt: row.expires_at } : {}),
    ...(row.limit_value !== undefined ? { limitValue: toNumber(row.limit_value) } : {}),
    ...(row.limit_unit !== undefined ? { limitUnit: row.limit_unit } : {}),
  }
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

  return (data ?? []).map((row) => ({
    feature_code: String(row.feature_code),
    feature_name: String(row.feature_name),
    category: String(row.category),
    risk_level: row.risk_level as CompanyFeatureAccess['risk_level'],
    enabled: row.enabled === true,
    limit_value: toNumber(row.limit_value as number | string | null),
    limit_unit: typeof row.limit_unit === 'string' ? row.limit_unit : null,
  }))
}

export function gateCopy(enabled: boolean) {
  return enabled ? 'Aktiv' : 'Ej aktiverad'
}
