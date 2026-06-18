import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getActiveCompanyId } from '@/lib/company/context'
import { legacyRoleFromEffectiveRole, resolveCompanyAccess } from '@/lib/access/company'
import type { CompanyRole } from '@/types'

type WritePermissionResult =
  | { ok: true }
  | { ok: false; response: NextResponse }

/**
 * Application-layer write guard. Effective access is resolved centrally so
 * direct members, authorized agency staff and platform admins follow the
 * same policy as RLS. Reviewers/read-only users remain non-writing roles.
 */
export async function requireWritePermission(
  supabase: SupabaseClient,
  userId: string,
): Promise<WritePermissionResult> {
  const companyId = await getActiveCompanyId(supabase, userId)
  if (!companyId) {
    return { ok: false, response: NextResponse.json({ error: 'Inget aktivt företag.' }, { status: 403 }) }
  }

  const access = await resolveCompanyAccess(supabase, companyId)
  if (!access?.canWrite) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Du har inte behörighet att ändra i detta företag.' }, { status: 403 }),
    }
  }

  return { ok: true }
}

export type CompanyRoleResult =
  | { ok: true; role: CompanyRole; companyId: string }
  | { ok: false; response: NextResponse }

/** Returns the existing legacy role shape for route compatibility. */
export async function getCompanyRole(
  supabase: SupabaseClient,
  userId: string,
): Promise<CompanyRoleResult> {
  const companyId = await getActiveCompanyId(supabase, userId)
  if (!companyId) {
    return { ok: false, response: NextResponse.json({ error: 'Inget aktivt företag.' }, { status: 403 }) }
  }

  const access = await resolveCompanyAccess(supabase, companyId)
  if (!access) {
    return { ok: false, response: NextResponse.json({ error: 'Du har ingen roll i detta företag.' }, { status: 403 }) }
  }

  return { ok: true, role: legacyRoleFromEffectiveRole(access.effectiveRole), companyId }
}
