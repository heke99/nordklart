import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { cancelFinancingApplication } from '@/lib/invoice-financing/service'

ensureInitialized()

/**
 * POST /api/invoice-financing/[id]/cancel — dashboard: cancel a financing
 * application that has not yet been accepted.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice_financing.cancel',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    try {
      const outcome = await cancelFinancingApplication(supabase, {
        companyId: companyId!,
        userId: user.id,
        applicationId: id,
      })

      if (!outcome.ok) {
        const status = outcome.code === 'NOT_FOUND' ? 404 : 409
        return NextResponse.json({ error: outcome.message_sv, code: outcome.code }, { status })
      }

      return NextResponse.json({
        data: { application: outcome.application, message_sv: outcome.message_sv },
      })
    } catch (err) {
      log.error('financing cancel failed', err as Error, { applicationId: id })
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
