import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'

export type AccessSource = 'direct' | 'agency' | 'platform'
export type EffectiveCompanyRole =
  | 'platform_admin'
  | 'company_owner'
  | 'company_admin'
  | 'accountant'
  | 'reviewer'
  | 'client_user'
  | 'read_only'
  | 'auditor'

export type CompanyAccess = {
  companyId: string
  accessSource: AccessSource
  agencyId: string | null
  effectiveRole: EffectiveCompanyRole
  canRead: boolean
  canWrite: boolean
  canReview: boolean
  canManageCompany: boolean
  canManageAgency: boolean
  canManagePlatform: boolean
}

export type AccessibleCompany = CompanyAccess & {
  name: string
  orgNumber: string | null
  entityType: 'enskild_firma' | 'aktiebolag'
  archivedAt: string | null
}

const log = createLogger('company-access')

type DirectMembershipRole = 'owner' | 'admin' | 'member' | 'viewer' | 'accountant' | 'auditor' | string | null

type DirectMembershipRow = {
  company_id: string
  role: DirectMembershipRole
  status?: string | null
}

type DirectCompanyRow = {
  id: string
  name: string | null
  org_number: string | null
  entity_type: string | null
  archived_at: string | null
}

function asBoolean(value: unknown): boolean {
  return value === true
}

function normalizeAccess(row: Record<string, unknown>): CompanyAccess {
  return {
    companyId: String(row.company_id),
    accessSource: row.access_source as AccessSource,
    agencyId: typeof row.agency_id === 'string' ? row.agency_id : null,
    effectiveRole: row.effective_role as EffectiveCompanyRole,
    canRead: asBoolean(row.can_read),
    canWrite: asBoolean(row.can_write),
    canReview: asBoolean(row.can_review),
    canManageCompany: asBoolean(row.can_manage_company),
    canManageAgency: asBoolean(row.can_manage_agency),
    canManagePlatform: asBoolean(row.can_manage_platform),
  }
}

function directAccess(companyId: string, role: DirectMembershipRole, status: string | null = 'active'): CompanyAccess {
  const effectiveRole: EffectiveCompanyRole = role === 'owner'
    ? 'company_owner'
    : role === 'admin'
      ? 'company_admin'
      : role === 'accountant'
        ? 'accountant'
        : role === 'auditor'
          ? 'auditor'
          : role === 'member'
            ? 'client_user'
            : 'read_only'

  const isFullyActive = status !== 'active_limited'

  return {
    companyId,
    accessSource: 'direct',
    agencyId: null,
    effectiveRole,
    canRead: true,
    canWrite: isFullyActive && ['company_owner', 'company_admin', 'accountant', 'client_user'].includes(effectiveRole),
    canReview: isFullyActive && ['company_owner', 'company_admin', 'accountant', 'reviewer', 'auditor'].includes(effectiveRole),
    canManageCompany: isFullyActive && (effectiveRole === 'company_owner' || effectiveRole === 'company_admin'),
    canManageAgency: false,
    canManagePlatform: false,
  }
}

function logResolverFallback(operation: string, error: { code?: string; message?: string } | null) {
  log.warn('Falling back to direct membership access.', {
    operation,
    code: error?.code ?? 'unknown',
  })
}

async function currentUserId(supabase: SupabaseClient): Promise<string | null> {
  const { data: { user }, error } = await supabase.auth.getUser()
  return error || !user ? null : user.id
}

async function resolveDirectMembershipAccess(
  supabase: SupabaseClient,
  companyId: string,
): Promise<CompanyAccess | null> {
  const userId = await currentUserId(supabase)
  if (!userId) return null

  const { data, error } = await supabase
    .from('company_members')
    .select('company_id, role, status')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .in('status', ['active', 'active_limited'])
    .maybeSingle()

  if (error || !data) return null
  const membership = data as DirectMembershipRow
  return directAccess(membership.company_id, membership.role, membership.status ?? 'active')
}

async function listDirectAccessibleCompanies(
  supabase: SupabaseClient,
): Promise<AccessibleCompany[]> {
  const userId = await currentUserId(supabase)
  if (!userId) return []

  const { data: membershipRows, error: membershipError } = await supabase
    .from('company_members')
    .select('company_id, role, status')
    .eq('user_id', userId)
    .in('status', ['active', 'active_limited'])

  if (membershipError || !membershipRows?.length) return []

  const memberships = membershipRows as DirectMembershipRow[]
  const companyIds = [...new Set(memberships.map((membership) => membership.company_id))]
  const { data: companyRows, error: companyError } = await supabase
    .from('companies')
    .select('id, name, org_number, entity_type, archived_at')
    .in('id', companyIds)
    .is('archived_at', null)

  if (companyError || !companyRows?.length) return []

  const companiesById = new Map(
    (companyRows as DirectCompanyRow[]).map((company) => [company.id, company]),
  )

  return memberships.flatMap((membership) => {
    const company = companiesById.get(membership.company_id)
    if (!company) return []

    return [{
      ...directAccess(membership.company_id, membership.role, membership.status ?? 'active'),
      name: company.name || 'Företag',
      orgNumber: company.org_number,
      entityType: company.entity_type === 'aktiebolag' ? 'aktiebolag' : 'enskild_firma',
      archivedAt: company.archived_at,
    }]
  })
}

/** Resolves effective company access from the database source of truth. */
export async function resolveCompanyAccess(
  supabase: SupabaseClient,
  companyId: string,
): Promise<CompanyAccess | null> {
  const { data, error } = await supabase.rpc('resolve_company_access', {
    p_company_id: companyId,
  })

  if (!error) {
    const row = Array.isArray(data) ? data[0] : null
    return row ? normalizeAccess(row as Record<string, unknown>) : null
  }

  // A rollout gap must not remove all navigation for an authenticated direct
  // member. The fallback is explicitly scoped to auth.uid(), not just RLS,
  // because company-member policies can legitimately expose fellow members.
  logResolverFallback('resolve_company_access', error)
  return resolveDirectMembershipAccess(supabase, companyId)
}

/** Returns direct, agency and platform-accessible companies in one list. */
export async function listAccessibleCompanies(
  supabase: SupabaseClient,
): Promise<AccessibleCompany[]> {
  const { data, error } = await supabase.rpc('list_accessible_companies')

  if (!error) {
    return (Array.isArray(data) ? data : []).map((row) => {
      const value = row as Record<string, unknown>
      return {
        ...normalizeAccess(value),
        name: String(value.company_name ?? 'Företag'),
        orgNumber: typeof value.org_number === 'string' ? value.org_number : null,
        entityType: value.entity_type === 'aktiebolag' ? 'aktiebolag' : 'enskild_firma',
        archivedAt: typeof value.archived_at === 'string' ? value.archived_at : null,
      }
    })
  }

  logResolverFallback('list_accessible_companies', error)
  return listDirectAccessibleCompanies(supabase)
}

export function legacyRoleFromEffectiveRole(role: EffectiveCompanyRole): 'owner' | 'admin' | 'member' | 'viewer' {
  switch (role) {
    case 'platform_admin':
    case 'company_owner':
      return 'owner'
    case 'company_admin':
      return 'admin'
    case 'accountant':
    case 'reviewer':
    case 'client_user':
      return 'member'
    case 'read_only':
    case 'auditor':
      return 'viewer'
  }
}
