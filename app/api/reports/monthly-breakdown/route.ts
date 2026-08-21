import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { NextResponse } from 'next/server'
import { generateMonthlyBreakdown } from '@/lib/reports/monthly-breakdown'

export const GET = withRouteContext('reports.monthly_breakdown', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx
  const { searchParams } = new URL(request.url)
  const periodId = searchParams.get('period_id')

  if (!periodId) {
    return errorResponseFromCode('REPORT_PERIOD_REQUIRED', log, { requestId })
  }

  try {
    const data = await generateMonthlyBreakdown(supabase, companyId, periodId)
    return NextResponse.json({ data })
  } catch {
    return errorResponseFromCode('REPORT_GENERATION_FAILED', log, { requestId })
  }
})
