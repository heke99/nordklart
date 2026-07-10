import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { cancelConsentSession } from '@/lib/auth/consent-service'

ensureInitialized()

/**
 * POST /api/bankid/consents/[id]/cancel
 *
 * Cancel a PENDING BankID consent-signing session (the user closed the
 * dialog or changed their mind). Cancels the provider order and flips the
 * session status — completed sessions cannot be cancelled (use revoke on the
 * signed consent instead). Idempotent for already-cancelled sessions.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bankid.consents.cancel',
  async (_request, ctx, { params }) => {
    const { id: sessionId } = await params
    const { user, supabase, log, requestId } = ctx

    try {
      const result = await cancelConsentSession(supabase, {
        sessionId,
        userId: user.id,
      })
      return NextResponse.json({ data: result })
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      // Business outcomes get precise statuses instead of a generic 500.
      if (message.includes('slutförd') || message.includes('slutföras')) {
        return NextResponse.json({ error: message, type: 'conflict' }, { status: 409 })
      }
      if (message.includes('kunde inte hittas')) {
        return NextResponse.json({ error: message, type: 'not_found' }, { status: 404 })
      }
      log.error('consent cancel failed', err as Error, { sessionId })
      return errorResponse(err, log, { requestId })
    }
  },
)
