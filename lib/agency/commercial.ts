import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { assertCommercialLimit, COMMERCIAL_LIMITS } from '@/lib/platform/entitlement-limits'

type AgencyMembershipRow = {
  agency_id: string
  role: string
  status?: string | null
  agencies?: {
    id: string
    company_id: string | null
    name: string | null
    status: string | null
  } | null
}

export const AGENCY_ADMIN_ROLES = ['agency_owner', 'agency_admin'] as const
export const AGENCY_WORK_ROLES = ['agency_owner', 'agency_admin', 'accountant', 'reviewer'] as const

export async function resolveManageableAgency(
  supabase: SupabaseClient,
  userId: string,
  requestedAgencyId?: string | null,
): Promise<
  | { ok: true; agencyId: string; agencyCompanyId: string; role: string }
  | { ok: false; response: Response }
> {
  let query = supabase
    .from('agency_members')
    .select('agency_id, role, status, agencies:agency_id(id, company_id, name, status)')
    .eq('user_id', userId)
    .in('role', [...AGENCY_ADMIN_ROLES])
    .eq('status', 'active')

  if (requestedAgencyId) query = query.eq('agency_id', requestedAgencyId)

  const { data, error } = await query.limit(1).maybeSingle()
  if (error) {
    return { ok: false, response: NextResponse.json({ error: 'Byråbehörigheten kunde inte kontrolleras.' }, { status: 500 }) }
  }

  const membership = data as AgencyMembershipRow | null
  const agencyCompanyId = membership?.agencies?.company_id ?? null

  if (!membership || !agencyCompanyId) {
    return { ok: false, response: NextResponse.json({ error: 'Du saknar administrativ behörighet för byrån eller byrån saknar kopplat abonnemangsbolag.' }, { status: 403 }) }
  }

  return {
    ok: true,
    agencyId: membership.agency_id,
    agencyCompanyId,
    role: membership.role,
  }
}

export async function assertAgencyClientCapacity(supabase: SupabaseClient, agencyCompanyId: string) {
  return assertCommercialLimit(
    supabase,
    agencyCompanyId,
    COMMERCIAL_LIMITS.agencyClients,
    'Din byråplan tillåter inte fler kundbolag. Uppgradera abonnemanget för att lägga till fler.',
  )
}

export async function assertAgencyStaffCapacity(supabase: SupabaseClient, agencyCompanyId: string) {
  return assertCommercialLimit(
    supabase,
    agencyCompanyId,
    COMMERCIAL_LIMITS.agencyStaff,
    'Din byråplan tillåter inte fler byråmedarbetare. Uppgradera abonnemanget för att lägga till fler.',
  )
}
