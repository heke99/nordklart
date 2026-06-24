import 'server-only'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

export type PlatformRole = 'platform_admin' | 'platform_support' | 'platform_auditor'

export const PLATFORM_ROLES: readonly PlatformRole[] = ['platform_admin', 'platform_support', 'platform_auditor'] as const

export const PLATFORM_ROLE_LABELS: Record<PlatformRole, string> = {
  platform_admin: 'Superadmin',
  platform_support: 'Plattform support',
  platform_auditor: 'Plattform granskare',
}

type RequirePlatformRoleOptions = {
  roles?: readonly PlatformRole[]
  redirectTo?: string
}

/** Use in server pages/actions that need a global Nordklart platform role. */
export async function requirePlatformRole(options: RequirePlatformRoleOptions = {}) {
  const allowedRoles = options.roles ?? PLATFORM_ROLES
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data, error } = await supabase
    .from('platform_roles')
    .select('role')
    .eq('user_id', user.id)
    .in('role', [...allowedRoles])
    .is('revoked_at', null)
    .order('granted_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error || !data) redirect(options.redirectTo ?? '/app')
  return { supabase, user, role: data.role as PlatformRole }
}

/** Use in server pages/actions that administer global Nordklart data. */
export async function requirePlatformAdmin() {
  return requirePlatformRole({ roles: ['platform_admin'] })
}

export function canWritePlatform(role: PlatformRole | null | undefined) {
  return role === 'platform_admin'
}
