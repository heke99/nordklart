import { type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

// Next.js 16: `proxy.ts` replaces the deprecated `middleware.ts` (T05).
// Same behavior, Node runtime; the session/company-context logic lives in
// lib/supabase/middleware.ts unchanged.
export async function proxy(request: NextRequest) {
  return await updateSession(request)
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - api (API routes - they handle their own auth)
     * - Static assets (images, scripts, manifest, icons, etc.)
     */
    '/((?!_next/static|_next/image|favicon.ico|api|\\.well-known|sw\\.js|sw-register\\.js|manifest\\.(?:json|webmanifest)|icons/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|js|json)$).*)',
  ],
}
