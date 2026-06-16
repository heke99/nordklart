import type { SupabaseClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'

const COMPANY_COOKIE = 'nordklart-company-id'

/**
 * Get the active company ID for the authenticated user.
 *
 * Resolution order: user_preferences → first non-archived membership.
 *
 * `user_preferences.active_company_id` is the authoritative source. The
 * cookie `nordklart-company-id` is written as a hint for backwards-compat but
 * is no longer READ as a source of truth, because Postgres RLS (via
 * `current_active_company_id()`) can only read the database, not cookies.
 * Having Next.js and RLS both read from `user_preferences` keeps them
 * perfectly in sync.
 *
 * Returns null if the user has no non-archived companies.
 */
export async function getActiveCompanyId(
  supabase: SupabaseClient,
  userId: string
): Promise<string | null> {
  // 1. user_preferences — authoritative
  const { data: prefs } = await supabase
    .from('user_preferences')
    .select('active_company_id')
    .eq('user_id', userId)
    .maybeSingle()

  if (prefs?.active_company_id) {
    // Validate the preference still points to a non-archived company the
    // user is a member of.
    const { data: membership } = await supabase
      .from('company_members')
      .select('company_id, companies!inner(archived_at)')
      .eq('company_id', prefs.active_company_id)
      .eq('user_id', userId)
      .is('companies.archived_at', null)
      .maybeSingle()

    if (membership) return membership.company_id
  }

  // 2. Fallback: first non-archived membership by created_at
  const { data: firstCompany } = await supabase
    .from('company_members')
    .select('company_id, companies!inner(archived_at)')
    .eq('user_id', userId)
    .is('companies.archived_at', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  return firstCompany?.company_id ?? null
}

/**
 * Get all companies the user is a member of, with their roles.
 */
export async function getUserCompanies(
  supabase: SupabaseClient,
  userId: string
) {
  const { data, error } = await supabase
    .from('company_members')
    .select(`
      company_id,
      role,
      joined_at,
      companies:company_id (
        id,
        name,
        org_number,
        entity_type,
        archived_at,
        created_at
      )
    `)
    .eq('user_id', userId)
    .order('joined_at', { ascending: true })

  if (error) throw error
  return data ?? []
}

/**
 * Set the active company for the user.
 *
 * Writes to `user_preferences` (authoritative, consulted by RLS via
 * `current_active_company_id()`) and refreshes the `nordklart-company-id`
 * cookie for backwards-compat with any code still reading it.
 */
export async function setActiveCompany(
  supabase: SupabaseClient,
  userId: string,
  companyId: string
): Promise<void> {
  // Validate membership
  const { data: membership } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .single()

  if (!membership) {
    throw new Error('User is not a member of this company')
  }

  // Update user_preferences — this is the authoritative value RLS reads
  await supabase
    .from('user_preferences')
    .upsert(
      { user_id: userId, active_company_id: companyId },
      { onConflict: 'user_id' }
    )

  // Refresh the cookie as a compat hint
  const cookieStore = await cookies()
  cookieStore.set(COMPANY_COOKIE, companyId, {
    path: '/',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365, // 1 year
  })
}

/**
 * Get the active company ID for API routes.
 * Throws if no company context can be resolved.
 */
export async function requireCompanyId(
  supabase: SupabaseClient,
  userId: string
): Promise<string> {
  const companyId = await getActiveCompanyId(supabase, userId)
  if (!companyId) {
    throw new Error('No company context')
  }
  return companyId
}
