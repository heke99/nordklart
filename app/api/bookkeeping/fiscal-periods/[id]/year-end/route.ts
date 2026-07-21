import { NextResponse } from 'next/server'
import {
  validateYearEndReadiness,
  previewYearEndClosing,
  executeYearEndClosing,
} from '@/lib/core/bookkeeping/year-end-service'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { requireYearEndAccess, yearEndAccessDeniedResponse } from '@/lib/year-end/access'
import { createServiceClient } from '@/lib/supabase/server'

/** GET: validate readiness + preview the year-end entries. */
export const GET = withRouteContext(
  'period.year_end_preview',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, companyId, log, requestId } = ctx
    const opLog = log.child({ periodId: id })

    try {
      const serviceDb = createServiceClient()
      const access = await requireYearEndAccess(serviceDb, companyId, user.id, id, {
        operation: 'period.year_end_preview',
        requestId,
      })
      if (!access.allowed) return yearEndAccessDeniedResponse()

      const [validation, preview] = await Promise.all([
        validateYearEndReadiness(serviceDb, companyId, user.id, id),
        previewYearEndClosing(serviceDb, companyId, user.id, id),
      ])
      return NextResponse.json({ data: { validation, preview } })
    } catch (err) {
      opLog.error('year-end preview failed', err as Error)
      const message = err instanceof Error ? err.message : ''
      if (/not found/i.test(message)) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', opLog, { requestId })
      }
      return errorResponseFromCode('YEAR_END_PREVIEW_FAILED', opLog, { requestId })
    }
  },
  { allowRequestedCompany: true },
)

/** POST: actually run year-end closing (atomic, idempotent — B01/B09). */
export const POST = withRouteContext(
  'period.year_end',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, companyId, log, requestId } = ctx
    const opLog = log.child({ periodId: id })

    try {
      const serviceDb = createServiceClient()
      const access = await requireYearEndAccess(serviceDb, companyId, user.id, id, {
        operation: 'period.year_end',
        requestId,
        requireWrite: true,
      })
      if (!access.allowed) return yearEndAccessDeniedResponse()

      // Client-supplied idempotency key (optional). The default is
      // deterministic per period so a retried POST replays the completed
      // close instead of erroring or duplicating (B09).
      const idempotencyKey =
        request.headers.get('idempotency-key')?.slice(0, 128) ?? undefined

      const result = await executeYearEndClosing(serviceDb, companyId, user.id, id, {
        idempotencyKey,
      })
      return NextResponse.json({ data: result })
    } catch (err) {
      opLog.error('year-end execution failed', err as Error)
      const message = err instanceof Error ? err.message : ''
      // The downstream errors below are matched on stable English keywords
      // emitted by year-end-service. Do NOT include the raw message in
      // details — it may contain DB-sourced names; UI surfacing relies on
      // the structured message_sv / message_en pair.
      if (/Next fiscal period already has opening balance/i.test(message)) {
        return errorResponseFromCode('YEAR_END_NEXT_PERIOD_HAS_IB', opLog, { requestId })
      }
      if (/prior.*open/i.test(message)) {
        return errorResponseFromCode('YEAR_END_PRIOR_PERIOD_OPEN', opLog, { requestId })
      }
      if (/not balanced|unbalanced/i.test(message)) {
        return errorResponseFromCode('YEAR_END_UNBALANCED_TRIAL', opLog, { requestId })
      }
      if (/not found/i.test(message)) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', opLog, { requestId })
      }
      // Fall through bookkeeping/Zod/etc to errorResponse, but cap to YEAR_END_FAILED.
      const fallback = errorResponse(err, opLog, { requestId })
      if (fallback.status === 500) {
        return errorResponseFromCode('YEAR_END_FAILED', opLog, { requestId })
      }
      return fallback
    }
  },
  { allowRequestedCompany: true },
)
