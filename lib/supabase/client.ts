import { createBrowserClient } from '@supabase/ssr'
import { supabaseCookieOptions } from '@/lib/auth/session-policy'

// During Docker builds, NEXT_PUBLIC_* vars are placeholder sentinels
// (e.g. __NEXT_PUBLIC_SUPABASE_URL__) that get replaced at runtime by
// docker-entrypoint.sh. Provide a dummy URL so the client constructor
// doesn't throw during Next.js static page generation.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
const isBuildPlaceholder = !url || url.startsWith('__')

export function createClient() {
  const secure = typeof window !== 'undefined' && window.location.protocol === 'https:'
  return createBrowserClient(
    isBuildPlaceholder ? 'https://placeholder.supabase.co' : url,
    isBuildPlaceholder ? 'placeholder' : key,
    { cookieOptions: supabaseCookieOptions(secure) },
  )
}
