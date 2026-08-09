import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { checkFeatureAccess, featureAccessError } from '@/lib/platform/entitlements'

export type YearEndAccessSource =
  | 'feature_entitlement'
  | 'ixbrl_feature_entitlement'
  | 'one_time_purchase'
  | 'platform_admin_bypass'

export interface YearEndAccessDecision {
  allowed: boolean
  source?: YearEndAccessSource
  sourceId?: string | null
  reason?: 'missing_entitlement' | 'expired' | 'unauthorized' | 'database_error'
}


type CanonicalPeriodAccessRow = {
  allowed: boolean
  code: string
  access_source: YearEndAccessSource | null
  access_source_id: string | null
  effective_role: string | null
  purchase_id: string | null
  feature_access: boolean
  one_time_access: boolean
}

type RequireYearEndAccessOptions = {
  /** Use year_end.ixbrl as the entitlement feature, but still allow a year-end one-time purchase. */
  allowIxbrlFeature?: boolean
  /** Write an audit security event when a platform admin bypasses billing. Defaults to true. */
  auditPlatformBypass?: boolean
  operation?: string
  requestId?: string
  /** Require an effective write-capable company role for economic mutations. */
  requireWrite?: boolean
}

async function createTrustedAccessClient(): Promise<SupabaseClient> {
  const { createServiceClient } = await import('@/lib/supabase/server')
  return createServiceClient()
}

async function resolveCanonicalPeriodAccess(
  userId: string,
  companyId: string,
  fiscalPeriodId: string,
  requireWrite: boolean,
): Promise<YearEndAccessDecision> {
  let accessDb: SupabaseClient
  try {
    accessDb = await createTrustedAccessClient()
  } catch {
    return { allowed: false, reason: 'database_error' }
  }

  const { data, error } = await accessDb.rpc(
    'resolve_year_end_period_capability_for_user',
    {
      p_user_id: userId,
      p_company_id: companyId,
      p_fiscal_period_id: fiscalPeriodId,
      p_require_write: requireWrite,
    },
  )
  if (error) return { allowed: false, reason: 'database_error' }

  const row = (Array.isArray(data) ? data[0] : data) as CanonicalPeriodAccessRow | null
  if (!row) return { allowed: false, reason: 'database_error' }
  if (row.allowed && row.access_source) {
    return {
      allowed: true,
      source: row.access_source,
      sourceId: row.access_source_id ?? row.purchase_id ?? null,
    }
  }

  if (row.code === 'YEAR_END_PERIOD_PURCHASE_REQUIRED') {
    return { allowed: false, reason: 'missing_entitlement' }
  }
  if (
    row.code === 'YEAR_END_PERIOD_FORBIDDEN'
    || row.code === 'YEAR_END_COMPANY_ACCESS_FORBIDDEN'
    || row.code === 'YEAR_END_COMPANY_WRITE_FORBIDDEN'
  ) {
    return { allowed: false, reason: 'unauthorized' }
  }
  return { allowed: false, reason: 'database_error' }
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
    supabase = await createTrustedAccessClient()
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
 * Authorization and entitlement are two separate gates and are evaluated in
 * that order. The canonical database resolver — actor, company access, exact
 * fiscal period and write capability — always runs first when both actor and
 * period are known. A commercial entitlement can only substitute for *payment*
 * (`YEAR_END_PERIOD_PURCHASE_REQUIRED`); it can never substitute for access.
 *
 * Access order is therefore:
 *   1. canonical actor/company/period/write capability (database authority)
 *   2. on purchase-required only: optional grant for year_end.ixbrl
 *   3. platform_admin bypass, audited by callers through requireYearEndAccess
 */
export async function resolveYearEndAccess(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId?: string | null,
  userId?: string | null,
  options: RequireYearEndAccessOptions = {},
): Promise<YearEndAccessDecision> {
  if (userId && fiscalPeriodId) {
    const canonical = await resolveCanonicalPeriodAccess(
      userId,
      companyId,
      fiscalPeriodId,
      options.requireWrite === true,
    )
    if (canonical.allowed || !options.allowIxbrlFeature) return canonical

    // iXBRL may be sold as a distinct feature, so it can stand in for a
    // year-end purchase. It must not stand in for company access, period
    // binding, write capability or a failed resolver — those keep failing
    // closed exactly as the canonical resolver decided.
    if (canonical.reason !== 'missing_entitlement') return canonical

    const ixbrlEntitlement = await checkFeatureAccess(supabase, companyId, 'year_end.ixbrl')
    if (ixbrlEntitlement.allowed) {
      return {
        allowed: true,
        source: 'ixbrl_feature_entitlement',
        sourceId: ixbrlEntitlement.sourceId ?? null,
      }
    }
    return canonical
  }

  // Pre-period screens have no actor/period pair to authorize against. The
  // iXBRL grant is still honoured here because the caller has already passed
  // company access in withRouteContext, but no exact-period operation can
  // reach this branch.
  if (options.allowIxbrlFeature) {
    const ixbrlEntitlement = await checkFeatureAccess(supabase, companyId, 'year_end.ixbrl')
    if (ixbrlEntitlement.allowed) {
      return {
        allowed: true,
        source: 'ixbrl_feature_entitlement',
        sourceId: ixbrlEntitlement.sourceId ?? null,
      }
    }
  }

  // Compatibility path for pre-period screens. Exact-period operations must
  // always pass both actor and fiscal period and therefore cannot use this.
  const projectEntitlement = await checkFeatureAccess(supabase, companyId, 'year_end.projects')
  if (projectEntitlement.allowed) {
    return {
      allowed: true,
      source: 'feature_entitlement',
      sourceId: projectEntitlement.sourceId ?? null,
    }
  }

  if (projectEntitlement.reason === 'database_error') {
    return { allowed: false, reason: 'database_error' }
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
    // Audit is an invariant, not best effort. A platform bypass without a
    // durable audit row must fail closed before any data is returned or changed.
    await auditPlatformBypass(
      supabase,
      userId,
      companyId,
      fiscalPeriodId,
      options.operation,
      options.requestId,
    )
  }
  return decision
}

/**
 * Period-bound statutory reports are included in a one-time year-end purchase
 * without unlocking unrelated reports. A normal reports.core entitlement
 * remains sufficient.
 */
export async function requireYearEndReportAccess(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string,
  options: Pick<RequireYearEndAccessOptions, 'operation' | 'requestId'> = {},
): Promise<YearEndAccessDecision> {
  // Authorization first, exactly as in resolveYearEndAccess: a reports.core
  // entitlement is company-wide and says nothing about whether this actor may
  // read this company's period, so it must never short-circuit the canonical
  // actor/company/period check.
  const decision = await requireYearEndAccess(
    supabase,
    companyId,
    userId,
    fiscalPeriodId,
    options,
  )
  if (decision.allowed || decision.reason !== 'missing_entitlement') return decision

  // Authorized for the period but without a year-end product: a normal
  // reports.core entitlement is sufficient for these statutory reports.
  const reportEntitlement = await checkFeatureAccess(
    supabase,
    companyId,
    'reports.core',
  )
  if (reportEntitlement.allowed) {
    return {
      allowed: true,
      source: 'feature_entitlement',
      sourceId: reportEntitlement.sourceId ?? null,
    }
  }
  return decision
}

export function yearEndAccessDeniedResponse(
  featureCode = 'year_end.projects',
  reason?: YearEndAccessDecision['reason'],
): Response {
  return featureAccessError(featureCode, reason)
}
