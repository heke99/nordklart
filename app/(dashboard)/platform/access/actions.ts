'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requirePlatformAdmin } from '@/lib/auth/platform'

const PATH = '/platform/access'

function fail(message: string): never { redirect(`${PATH}?error=${encodeURIComponent(message)}`) }
function value(formData: FormData, key: string, required = false) {
  const raw = String(formData.get(key) ?? '').trim()
  if (required && !raw) fail('Ett obligatoriskt fält saknas.')
  return raw || null
}

export async function setPlatformRoleAction(formData: FormData) {
  const { supabase } = await requirePlatformAdmin()
  const userId = value(formData, 'user_id', true)!
  const role = value(formData, 'role', true)!
  const note = value(formData, 'note')
  const { error } = await supabase.rpc('platform_set_user_role', {
    p_user_id: userId,
    p_role: role,
    p_note: note,
  })
  if (error) fail(error.message || 'Plattformsrollen kunde inte sparas.')
  revalidatePath(PATH)
  redirect(`${PATH}?notice=${encodeURIComponent('Plattformsrollen är uppdaterad och audit-loggad.')}`)
}

export async function revokePlatformRoleAction(formData: FormData) {
  const { supabase } = await requirePlatformAdmin()
  const userId = value(formData, 'user_id', true)!
  const note = value(formData, 'note', true)!
  const { error } = await supabase.rpc('platform_revoke_user_role', {
    p_user_id: userId,
    p_note: note,
  })
  if (error) fail(error.message || 'Plattformsrollen kunde inte återkallas.')
  revalidatePath(PATH)
  redirect(`${PATH}?notice=${encodeURIComponent('Plattformsrollen är återkallad och audit-loggad.')}`)
}
