import { isIP } from 'node:net'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/require-auth'
import { createServiceClient } from '@/lib/supabase/server'
import { checkDurableRateLimit } from '@/lib/auth/rate-limit-durable'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { LEGAL_ACK_COOKIE } from '@/lib/legal/acceptance-gate'
import { createLogger } from '@/lib/logger'

const log = createLogger('api/legal/accept')

const AcceptSchema = z.object({
  versionIds: z.array(z.string().uuid()).min(1).max(10),
})

function requestIp(request: Request): string | null {
  const raw = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')?.trim()
    || ''
  return isIP(raw) ? raw : null
}

/**
 * POST /api/legal/accept
 *
 * Records that the signed-in user accepts the legal text versions shown on
 * the acceptance page (/villkor/godkann). requireAuth, not withRouteContext:
 * the terms bind the person, and a user without a company must be able to
 * accept too. The insert runs with the service role because acceptances are
 * evidence: users cannot write them, and the IP address and user agent come
 * from the request, not from the client.
 */
export async function POST(request: Request) {
  const auth = await requireAuth()
  if (auth.error) return auth.error
  const { user } = auth

  const limit = await checkDurableRateLimit({
    prefix: 'legal:accept',
    identifier: user.id,
    maxRequests: 20,
    windowMs: 15 * 60 * 1000,
  })
  if (!limit.ok) return limit.response!

  const parsed = await validateBody(request, AcceptSchema)
  if (!parsed.success) return parsed.response

  const service = createServiceClient()
  const { data, error } = await service.rpc('accept_legal_documents', {
    p_user_id: user.id,
    p_version_ids: parsed.data.versionIds,
    p_source: 'reacceptance',
    p_ip_address: requestIp(request),
    p_user_agent: request.headers.get('user-agent'),
  })
  if (error) {
    return errorResponseFromCode('INTERNAL_ERROR', log, { messageSv: 'Kunde inte spara ditt godkännande. Försök igen.', status: 500 })
  }

  const result = (data ?? {}) as { ok?: boolean; error?: string; pending?: number }
  if (!result.ok) {
    // A version changed after the page was rendered, or not every required
    // document was accepted: the page reloads and shows what is left.
    return errorResponseFromCode('CONFLICT', log, {
      messageSv: 'Villkoren har uppdaterats. Läs igenom och godkänn den senaste versionen.',
      status: 409,
      reason: result.error ?? 'documents_pending',
    })
  }

  const response = NextResponse.json({ data: { accepted: true } })
  // Drop any cached verdict so the middleware re-checks on the next page.
  response.cookies.set(LEGAL_ACK_COOKIE, '', { path: '/', maxAge: 0 })
  return response
}
