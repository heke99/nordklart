import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { revokeConsent } from '@/lib/auth/consent-service'

ensureInitialized()

/**
 * POST /api/bankid/consents/[id]/revoke
 *
 * Revoke an active consent. The consent row is immutable evidence — the
 * revocation is a status flip (audited), never a delete.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bankid.consents.revoke',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    try {
      await revokeConsent(supabase, {
        consentId: id,
        companyId: companyId!,
        userId: user.id,
      })
      return NextResponse.json({ data: { id, status: 'revoked' } })
    } catch (err) {
      log.error('consent revoke failed', err as Error, { consentId: id })
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
