import { NextResponse } from 'next/server'
import { isBolagsverketRegistryAvailable } from '@/lib/company-registry/provider'
import { requireAuth } from '@/lib/auth/require-auth'
import { verifyCronSecret } from '@/lib/auth/cron'

/**
 * GET /api/company-registry/bolagsverket/health
 *
 * Operator probe: it calls Bolagsverket and reports configuration details, so
 * it is limited to the cron secret (monitoring) or a platform admin session.
 * Anonymous callers used to be able to trigger an upstream call per request.
 */
export async function GET(request: Request) {
  const cronDenied = verifyCronSecret(request)
  if (cronDenied) {
    const auth = await requireAuth()
    if (auth.error) return auth.error
    const { data: role } = await auth.supabase
      .from('platform_roles')
      .select('role')
      .eq('user_id', auth.user.id)
      .eq('role', 'platform_admin')
      .is('revoked_at', null)
      .limit(1)
      .maybeSingle()
    if (!role) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const result = await isBolagsverketRegistryAvailable()
  return NextResponse.json({
    available: result.available,
    configured: result.configured,
    environment: result.environment,
    reason: 'reason' in result ? result.reason : undefined,
    status: 'status' in result ? result.status : undefined,
    requestId: 'requestId' in result ? result.requestId : undefined,
  }, {
    status: result.available ? 200 : 503,
    headers: { 'Cache-Control': 'private, no-store' },
  })
}
