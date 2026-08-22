import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { NextResponse } from 'next/server'
import { generateResultatrapport } from '@/lib/reports/resultatrapport'
import { parseReportDateRange } from '@/lib/reports/date-range'

export const GET = withRouteContext('reports.resultatrapport', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx
  const { searchParams } = new URL(request.url)
  const periodId = searchParams.get('period_id')

  if (!periodId) {
    return errorResponseFromCode('REPORT_PERIOD_REQUIRED', log, { requestId })
  }

  const { data: period } = await supabase
    .from('fiscal_periods')
    .select('period_start, period_end')
    .eq('id', periodId)
    .eq('company_id', companyId)
    .single()

  let range: { fromDate?: string; toDate?: string } = {}
  if (period) {
    const parsed = parseReportDateRange(searchParams, period)
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 })
    }
    range = parsed.range
  }

  try {
    const result = await generateResultatrapport(supabase, companyId, periodId, range)
    return NextResponse.json({ data: result })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to generate resultatrapport' },
      { status: 500 }
    )
  }
})
