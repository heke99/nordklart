'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { resolveCompanyAccess } from '@/lib/access/company'

export type WorkspaceContextType = 'company' | 'agency' | 'platform'

type SwitchWorkspaceResult = { ok: true } | { ok: false; error: string }

export async function switchWorkspaceContext(
  workspaceType: WorkspaceContextType,
  agencyId?: string | null,
): Promise<SwitchWorkspaceResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Du måste vara inloggad.' }

  const { data: prefs } = await supabase
    .from('user_preferences')
    .select('active_company_id')
    .eq('user_id', user.id)
    .maybeSingle()

  const activeCompanyId = prefs?.active_company_id ?? null

  if (workspaceType === 'platform') {
    const { data: platformRole } = await supabase
      .from('platform_roles')
      .select('role')
      .eq('user_id', user.id)
      .eq('role', 'platform_admin')
      .is('revoked_at', null)
      .maybeSingle()

    if (!platformRole) return { ok: false, error: 'Du saknar platform-behörighet.' }
  }

  let resolvedAgencyId: string | null = null
  if (workspaceType === 'agency') {
    let query = supabase
      .from('agency_members')
      .select('agency_id, role, status')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .in('role', ['agency_owner', 'agency_admin', 'accountant', 'reviewer', 'read_only'])

    if (agencyId) query = query.eq('agency_id', agencyId)

    const { data: agencyMember } = await query.limit(1).maybeSingle()
    if (!agencyMember?.agency_id) return { ok: false, error: 'Du saknar byråbehörighet.' }
    resolvedAgencyId = agencyMember.agency_id
  }

  if (workspaceType === 'company' && activeCompanyId) {
    const access = await resolveCompanyAccess(supabase, activeCompanyId)
    if (!access?.canRead) return { ok: false, error: 'Du saknar bolagsbehörighet.' }
  }

  const { error } = await supabase.from('user_preferences').upsert({
    user_id: user.id,
    active_company_id: activeCompanyId,
    active_workspace_type: workspaceType,
    active_agency_id: resolvedAgencyId,
  }, { onConflict: 'user_id' })

  if (error) return { ok: false, error: 'Kunde inte byta arbetsyta just nu.' }

  revalidatePath('/app', 'layout')
  revalidatePath('/agency', 'layout')
  revalidatePath('/platform', 'layout')
  return { ok: true }
}
