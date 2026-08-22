import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { errorResponse } from '@/lib/errors/get-structured-error'

/**
 * GET /api/events/cleanup/cron — daily 02:00 UTC.
 *
 * Differentiated retention:
 * - Delivery events (invoice.created, transaction.synced, …): 30 days. They
 *   exist for external automation polling (n8n/Make/Zapier) and go stale fast.
 * - Agent telemetry (mcp.*, agent.*): 180 days. Error-rate trends and
 *   skill-load correlation need more than one month of signal — a 30-day
 *   window made it impossible to tell whether a tool or skill change actually
 *   moved failure rates.
 *
 * Retention is declared in .compliance/ropa.yaml (id: mcp.telemetry).
 *
 * The same pass also sweeps unclaimed BankID login orders. They live in
 * bankid_sessions with user_id NULL — pre-authentication records that never
 * resolved to an account, so no account's retention schedule covers them and
 * no user can ask to have them removed. Anything unclaimed after 30 days is an
 * abandoned scan. Piggy-backing on this daily job rather than adding a
 * seventeenth cron entry keeps the schedule (and the Docker crontab) in step.
 */
const DELIVERY_RETENTION_DAYS = 30
const TELEMETRY_RETENTION_DAYS = 180

export const GET = withCronContext('cron.events_cleanup', async (_request, ctx) => {
  const supabase = createServiceClient()

  const deliveryCutoff = new Date()
  deliveryCutoff.setDate(deliveryCutoff.getDate() - DELIVERY_RETENTION_DAYS)
  const telemetryCutoff = new Date()
  telemetryCutoff.setDate(telemetryCutoff.getDate() - TELEMETRY_RETENTION_DAYS)

  // Pass 1: delivery events past 30 days. Telemetry (mcp.*, agent.*) is
  // excluded here and swept by the 180-day pass below.
  const { error: deliveryError, count: deliveryCount } = await supabase
    .from('event_log')
    .delete({ count: 'exact' })
    .lt('created_at', deliveryCutoff.toISOString())
    .not('event_type', 'like', 'mcp.%')
    .not('event_type', 'like', 'agent.%')

  if (deliveryError) {
    ctx.log.error('event log delivery cleanup failed', deliveryError)
    return errorResponse(deliveryError, ctx.log, { requestId: ctx.requestId })
  }

  // Pass 2: everything past 180 days — catches the telemetry rows pass 1 skipped.
  const { error: telemetryError, count: telemetryCount } = await supabase
    .from('event_log')
    .delete({ count: 'exact' })
    .lt('created_at', telemetryCutoff.toISOString())

  if (telemetryError) {
    ctx.log.error('event log telemetry cleanup failed', telemetryError)
    return errorResponse(telemetryError, ctx.log, { requestId: ctx.requestId })
  }

  const deletedDelivery = deliveryCount ?? 0
  const deletedTelemetry = telemetryCount ?? 0
  const deleted = deletedDelivery + deletedTelemetry
  ctx.log.info('event log cleanup summary', {
    deleted,
    deletedDelivery,
    deletedTelemetry,
    deliveryCutoff: deliveryCutoff.toISOString(),
    telemetryCutoff: telemetryCutoff.toISOString(),
  })

  // Best-effort: an event_log sweep that succeeded should still report success
  // if this one fails, so it is logged rather than returned as an error.
  let deletedBankIdSessions = 0
  const { data: sweptSessions, error: bankIdError } = await supabase.rpc(
    'cleanup_unclaimed_bankid_sessions',
  )
  if (bankIdError) {
    ctx.log.error('unclaimed bankid session cleanup failed', bankIdError)
  } else {
    deletedBankIdSessions = typeof sweptSessions === 'number' ? sweptSessions : 0
    ctx.log.info('unclaimed bankid session cleanup summary', { deletedBankIdSessions })
  }

  return NextResponse.json({
    success: true,
    deleted,
    deletedDelivery,
    deletedTelemetry,
    deletedBankIdSessions,
  })
})
