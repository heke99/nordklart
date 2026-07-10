import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { pollConsentSession } from '@/lib/auth/consent-service'

ensureInitialized()

/**
 * POST /api/bankid/consents/[id]/poll
 *
 * Poll a running BankID consent-signing session (call every ~2s). On
 * completion the signed_consents row is created and its id returned.
 * Idempotent — polling a completed session returns the existing consent.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bankid.consents.poll',
  async (_request, ctx, { params }) => {
    const { id: sessionId } = await params
    const { user, supabase, log, requestId } = ctx

    try {
      const result = await pollConsentSession(supabase, {
        sessionId,
        userId: user.id,
      })
      return NextResponse.json({ data: result })
    } catch (err) {
      log.error('consent poll failed', err as Error, { sessionId })
      return errorResponse(err, log, { requestId })
    }
  },
)
