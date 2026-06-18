import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

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

/** Resolves the effective company access from one database source of truth. */
export async function resolveCompanyAccess(
  supabase: SupabaseClient,
  companyId: string,
): Promise<CompanyAccess | null> {
  const { data, error } = await supabase.rpc('resolve_company_access', {
    p_company_id: companyId,
  })

  if (error) throw error
  const row = Array.isArray(data) ? data[0] : null
  return row ? normalizeAccess(row as Record<string, unknown>) : null
}

/** Returns direct, agency and platform-accessible companies in one list. */
export async function listAccessibleCompanies(
  supabase: SupabaseClient,
): Promise<AccessibleCompany[]> {
  const { data, error } = await supabase.rpc('list_accessible_companies')
  if (error) throw error

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
