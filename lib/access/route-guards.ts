import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveCompanyAccess, type CompanyAccess } from './company'

/**
 * Route-level defense-in-depth guards.
 *
 * Historically many API routes re-checked tenancy with a direct
 * `company_members` lookup. That check is stricter than RLS: authorized
 * agency staff (via `agency_clients` + `agency_members`) and platform
 * admins have no `company_members` row and were wrongly rejected with
 * 403/404 even though every underlying query succeeds under RLS.
 *
 * These helpers resolve effective access through the same source of truth
 * as RLS (`resolve_company_access`), so app-layer guards and database
 * policy can no longer diverge.
 */

/** Returns access when the current user can read the company, else null. */
export async function getCompanyReadAccess(
  supabase: SupabaseClient,
  companyId: string,
): Promise<CompanyAccess | null> {
  const access = await resolveCompanyAccess(supabase, companyId)
  return access?.canRead ? access : null
}

/** Returns access when the current user can write in the company, else null. */
export async function getCompanyWriteAccess(
  supabase: SupabaseClient,
  companyId: string,
): Promise<CompanyAccess | null> {
  const access = await resolveCompanyAccess(supabase, companyId)
  return access?.canWrite ? access : null
}
