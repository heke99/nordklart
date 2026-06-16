import { type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

export async function middleware(request: NextRequest) {
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
    '/((?!_next/static|_next/image|favicon.ico|api|\\.well-known|sw\\.js|sw-register\\.js|manifest\\.json|icons/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|js|json)$).*)',
  ],
}
