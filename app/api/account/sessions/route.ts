import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { createServiceClient } from '@/lib/supabase/server'
import { checkDurableRateLimit } from '@/lib/auth/rate-limit-durable'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createLogger } from '@/lib/logger'

const log = createLogger('api/account/sessions')

/**
 * DELETE /api/account/sessions
 * "Sign out everywhere else": ends every Supabase session of the caller
 * except the current one. requireAuth, not withRouteContext: sessions belong
 * to the person, and a user without a company must be able to do this too.
 */
export async function DELETE() {
  const auth = await requireAuth()
  if (auth.error) return auth.error
  const { supabase, user } = auth

  const limit = await checkDurableRateLimit({
    prefix: 'account:revoke-sessions',
    identifier: user.id,
    maxRequests: 10,
    windowMs: 15 * 60 * 1000,
  })
  if (!limit.ok) return limit.response!

  const { data: claims } = await supabase.auth.getClaims().catch(() => ({ data: null }))
  const sessionId = typeof claims?.claims?.session_id === 'string' ? claims.claims.session_id : null
  if (!sessionId) {
    // Without the current session id we would sign the caller out too.
    return errorResponseFromCode('INTERNAL_ERROR', log, { messageSv: 'Kunde inte avgöra den aktuella sessionen.', status: 500 })
  }

  const service = createServiceClient()
  const { data: revoked, error } = await service.rpc('revoke_user_sessions', {
    p_user_id: user.id,
    p_keep_session_id: sessionId,
  })
  if (error) {
    return errorResponseFromCode('INTERNAL_ERROR', log, { messageSv: 'Kunde inte logga ut andra enheter.', status: 500 })
  }

  await service.from('auth_audit_events').insert({
    user_id: user.id,
    email: user.email ?? null,
    event_type: 'sessions_revoked',
    status: 'success',
    metadata: { revoked_sessions: revoked ?? 0 },
  }).then(() => undefined, () => undefined)

  return NextResponse.json({ data: { revoked: revoked ?? 0 } })
}
