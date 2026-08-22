import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { NextResponse } from 'next/server'
import { validateBalanceContinuity } from '@/lib/reports/continuity-check'

/**
 * GET: Validate IB/UB continuity for a fiscal period.
 * Query param: period_id (required)
 */
export const GET = withRouteContext('reports.continuity_check', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx
  const { searchParams } = new URL(request.url)
  const periodId = searchParams.get('period_id')

  if (!periodId) {
    return errorResponseFromCode('REPORT_PERIOD_REQUIRED', log, { requestId })
  }

  try {
    const result = await validateBalanceContinuity(supabase, companyId, periodId)
    return NextResponse.json({ data: result })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to validate continuity' },
      { status: 400 }
    )
  }
})
