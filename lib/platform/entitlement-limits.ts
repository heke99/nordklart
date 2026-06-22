import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

export const COMMERCIAL_LIMITS = {
  companyUsers: 'company.users',
  externalAdvisors: 'external.advisors',
  payrollEmployees: 'payroll.employees',
  agencyClients: 'agency.clients',
  agencyStaff: 'agency.staff',
} as const

export type CommercialLimitCode = (typeof COMMERCIAL_LIMITS)[keyof typeof COMMERCIAL_LIMITS]

export type CommercialLimitResult = {
  allowed: boolean
  reason: string
  featureCode: string
  limitValue: number | null
  limitUnit: string | null
  usageValue: number | null
  remainingValue: number | null
}

type LimitRpcRow = {
  allowed: boolean | null
  reason: string | null
  feature_code: string | null
  limit_value: number | string | null
  limit_unit: string | null
  usage_value: number | string | null
  remaining_value: number | string | null
}

function toNumber(value: number | string | null): number | null {
  if (value === null) return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function normalize(row: LimitRpcRow | null, featureCode: string): CommercialLimitResult {
  if (!row) {
    return {
      allowed: false,
      reason: 'missing_entitlement',
      featureCode,
      limitValue: null,
      limitUnit: null,
      usageValue: null,
      remainingValue: null,
    }
  }

  return {
    allowed: row.allowed === true,
    reason: row.reason || (row.allowed ? 'within_limit' : 'missing_entitlement'),
    featureCode: row.feature_code || featureCode,
    limitValue: toNumber(row.limit_value),
    limitUnit: row.limit_unit,
    usageValue: toNumber(row.usage_value),
    remainingValue: toNumber(row.remaining_value),
  }
}

export async function getCommercialLimit(
  supabase: SupabaseClient,
  companyId: string,
  featureCode: CommercialLimitCode | string,
): Promise<CommercialLimitResult> {
  const { data, error } = await supabase.rpc('company_commercial_limit', {
    p_company_id: companyId,
    p_feature_code: featureCode,
  })

  if (error) {
    return {
      allowed: false,
      reason: error.message || 'limit_check_failed',
      featureCode,
      limitValue: null,
      limitUnit: null,
      usageValue: null,
      remainingValue: null,
    }
  }

  return normalize((Array.isArray(data) ? data[0] : null) as LimitRpcRow | null, featureCode)
}

export function commercialLimitErrorMessage(result: CommercialLimitResult, fallback: string) {
  if (result.reason === 'missing_entitlement') return 'Din plan saknar åtkomst till den här funktionen. Uppgradera abonnemanget eller aktivera rätt tillägg.'
  if (result.reason === 'limit_reached') {
    const limit = result.limitValue === null ? '' : ` upp till ${result.limitValue}${result.limitUnit ? ` ${result.limitUnit}` : ''}`
    return `${fallback}${limit}. Uppgradera planen eller lägg till extra kapacitet.`
  }
  if (result.reason === 'unauthorized') return 'Behörighet saknas för att kontrollera abonnemangsgränsen.'
  return fallback
}

export async function assertCommercialLimit(
  supabase: SupabaseClient,
  companyId: string,
  featureCode: CommercialLimitCode | string,
  fallbackMessage: string,
): Promise<{ ok: true } | { ok: false; response: Response; result: CommercialLimitResult }> {
  const result = await getCommercialLimit(supabase, companyId, featureCode)
  if (result.allowed) return { ok: true }

  return {
    ok: false,
    result,
    response: Response.json(
      {
        error: 'PLAN_LIMIT_REACHED',
        message: commercialLimitErrorMessage(result, fallbackMessage),
        featureCode: result.featureCode,
        reason: result.reason,
        limitValue: result.limitValue,
        usageValue: result.usageValue,
        remainingValue: result.remainingValue,
      },
      { status: result.reason === 'unauthorized' ? 403 : 402 },
    ),
  }
}

export async function canInviteCompanyUser(supabase: SupabaseClient, companyId: string) {
  return getCommercialLimit(supabase, companyId, COMMERCIAL_LIMITS.companyUsers)
}

export async function canInviteExternalAdvisor(supabase: SupabaseClient, companyId: string) {
  return getCommercialLimit(supabase, companyId, COMMERCIAL_LIMITS.externalAdvisors)
}

export async function canAddPayrollEmployee(supabase: SupabaseClient, companyId: string) {
  return getCommercialLimit(supabase, companyId, COMMERCIAL_LIMITS.payrollEmployees)
}

export async function canCreateAgencyClient(supabase: SupabaseClient, agencyCompanyId: string) {
  return getCommercialLimit(supabase, agencyCompanyId, COMMERCIAL_LIMITS.agencyClients)
}

export async function canInviteAgencyStaff(supabase: SupabaseClient, agencyCompanyId: string) {
  return getCommercialLimit(supabase, agencyCompanyId, COMMERCIAL_LIMITS.agencyStaff)
}
