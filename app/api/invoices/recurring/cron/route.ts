import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ensureInitialized } from '@/lib/init'
import { withCronContext, type CronItemContext } from '@/lib/api/with-cron-context'
import { createServiceClient } from '@/lib/supabase/server'
import {
  executeRecurringSchedule,
  computeNextRunDate,
} from '@/lib/invoices/recurring-schedule-service'
import type {
  RecurringInvoiceSchedule,
  RecurringInvoiceScheduleItem,
} from '@/types'

ensureInitialized()

type DueSchedule = RecurringInvoiceSchedule & { items: RecurringInvoiceScheduleItem[] }

type ClaimOutcome =
  | { claimed: true; runId: string }
  | { claimed: false; reason: 'already_succeeded' | 'concurrent_run' | 'claim_failed' }

/**
 * Claim the (schedule, run_date) slot in recurring_invoice_runs.
 *
 * The UNIQUE index on (schedule_id, run_date) is the duplicate-invoice guard:
 *  - fresh insert            → claim acquired
 *  - existing 'succeeded'    → this run date already produced an invoice; skip
 *  - existing 'running'      → concurrent runner in flight; skip
 *  - existing 'failed'       → previous attempt failed; take over via CAS so
 *                              exactly one retryer proceeds
 */
async function claimRun(
  supabase: SupabaseClient,
  schedule: DueSchedule,
  runDate: string,
  requestId: string,
): Promise<ClaimOutcome> {
  const { data: inserted, error: insertError } = await supabase
    .from('recurring_invoice_runs')
    .insert({
      schedule_id: schedule.id,
      company_id: schedule.company_id,
      run_date: runDate,
      status: 'running',
      request_id: requestId,
    })
    .select('id')
    .single()

  if (!insertError && inserted) return { claimed: true, runId: inserted.id }

  if (insertError && insertError.code !== '23505') {
    return { claimed: false, reason: 'claim_failed' }
  }

  // Unique violation — inspect the holder.
  const { data: existing } = await supabase
    .from('recurring_invoice_runs')
    .select('id, status')
    .eq('schedule_id', schedule.id)
    .eq('run_date', runDate)
    .maybeSingle()

  if (!existing) return { claimed: false, reason: 'claim_failed' }
  if (existing.status === 'succeeded') return { claimed: false, reason: 'already_succeeded' }
  if (existing.status === 'running') return { claimed: false, reason: 'concurrent_run' }

  // failed/skipped → CAS takeover. Only one concurrent retryer wins.
  const { data: takenOver, error: takeoverError } = await supabase
    .from('recurring_invoice_runs')
    .update({ status: 'running', started_at: new Date().toISOString(), finished_at: null, error: null, request_id: requestId })
    .eq('id', existing.id)
    .in('status', ['failed', 'skipped'])
    .select('id')

  if (takeoverError || !takenOver || takenOver.length === 0) {
    return { claimed: false, reason: 'concurrent_run' }
  }
  return { claimed: true, runId: existing.id }
}

async function finalizeRun(
  supabase: SupabaseClient,
  runId: string,
  patch: Record<string, unknown>,
  itemLog: CronItemContext['log'],
): Promise<void> {
  const { error } = await supabase
    .from('recurring_invoice_runs')
    .update({ ...patch, finished_at: new Date().toISOString() })
    .eq('id', runId)
  if (error) {
    itemLog.error('failed to finalize recurring invoice run row', error, { runId })
  }
}

/**
 * GET /api/invoices/recurring/cron — daily 06:30 UTC.
 *
 * Spawns invoices for every active schedule whose next_run_date is today or
 * earlier. Each schedule runs in isolated try/catch so a failure on one
 * doesn't block the rest. Idempotency is DB-enforced through
 * recurring_invoice_runs (unique per schedule + intended run date) — cron
 * retries, overlapping invocations and finalize failures can never spawn a
 * duplicate invoice for the same run date.
 */
export const GET = withCronContext('cron.recurring_invoices', async (_request, ctx) => {
  const supabase = createServiceClient()

  const today = new Date()
  const todayIso = today.toISOString().slice(0, 10)

  const { data: due, error } = await supabase
    .from('recurring_invoice_schedules')
    .select('*, items:recurring_invoice_schedule_items(*)')
    .eq('status', 'active')
    .lte('next_run_date', todayIso)

  if (error) {
    ctx.log.error('failed to load due recurring schedules', error)
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 },
    )
  }

  const schedules = (due ?? []) as DueSchedule[]

  ctx.log.info('recurring invoice cron starting', {
    dueCount: schedules.length,
    todayIso,
  })

  let spawned = 0
  let skipped = 0

  const summary = await ctx.forEach('schedule', schedules, async (schedule, itemCtx) => {
    // The intended run date is the schedule's due date (not the wall clock) —
    // a failed attempt retried the next calendar day still claims the same
    // slot, and a succeeded slot blocks any re-spawn even if the schedule's
    // next_run_date failed to advance.
    const runDate = schedule.next_run_date <= todayIso ? schedule.next_run_date : todayIso

    const claim = await claimRun(supabase, schedule, runDate, itemCtx.requestId)

    if (!claim.claimed) {
      if (claim.reason === 'already_succeeded') {
        // Self-heal: the invoice for this run date exists but the schedule
        // pointer was never advanced (finalize failure on a previous run).
        // Advance next_run_date so the schedule resumes its normal cadence.
        const nextRunDate = computeNextRunDate(today, schedule.day_of_month)
        await supabase
          .from('recurring_invoice_schedules')
          .update({ next_run_date: nextRunDate })
          .eq('id', schedule.id)
          .eq('company_id', schedule.company_id)
          .eq('next_run_date', schedule.next_run_date)
        itemCtx.log.warn('run date already succeeded — advanced next_run_date (self-heal)', {
          runDate,
          nextRunDate,
        })
      } else {
        itemCtx.log.info('schedule claim not acquired — skipping', { reason: claim.reason, runDate })
      }
      skipped += 1
      return
    }

    let result: Awaited<ReturnType<typeof executeRecurringSchedule>>
    try {
      result = await executeRecurringSchedule(supabase, schedule, today)
    } catch (err) {
      await finalizeRun(supabase, claim.runId, {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      }, itemCtx.log)
      throw err
    }

    await finalizeRun(supabase, claim.runId, {
      status: 'succeeded',
      invoice_id: result.invoiceId,
      auto_sent: result.autoSent,
      warning: result.warning,
    }, itemCtx.log)

    const nextRunDate = computeNextRunDate(today, schedule.day_of_month)
    const { error: updateError } = await supabase
      .from('recurring_invoice_schedules')
      .update({
        next_run_date: nextRunDate,
        last_run_at: new Date().toISOString(),
        last_invoice_id: result.invoiceId,
        last_run_warning: result.warning,
        generated_count: schedule.generated_count + 1,
      })
      .eq('id', schedule.id)
      .eq('company_id', schedule.company_id)

    if (updateError) {
      // The invoice exists and the run row is 'succeeded', so a retry can
      // never double-spawn this run date — the claim check self-heals the
      // pointer tomorrow. Surface loudly for visibility.
      itemCtx.log.error(
        'invoice created but failed to finalize schedule — next_run_date not advanced',
        updateError,
        { scheduleId: schedule.id, invoiceId: result.invoiceId },
      )
      throw new Error(
        `schedule finalize failed after invoice ${result.invoiceId} created: ${updateError.message}`,
      )
    }

    spawned += 1
  })

  ctx.log.info('recurring invoice cron summary', {
    total: summary.total,
    succeeded: summary.succeeded,
    failed: summary.failed,
    spawned,
    skipped,
  })

  // Deliberately no per-tenant identifiers in the response body: run details
  // are persisted in recurring_invoice_runs and visible in structured logs
  // via the request id.
  return NextResponse.json({
    success: true,
    total: summary.total,
    succeeded: summary.succeeded,
    failed: summary.failed,
    spawned,
    skipped,
    failureCount: summary.failures.length,
  })
})

export const POST = GET
