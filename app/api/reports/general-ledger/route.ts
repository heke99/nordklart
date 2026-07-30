import { NextResponse } from 'next/server'
import { generateGeneralLedger } from '@/lib/reports/general-ledger'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import {
  requireYearEndReportAccess,
  yearEndAccessDeniedResponse,
} from '@/lib/year-end/access'

export const GET = withRouteContext(
  'report.general_ledger',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx

    const { searchParams } = new URL(request.url)
    const periodId = searchParams.get('period_id')
    const accountFrom = searchParams.get('account_from') || undefined
    const accountTo = searchParams.get('account_to') || undefined

    if (!periodId) {
      return errorResponseFromCode('REPORT_PERIOD_REQUIRED', log, { requestId })
    }
    const access = await requireYearEndReportAccess(
      supabase,
      companyId,
      user.id,
      periodId,
      { operation: 'report.general_ledger', requestId },
    )
    if (!access.allowed) {
      return yearEndAccessDeniedResponse('reports.core', access.reason)
    }

    try {
      const data = await generateGeneralLedger(supabase, companyId!, periodId, accountFrom, accountTo)
      return NextResponse.json({ data })
    } catch (err) {
      log.error('general ledger generation failed', err as Error, { periodId })
      return errorResponseFromCode('REPORT_GENERATION_FAILED', log, {
        requestId,
        details: { reason: err instanceof Error ? err.message : 'unknown' },
      })
    }
  },
)
