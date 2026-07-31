import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { requireYearEndAccess, yearEndAccessDeniedResponse } from '@/lib/year-end/access'
import { createServiceClient } from '@/lib/supabase/server'
import { mapYearEndDatabaseError } from '@/lib/year-end/execution-error'

const BodySchema = z.object({
  statement_version: z.literal('ib-ub-review-v1'),
  statement_text: z.string().min(20).max(1000),
  continuity_snapshot: z.record(z.string(), z.unknown()),
})

export const POST = withRouteContext(
  'period.year_end_acknowledge',
  async (
    request,
    ctx,
    { params }: { params: Promise<{ id: string; runId: string }> },
  ) => {
    const { id, runId } = await params
    const { user, companyId, log, requestId } = ctx
    const validation = await validateBody(request, BodySchema)
    if (!validation.success) return validation.response

    try {
      const serviceDb = createServiceClient()
      const access = await requireYearEndAccess(serviceDb, companyId, user.id, id, {
        operation: 'period.year_end_acknowledge',
        requestId,
        requireWrite: true,
      })
      if (!access.allowed) {
        return yearEndAccessDeniedResponse('year_end.projects', access.reason)
      }

      const { data, error } = await serviceDb.rpc('acknowledge_year_end_run', {
        p_company_id: companyId,
        p_fiscal_period_id: id,
        p_year_end_run_id: runId,
        p_user_id: user.id,
        p_statement_version: validation.data.statement_version,
        p_statement_text: validation.data.statement_text,
        p_continuity_snapshot: validation.data.continuity_snapshot,
      })
      if (error) throw mapYearEndDatabaseError(error, requestId)
      return NextResponse.json({
        data: {
          acknowledgement_id: data,
          acknowledged_at: new Date().toISOString(),
          acknowledged_by: user.id,
          acknowledgement_version: validation.data.statement_version,
        },
      })
    } catch (error) {
      const mapped = mapYearEndDatabaseError(error, requestId)
      if (mapped.code === 'YE_RUN_NOT_COMMITTED') {
        return errorResponseFromCode(mapped.code, log, {
          requestId: mapped.correlationId,
          messageSv: mapped.userMessage,
        })
      }
      return errorResponse(error, log, { requestId })
    }
  },
  { allowRequestedCompany: true, requireWrite: true },
)
