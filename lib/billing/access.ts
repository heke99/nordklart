import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

/** Billing changes are restricted to the company owner/admin or a global superadmin. */
export async function canManageCompanyBilling(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
) {
  const [{ data: membership }, { data: platformRole }] = await Promise.all([
    supabase
      .from('company_members')
      .select('role')
      .eq('company_id', companyId)
      .eq('user_id', userId)
      .in('role', ['owner', 'admin'])
      .eq('status', 'active')
      .maybeSingle(),
    supabase
      .from('platform_roles')
      .select('role')
      .eq('user_id', userId)
      .eq('role', 'platform_admin')
      .is('revoked_at', null)
      .maybeSingle(),
  ])

  return Boolean(membership || platformRole)
}
