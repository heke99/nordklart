import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { checkFeatureAccess, featureAccessError } from '@/lib/platform/entitlements'
import { createLogger } from '@/lib/logger'

const log = createLogger('year-end/access')

export type YearEndAccessSource =
  | 'feature_entitlement'
  | 'ixbrl_feature_entitlement'
  | 'one_time_purchase'
  | 'platform_admin_bypass'

export interface YearEndAccessDecision {
  allowed: boolean
  source?: YearEndAccessSource
  sourceId?: string | null
  reason?: 'missing_entitlement' | 'expired' | 'unauthorized'
}

type OneTimePurchaseRow = {
  id: string
  permanent_access?: boolean | null
  access_expires_at?: string | null
}

type RequireYearEndAccessOptions = {
  /** Use year_end.ixbrl as the entitlement feature, but still allow a year-end one-time purchase. */
  allowIxbrlFeature?: boolean
  /** Write an audit security event when a platform admin bypasses billing. Defaults to true. */
  auditPlatformBypass?: boolean
  operation?: string
  requestId?: string
}

async function isPlatformAdmin(supabase: SupabaseClient, userId?: string | null): Promise<boolean> {
  if (!userId) return false
  const { data } = await supabase
    .from('platform_roles')
    .select('role')
    .eq('user_id', userId)
    .eq('role', 'platform_admin')
    .is('revoked_at', null)
    .maybeSingle()
  return Boolean(data)
}

async function auditPlatformBypass(
  fallbackClient: SupabaseClient,
  userId: string,
  companyId: string,
  fiscalPeriodId: string,
  operation?: string,
  requestId?: string,
) {
  // Write with the service-role client so the append-only audit_log RLS can
  // never silently drop the security event (the caller's session client may
  // lack an INSERT policy in some deployments). Falls back to the caller's
  // client when the service client is unavailable (e.g. unit tests).
  let supabase = fallbackClient
  try {
    const { createServiceClient } = await import('@/lib/supabase/server')
    supabase = createServiceClient()
  } catch {
    // Keep the fallback client.
  }
  const { error } = await supabase.from('audit_log').insert({
    user_id: userId,
    actor_id: userId,
    action: 'SECURITY_EVENT',
    table_name: 'fiscal_periods',
    record_id: fiscalPeriodId,
    description: 'Platform admin used year-end/declaration access without payment.',
    new_state: {
      company_id: companyId,
      fiscal_period_id: fiscalPeriodId,
      operation: operation ?? null,
      request_id: requestId ?? null,
      access_source: 'platform_admin_bypass',
    },
  })
  // supabase-js returns errors instead of throwing — surface it so the
  // caller's error log fires (bypass-without-audit must never be silent).
  if (error) throw new Error(`audit_log insert failed: ${error.message}`)
}

/**
 * Returns true when the company may use the year-end product for the period.
 * Kept for existing callers; new routes should use requireYearEndAccess().
 */
export async function canUseYearEnd(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId?: string | null,
): Promise<boolean> {
  const decision = await resolveYearEndAccess(supabase, companyId, fiscalPeriodId)
  return decision.allowed
}

/**
 * Resolves the product/payment source for a specific fiscal period.
 *
 * Access order is deliberately explicit:
 *   1. subscription/manual/commercial grant for year_end.projects
 *   2. optional subscription/manual/commercial grant for year_end.ixbrl
 *   3. active/paid one-time purchase for the exact fiscal period
 *   4. platform_admin bypass, audited by callers through requireYearEndAccess
 */
export async function resolveYearEndAccess(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId?: string | null,
  userId?: string | null,
  options: RequireYearEndAccessOptions = {},
): Promise<YearEndAccessDecision> {
  const projectEntitlement = await checkFeatureAccess(supabase, companyId, 'year_end.projects')
  if (projectEntitlement.allowed) {
    return { allowed: true, source: 'feature_entitlement', sourceId: projectEntitlement.sourceId ?? null }
  }

  if (options.allowIxbrlFeature) {
    const ixbrlEntitlement = await checkFeatureAccess(supabase, companyId, 'year_end.ixbrl')
    if (ixbrlEntitlement.allowed) {
      return { allowed: true, source: 'ixbrl_feature_entitlement', sourceId: ixbrlEntitlement.sourceId ?? null }
    }
  }

  if (fiscalPeriodId) {
    const { data } = await supabase
      .from('one_time_purchases')
      .select('id, status, access_expires_at, permanent_access')
      .eq('company_id', companyId)
      .eq('purchase_type', 'year_end')
      .eq('fiscal_period_id', fiscalPeriodId)
      .in('status', ['paid', 'active', 'fulfilled'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const row = data as OneTimePurchaseRow | null
    if (row) {
      const hasAccess = Boolean(row.permanent_access)
        || !row.access_expires_at
        || new Date(row.access_expires_at).getTime() >= Date.now()
      if (hasAccess) {
        return { allowed: true, source: 'one_time_purchase', sourceId: row.id }
      }
      return { allowed: false, reason: 'expired', sourceId: row.id }
    }
  }

  if (await isPlatformAdmin(supabase, userId)) {
    return { allowed: true, source: 'platform_admin_bypass' }
  }

  return { allowed: false, reason: 'missing_entitlement' }
}

/**
 * Route-level guard for all fiscal-period-bound year-end/declaration actions.
 * This is intentionally NOT handled in featureForOperation because one-time
 * purchases are period-specific and the wrapper does not know period_id yet.
 */
export async function requireYearEndAccess(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string,
  options: RequireYearEndAccessOptions = {},
): Promise<YearEndAccessDecision> {
  const decision = await resolveYearEndAccess(supabase, companyId, fiscalPeriodId, userId, options)
  if (
    decision.allowed
    && decision.source === 'platform_admin_bypass'
    && options.auditPlatformBypass !== false
  ) {
    try {
      await auditPlatformBypass(
        supabase,
        userId,
        companyId,
        fiscalPeriodId,
        options.operation,
        options.requestId,
      )
    } catch (err) {
      // Never block a legitimate platform admin because an optional audit sink
      // is unavailable — but surface the gap loudly: bypass-without-audit is a
      // compliance signal operations must see.
      log.error('platform admin year-end bypass could NOT be audit-logged', err as Error, {
        userId,
        companyId,
        fiscalPeriodId,
        operation: options.operation ?? null,
        requestId: options.requestId ?? null,
      })
    }
  }
  return decision
}

export function yearEndAccessDeniedResponse(featureCode = 'year_end.projects'): Response {
  return featureAccessError(featureCode)
}
