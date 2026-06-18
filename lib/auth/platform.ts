import 'server-only'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

/** Use in server pages/actions that administer global Nordklart data. */
export async function requirePlatformAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data, error } = await supabase
    .from('platform_roles')
    .select('role')
    .eq('user_id', user.id)
    .eq('role', 'platform_admin')
    .is('revoked_at', null)
    .maybeSingle()

  if (error || !data) redirect('/app')
  return { supabase, user }
}
