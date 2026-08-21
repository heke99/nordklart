import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { NextResponse } from 'next/server'
import { generateJournalRegister } from '@/lib/reports/journal-register'

export const GET = withRouteContext('reports.journal_register', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx
  const { searchParams } = new URL(request.url)
  const periodId = searchParams.get('period_id')

  if (!periodId) {
    return errorResponseFromCode('REPORT_PERIOD_REQUIRED', log, { requestId })
  }

  const data = await generateJournalRegister(supabase, companyId, periodId)

  return NextResponse.json({ data })
})
