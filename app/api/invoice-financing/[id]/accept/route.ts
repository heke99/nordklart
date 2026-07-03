import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { acceptFinancingOffer } from '@/lib/invoice-financing/service'

ensureInitialized()

/**
 * POST /api/invoice-financing/[id]/accept — dashboard: accept the open
 * offer on a financing application (payout + booking + settlement).
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice_financing.accept',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    try {
      const outcome = await acceptFinancingOffer(supabase, {
        companyId: companyId!,
        userId: user.id,
        applicationId: id,
      })

      if (!outcome.ok) {
        const status = outcome.code === 'NOT_FOUND' ? 404 : 409
        return NextResponse.json({ error: outcome.message_sv, code: outcome.code }, { status })
      }

      return NextResponse.json({
        data: {
          application: outcome.application,
          journal_entry_id: outcome.journalEntryId,
          message_sv: outcome.message_sv,
        },
      })
    } catch (err) {
      log.error('financing accept failed', err as Error, { applicationId: id })
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
