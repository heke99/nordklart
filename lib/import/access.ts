import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

export type SieImportAccessMode = 'bookkeeping' | 'year_end' | 'one_off' | 'platform'

export type SieImportAccessDecision = {
  allowed: boolean
  canWrite: boolean
  companyExists: boolean
  mode?: SieImportAccessMode
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
  effective_role: string
  can_read: boolean
  can_write: boolean
  can_manage_platform: boolean
}

type FeatureAccessRow = { allowed: boolean }

type PurchaseRow = {
  id: string
  fiscal_period_id: string | null
  permanent_access: boolean | null
  access_starts_at: string | null
  access_expires_at: string | null
  status: string
}

function activePurchase(row: PurchaseRow, now: number): boolean {
  if (!['paid', 'active', 'fulfilled'].includes(row.status)) return false
  if (row.access_starts_at && new Date(row.access_starts_at).getTime() > now) return false
  if (row.permanent_access) return true
  if (!row.access_expires_at) return true
  return new Date(row.access_expires_at).getTime() >= now
}

/**
 * Canonical access resolver for SIE import surfaces.
 *
 * SIE is shared by normal bookkeeping and year-end-only customers. The
 * resolver therefore accepts either bookkeeping.core, year_end.projects, or
 * an active period-scoped one-off year-end purchase. iXBRL access alone is not
 * authority to alter the ledger or import bookkeeping data. It is
 * intentionally called with a service client and always verifies the
 * authenticated actor against resolve_company_access_for_user before the
 * service client is used for the narrowly scoped operation.
 */
export async function resolveSieImportAccess(
  db: SupabaseClient,
  actorUserId: string,
  companyId: string,
): Promise<SieImportAccessDecision> {
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
      companyExists: false,
      allowedPeriodIds: [],
      reason: 'company_not_found',
    }
  }

  const { data: accessData, error: accessError } = await db.rpc(
    'resolve_company_access_for_user',
    { p_user_id: actorUserId, p_company_id: companyId },
  )
  if (accessError) {
    return {
      allowed: false,
      canWrite: false,
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
      companyExists: true,
      allowedPeriodIds: [],
      reason: 'permission_denied',
    }
  }

  if (access.can_manage_platform && access.effective_role === 'platform_admin') {
    return {
      allowed: true,
      canWrite: true,
      companyExists: true,
      mode: 'platform',
      effectiveRole: access.effective_role,
      allowedPeriodIds: null,
    }
  }

  const [bookkeeping, yearEnd, purchases] = await Promise.all([
    db.rpc('company_feature_access', {
      p_company_id: companyId,
      p_feature_code: 'bookkeeping.core',
    }),
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

  const queryError = bookkeeping.error ?? yearEnd.error ?? purchases.error
  if (queryError) {
    return {
      allowed: false,
      canWrite: false,
      companyExists: true,
      effectiveRole: access.effective_role,
      allowedPeriodIds: [],
      reason: 'database_error',
      databaseError: queryError.message,
    }
  }

  const featureAllowed = (result: typeof bookkeeping): boolean => {
    const row = (Array.isArray(result.data) ? result.data[0] : null) as FeatureAccessRow | null
    return row?.allowed === true
  }

  if (featureAllowed(bookkeeping)) {
    return {
      allowed: true,
      canWrite: access.can_write,
      companyExists: true,
      mode: 'bookkeeping',
      effectiveRole: access.effective_role,
      allowedPeriodIds: null,
    }
  }

  if (featureAllowed(yearEnd)) {
    return {
      allowed: true,
      canWrite: access.can_write,
      companyExists: true,
      mode: 'year_end',
      effectiveRole: access.effective_role,
      allowedPeriodIds: null,
    }
  }

  const allPurchases = (purchases.data ?? []) as PurchaseRow[]
  const active = allPurchases.filter((row) => activePurchase(row, Date.now()))
  if (active.length > 0) {
    const unassigned = active.find((row) => row.fiscal_period_id === null) ?? null
    const periodIds = [...new Set(
      active
        .map((row) => row.fiscal_period_id)
        .filter((id): id is string => Boolean(id)),
    )]
    const roleCanOperateOneOff = [
      'company_owner',
      'company_admin',
      'accountant',
      'client_user',
    ].includes(access.effective_role)

    return {
      allowed: true,
      canWrite: access.can_write || roleCanOperateOneOff,
      companyExists: true,
      mode: 'one_off',
      effectiveRole: access.effective_role,
      allowedPeriodIds: periodIds,
      unassignedPurchaseId: unassigned?.id ?? null,
    }
  }

  return {
    allowed: false,
    canWrite: false,
    companyExists: true,
    effectiveRole: access.effective_role,
    allowedPeriodIds: [],
    reason: allPurchases.length > 0 ? 'one_off_expired' : 'missing_entitlement',
  }
}

/** Return true when the resolved SIE access permits this exact period. */
export function isSieFiscalPeriodAllowed(
  access: SieImportAccessDecision | undefined,
  fiscalPeriodId: string | null | undefined,
): boolean {
  if (!access?.allowed) return false
  if (access.allowedPeriodIds === null) return true
  if (!fiscalPeriodId) return false
  return access.allowedPeriodIds.includes(fiscalPeriodId)
}

export async function auditPlatformSieImportOperation(
  db: SupabaseClient,
  params: {
    actorUserId: string
    companyId: string
    operation: string
    requestId: string
  },
): Promise<void> {
  const { error } = await db.from('audit_log').insert({
    user_id: params.actorUserId,
    actor_id: params.actorUserId,
    company_id: params.companyId,
    action: 'SECURITY_EVENT',
    table_name: 'sie_imports',
    record_id: params.companyId,
    description: 'Superadmin använde SIE-importflödet för bokslutsadministration.',
    new_state: {
      company_id: params.companyId,
      operation: params.operation,
      request_id: params.requestId,
      access_source: 'platform_admin',
    },
  })

  if (error) throw new Error(`Audit log write failed: ${error.message}`)
}

/**
 * Enforces the fiscal-year boundary for one-off SIE access. Subscription,
 * agency and platform modes are company-wide; one-off access is limited to
 * the purchased period, except for an unassigned purchase before the atomic
 * fiscal-year creation step.
 */
export async function resolveSieFiscalYearAccess(
  db: SupabaseClient,
  access: SieImportAccessDecision | undefined,
  companyId: string,
  periodStart: string | null | undefined,
  periodEnd: string | null | undefined,
): Promise<{ allowed: boolean; fiscalPeriodId: string | null }> {
  if (!access?.allowed) return { allowed: false, fiscalPeriodId: null }
  if (!periodStart || !periodEnd) return { allowed: access.allowedPeriodIds === null, fiscalPeriodId: null }

  const { data, error } = await db
    .from('fiscal_periods')
    .select('id')
    .eq('company_id', companyId)
    .eq('period_start', periodStart)
    .eq('period_end', periodEnd)
    .maybeSingle()

  if (error) throw new Error(`Could not resolve SIE fiscal period: ${error.message}`)
  const fiscalPeriodId = data?.id ?? null

  if (access.allowedPeriodIds === null) return { allowed: true, fiscalPeriodId }
  if (fiscalPeriodId) {
    return { allowed: access.allowedPeriodIds.includes(fiscalPeriodId), fiscalPeriodId }
  }
  return { allowed: Boolean(access.unassignedPurchaseId), fiscalPeriodId: null }
}
