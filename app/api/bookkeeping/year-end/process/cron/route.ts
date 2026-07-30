import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withCronContext } from '@/lib/api/with-cron-context'
import { eventBus } from '@/lib/events/bus'
import { createServiceClient } from '@/lib/supabase/server'
import type { FiscalPeriod } from '@/types'

ensureInitialized()

interface ClaimedOutboxRow {
  id: string
  company_id: string
  fiscal_period_id: string
  year_end_run_id: string
  event_type: string
  payload: Record<string, unknown>
  actor_user_id: string
  attempt_count: number
}

/**
 * Posts due year-end reversals and dispatches committed outbox events.
 * Database claims use SKIP LOCKED; retries can therefore overlap safely
 * across Vercel/Docker cron invocations without duplicate vouchers or events.
 */
export const GET = withCronContext('cron.year_end_processors', async (_request, ctx) => {
  const db = createServiceClient()
  const { data: reversalResult, error: reversalError } = await db.rpc(
    'process_due_year_end_reversals',
    { p_limit: 200 },
  )
  if (reversalError) {
    ctx.log.error('year-end reversal processor failed', new Error(reversalError.message))
    return NextResponse.json(
      { success: false, error: reversalError.message },
      { status: 500 },
    )
  }

  const { data: claimed, error: claimError } = await db.rpc(
    'claim_year_end_outbox',
    { p_limit: 200 },
  )
  if (claimError) {
    ctx.log.error('year-end outbox claim failed', new Error(claimError.message))
    return NextResponse.json(
      { success: false, error: claimError.message, reversals: reversalResult },
      { status: 500 },
    )
  }

  let delivered = 0
  let failed = 0
  for (const row of (claimed ?? []) as ClaimedOutboxRow[]) {
    try {
      if (row.event_type !== 'period.year_closed') {
        throw new Error(`Unsupported year-end event type: ${row.event_type}`)
      }
      const { data: period, error: periodError } = await db
        .from('fiscal_periods')
        .select('*')
        .eq('id', row.fiscal_period_id)
        .eq('company_id', row.company_id)
        .single()
      if (periodError || !period) {
        throw new Error(periodError?.message ?? 'Fiscal period missing')
      }

      await eventBus.emitStrict({
        type: 'period.year_closed',
        payload: {
          period: period as FiscalPeriod,
          userId: row.actor_user_id,
          companyId: row.company_id,
        },
      })
      const { data: completed, error: completeError } = await db.rpc(
        'complete_year_end_outbox',
        { p_id: row.id },
      )
      if (completeError || completed !== true) {
        throw new Error(completeError?.message ?? 'Outbox completion claim was lost')
      }
      delivered += 1
    } catch (error) {
      failed += 1
      const message = error instanceof Error ? error.message : 'unknown'
      ctx.log.error('year-end outbox delivery failed', error as Error, {
        outboxId: row.id,
        companyId: row.company_id,
        eventType: row.event_type,
      })
      await db.rpc('fail_year_end_outbox', {
        p_id: row.id,
        p_error: message,
      })
    }
  }

  return NextResponse.json({
    success: failed === 0,
    reversals: reversalResult,
    outbox: {
      claimed: (claimed ?? []).length,
      delivered,
      failed,
    },
  }, { status: failed === 0 ? 200 : 207 })
})

export const POST = GET
