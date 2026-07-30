import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

export type FiscalPeriodAccessSource =
  | 'feature_entitlement'
  | 'one_time_purchase'
  | 'platform_admin'

export type FiscalPeriodAccessDecision = {
  allowed: boolean
  canWrite: boolean
  canCreateFiscalYear: boolean
  companyExists: boolean
  accessSource?: FiscalPeriodAccessSource
  effectiveRole?: string | null
  allowedPeriodIds: string[] | null
  unassignedPurchaseId?: string | null
  reason?:
    | 'permission_denied'
    | 'missing_entitlement'
    | 'one_off_expired'
    | 'company_not_found'
    | 'database_error'
  databaseError?: string
}

type AccessRow = {
  company_id: string
  access_source: 'direct' | 'agency' | 'platform'
  effective_role: string
  can_read: boolean
  can_write: boolean
  can_manage_platform: boolean
}

type FeatureAccessRow = {
  allowed: boolean
}

type OneTimePurchaseRow = {
  id: string
  fiscal_period_id: string | null
  permanent_access: boolean | null
  access_starts_at: string | null
  access_expires_at: string | null
  status: string
}

function isPurchaseActive(row: OneTimePurchaseRow, now: number): boolean {
  if (!['paid', 'active', 'fulfilled'].includes(row.status)) return false
  if (row.access_starts_at && new Date(row.access_starts_at).getTime() > now) return false
  if (row.permanent_access) return true
  if (!row.access_expires_at) return true
  return new Date(row.access_expires_at).getTime() >= now
}

/**
 * Resolves the narrowly scoped right to list/create fiscal years for a
 * year-end flow. This intentionally does not depend on bookkeepingCore.
 *
 * The function is called with a service-role client, but it never trusts a
 * client-supplied company id by itself: effective access is resolved for the
 * authenticated actor through the service-only canonical DB resolver first.
 */
export async function resolveFiscalPeriodAccess(
  db: SupabaseClient,
  actorUserId: string,
  companyId: string,
): Promise<FiscalPeriodAccessDecision> {
  const { data: company, error: companyError } = await db
    .from('companies')
    .select('id')
    .eq('id', companyId)
    .is('archived_at', null)
    .maybeSingle()

  if (companyError) {
    return {
      allowed: false,
      canWrite: false,
      canCreateFiscalYear: false,
      companyExists: false,
      allowedPeriodIds: [],
      reason: 'database_error',
      databaseError: companyError.message,
    }
  }
  if (!company) {
    return {
      allowed: false,
      canWrite: false,
      canCreateFiscalYear: false,
      companyExists: false,
      allowedPeriodIds: [],
      reason: 'company_not_found',
    }
  }

  const { data: accessData, error: accessError } = await db.rpc(
    'resolve_company_access_for_user',
    {
      p_user_id: actorUserId,
      p_company_id: companyId,
    },
  )

  if (accessError) {
    return {
      allowed: false,
      canWrite: false,
      canCreateFiscalYear: false,
      companyExists: true,
      allowedPeriodIds: [],
      reason: 'database_error',
      databaseError: accessError.message,
    }
  }

  const access = (Array.isArray(accessData) ? accessData[0] : null) as AccessRow | null
  if (!access?.can_read) {
    return {
      allowed: false,
      canWrite: false,
      canCreateFiscalYear: false,
      companyExists: true,
      allowedPeriodIds: [],
      reason: 'permission_denied',
    }
  }

  if (access.can_manage_platform && access.effective_role === 'platform_admin') {
    return {
      allowed: true,
      canWrite: true,
      canCreateFiscalYear: true,
      companyExists: true,
      accessSource: 'platform_admin',
      effectiveRole: access.effective_role,
      allowedPeriodIds: null,
    }
  }

  const [projectFeature, purchasesResult] = await Promise.all([
    db.rpc('company_feature_access', {
      p_company_id: companyId,
      p_feature_code: 'year_end.projects',
    }),
    db
      .from('one_time_purchases')
      .select('id,fiscal_period_id,permanent_access,access_starts_at,access_expires_at,status')
      .eq('company_id', companyId)
      .eq('purchase_type', 'year_end')
      .order('created_at', { ascending: false }),
  ])

  if (projectFeature.error || purchasesResult.error) {
    return {
      allowed: false,
      canWrite: false,
      canCreateFiscalYear: false,
      companyExists: true,
      allowedPeriodIds: [],
      effectiveRole: access.effective_role,
      reason: 'database_error',
      databaseError:
        projectFeature.error?.message ??
        purchasesResult.error?.message ??
        'Unknown access query error',
    }
  }

  const projectRow = (Array.isArray(projectFeature.data) ? projectFeature.data[0] : null) as FeatureAccessRow | null
  const hasFeature = projectRow?.allowed === true

  if (hasFeature) {
    return {
      allowed: true,
      canWrite: access.can_write,
      canCreateFiscalYear: access.can_write,
      companyExists: true,
      accessSource: 'feature_entitlement',
      effectiveRole: access.effective_role,
      allowedPeriodIds: null,
    }
  }

  const allPurchases = (purchasesResult.data ?? []) as OneTimePurchaseRow[]
  const activePurchases = allPurchases.filter((row) => isPurchaseActive(row, Date.now()))
  const unassigned = activePurchases.find((row) => row.fiscal_period_id === null) ?? null
  const periodIds = [...new Set(
    activePurchases
      .map((row) => row.fiscal_period_id)
      .filter((id): id is string => Boolean(id)),
  )]

  if (activePurchases.length > 0) {
    return {
      allowed: true,
      canWrite: access.can_write,
      canCreateFiscalYear: access.can_write && Boolean(unassigned),
      companyExists: true,
      accessSource: 'one_time_purchase',
      effectiveRole: access.effective_role,
      allowedPeriodIds: periodIds,
      unassignedPurchaseId: unassigned?.id ?? null,
    }
  }

  return {
    allowed: false,
    canWrite: false,
    canCreateFiscalYear: false,
    companyExists: true,
    effectiveRole: access.effective_role,
    allowedPeriodIds: [],
    reason: allPurchases.length > 0 ? 'one_off_expired' : 'missing_entitlement',
  }
}

/**
 * Platform-admin reads and writes must leave a durable audit trail. The caller
 * must fail the operation if this throws; superadmin audit is not best-effort.
 */
export async function auditPlatformFiscalPeriodOperation(
  db: SupabaseClient,
  params: {
    actorUserId: string
    companyId: string
    operation: 'list' | 'create'
    fiscalPeriodId?: string | null
    requestId?: string | null
  },
): Promise<void> {
  const { error } = await db.from('audit_log').insert({
    user_id: params.actorUserId,
    actor_id: params.actorUserId,
    company_id: params.companyId,
    action: 'SECURITY_EVENT',
    table_name: 'fiscal_periods',
    record_id: params.fiscalPeriodId ?? params.companyId,
    description:
      params.operation === 'list'
        ? 'Superadmin läste räkenskapsperioder för bokslutsadministration.'
        : 'Superadmin skapade räkenskapsår för bokslutsadministration.',
    new_state: {
      company_id: params.companyId,
      fiscal_period_id: params.fiscalPeriodId ?? null,
      operation: `year_end.fiscal_periods.${params.operation}`,
      request_id: params.requestId ?? null,
      access_source: 'platform_admin',
    },
  })

  if (error) {
    throw new Error(`Audit log write failed: ${error.message}`)
  }
}
