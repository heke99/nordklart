import type { SupabaseClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { listAccessibleCompanies, resolveCompanyAccess } from '@/lib/access/company'

const COMPANY_COOKIE = 'nordklart-company-id'

/**
 * Resolves the active accounting company from user_preferences. The preference
 * is valid for direct memberships, agency-client access and platform admins.
 * This keeps app context aligned with the DB resolver/RLS source of truth.
 */
export async function getActiveCompanyId(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data: prefs } = await supabase
    .from('user_preferences')
    .select('active_company_id')
    .eq('user_id', userId)
    .maybeSingle()

  if (prefs?.active_company_id) {
    const access = await resolveCompanyAccess(supabase, prefs.active_company_id)
    if (access?.canRead) return prefs.active_company_id
  }

  const companies = await listAccessibleCompanies(supabase)
  return companies[0]?.companyId ?? null
}

/** Returns all directly, agency and platform-accessible companies. */
export async function getUserCompanies(
  supabase: SupabaseClient,
  _userId: string,
) {
  return listAccessibleCompanies(supabase)
}

/**
 * Sets the active accounting company after resolving effective access. The
 * workspace UI may be agency/platform, but bookkeeping always retains an
 * explicit company context for RLS and immutable accounting operations.
 */
export async function setActiveCompany(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
): Promise<void> {
  const access = await resolveCompanyAccess(supabase, companyId)
  if (!access?.canRead) {
    throw new Error('User is not allowed to access this company')
  }

  const { error } = await supabase
    .from('user_preferences')
    .upsert(
      {
        user_id: userId,
        active_company_id: companyId,
        active_workspace_type: access.accessSource === 'agency' ? 'agency' : 'company',
        active_agency_id: access.agencyId,
      },
      { onConflict: 'user_id' },
    )
  if (error) throw error

  const cookieStore = await cookies()
  cookieStore.set(COMPANY_COOKIE, companyId, {
    path: '/',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365,
  })
}

export async function requireCompanyId(
  supabase: SupabaseClient,
  userId: string,
): Promise<string> {
  const companyId = await getActiveCompanyId(supabase, userId)
  if (!companyId) throw new Error('No company context')
  return companyId
}
