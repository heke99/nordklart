import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { buildBokslutReadinessReport } from '@/lib/bokslut/readiness-aggregator'
import { requireYearEndAccess, yearEndAccessDeniedResponse } from '@/lib/year-end/access'
import { createServiceClient } from '@/lib/supabase/server'

/**
 * GET: aggregated bokslut readiness report — combines validateYearEndReadiness
 * (legal blockers) with bank-reconciliation status and informational reminders
 * for the bokslutsdispositioner that are still booked manually until Phase 2+
 * ships their calculators. One fetch backs the wizard's preflight step.
 */
export const GET = withRouteContext(
  'period.bokslut_readiness',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, companyId, log, requestId } = ctx
    const opLog = log.child({ periodId: id })

    try {
      const serviceDb = createServiceClient()
      const access = await requireYearEndAccess(serviceDb, companyId, user.id, id, {
        operation: 'period.bokslut_readiness',
        requestId,
      })
      if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)

      const report = await buildBokslutReadinessReport(serviceDb, companyId, user.id, id)
      return NextResponse.json({ data: report })
    } catch (err) {
      opLog.error('bokslut readiness aggregation failed', err as Error)
      const message = err instanceof Error ? err.message : ''
      if (/not found/i.test(message)) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', opLog, { requestId })
      }
      return errorResponseFromCode('YEAR_END_PREVIEW_FAILED', opLog, {
        requestId,
        details: { reason: message },
      })
    }
  },
  { allowRequestedCompany: true },
)
