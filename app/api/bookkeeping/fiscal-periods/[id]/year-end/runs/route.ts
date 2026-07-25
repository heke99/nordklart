import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { requireYearEndAccess, yearEndAccessDeniedResponse } from '@/lib/year-end/access'
import { createServiceClient } from '@/lib/supabase/server'

/**
 * GET: list year-end runs for a fiscal period (revision item B10).
 *
 * The bokslut state machine is persisted in year_end_runs: the atomic close
 * RPC only ever commits runs in status 'closed'; the API layer records
 * 'failed' attempts. This endpoint lets the wizard show failed runs with
 * their error messages and offer a controlled retry — a period can never
 * silently disappear in a half-closed state (the close is atomic).
 */
export const GET = withRouteContext(
  'period.year_end_runs',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { user, companyId, log, requestId } = ctx
    const { id } = await params
    const opLog = log.child({ periodId: id })

    const serviceDb = createServiceClient()
    const access = await requireYearEndAccess(serviceDb, companyId, user.id, id, {
      operation: 'period.year_end_runs',
      requestId,
    })
    if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)

    const { data, error } = await serviceDb
      .from('year_end_runs')
      .select(
        'id, status, current_step, error_code, error_message, user_message, correlation_id, retry_count, retryable, idempotency_key, closing_entry_id, opening_balance_entry_id, revaluation_entry_id, revaluation_reversal_entry_id, next_period_id, started_at, finished_at, created_at',
      )
      .eq('company_id', companyId!)
      .eq('fiscal_period_id', id)
      .order('created_at', { ascending: false })
      .limit(50)

    if (error) {
      opLog.error('year-end runs fetch failed', new Error(error.message))
      return errorResponseFromCode('INTERNAL_ERROR', opLog, { requestId })
    }

    return NextResponse.json({ data: data ?? [] })
  },
  { allowRequestedCompany: true },
)
