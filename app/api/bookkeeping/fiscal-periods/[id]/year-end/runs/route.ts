import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { requireYearEndAccess, yearEndAccessDeniedResponse } from '@/lib/year-end/access'
import { createServiceClient } from '@/lib/supabase/server'
import { validateBalanceContinuity } from '@/lib/reports/continuity-check'
import type { FiscalPeriod, JournalEntry, YearEndResult } from '@/types'

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
        'id, status, current_step, error_code, error_message, user_message, correlation_id, retry_count, retryable, recovery_required, idempotency_key, preview_id, ledger_hash, readiness_hash, adjustment_hash, ruleset_version, closing_entry_id, opening_balance_entry_id, opening_balance_created, revaluation_entry_id, revaluation_reversal_entry_id, next_period_id, next_period_created, committed_at, started_at, finished_at, created_at, updated_at',
      )
      .eq('company_id', companyId!)
      .eq('fiscal_period_id', id)
      .order('created_at', { ascending: false })
      .limit(50)

    if (error) {
      opLog.error('year-end runs fetch failed', new Error(error.message))
      return errorResponseFromCode('INTERNAL_ERROR', opLog, { requestId })
    }

    const closedRun = (data ?? []).find((run) => run.status === 'closed')
    let committedResult: YearEndResult | null = null
    if (
      closedRun?.closing_entry_id &&
      closedRun.opening_balance_entry_id &&
      closedRun.next_period_id &&
      closedRun.preview_id
    ) {
      const [closing, opening, nextPeriod, revaluation, continuity, acknowledgement] = await Promise.all([
        serviceDb
          .from('journal_entries')
          .select('*')
          .eq('company_id', companyId!)
          .eq('id', closedRun.closing_entry_id)
          .single(),
        serviceDb
          .from('journal_entries')
          .select('*')
          .eq('company_id', companyId!)
          .eq('id', closedRun.opening_balance_entry_id)
          .single(),
        serviceDb
          .from('fiscal_periods')
          .select('*')
          .eq('company_id', companyId!)
          .eq('id', closedRun.next_period_id)
          .single(),
        closedRun.revaluation_entry_id
          ? serviceDb
              .from('journal_entries')
              .select('*')
              .eq('company_id', companyId!)
              .eq('id', closedRun.revaluation_entry_id)
              .single()
          : Promise.resolve({ data: null, error: null }),
        validateBalanceContinuity(serviceDb, companyId!, closedRun.next_period_id),
        serviceDb
          .from('year_end_run_acknowledgements')
          .select('acknowledged_at, acknowledged_by, statement_version')
          .eq('company_id', companyId!)
          .eq('fiscal_period_id', id)
          .eq('year_end_run_id', closedRun.id)
          .eq('acknowledged_by', user.id)
          .order('acknowledged_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ])
      if (!closing.error && !opening.error && !nextPeriod.error) {
        committedResult = {
          runId: closedRun.id,
          previewId: closedRun.preview_id,
          ledgerHash: closedRun.ledger_hash ?? '',
          readinessHash: closedRun.readiness_hash ?? '',
          adjustmentHash: closedRun.adjustment_hash ?? '',
          rulesetVersion: closedRun.ruleset_version ?? '',
          closingEntry: closing.data as JournalEntry,
          openingBalanceEntry: opening.data as JournalEntry,
          nextPeriod: nextPeriod.data as FiscalPeriod,
          revaluationEntry: (revaluation.data as JournalEntry | null) ?? null,
          resultViewComplete: true,
          nextPeriodCreated: Boolean(
            (closedRun as { next_period_created?: boolean | null }).next_period_created,
          ),
          nextPeriodId: closedRun.next_period_id,
          openingBalancesCreated: Boolean(
            (closedRun as { opening_balance_created?: boolean | null }).opening_balance_created,
          ),
          closingEntryId: closedRun.closing_entry_id,
          executionId: closedRun.id,
          acknowledgedAt: acknowledgement.data?.acknowledged_at ?? null,
          acknowledgedBy: acknowledgement.data?.acknowledged_by ?? null,
          acknowledgementVersion: acknowledgement.data?.statement_version ?? null,
          continuity,
        }
      }
    }

    return NextResponse.json({ data: data ?? [], committedResult })
  },
  { allowRequestedCompany: true },
)
