import { NextResponse } from 'next/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { verifyCronSecret } from '@/lib/auth/cron'
import { requireAuth } from '@/lib/auth/require-auth'
import { createLogger } from '@/lib/logger'
import { computeIntegrationReadiness } from '@/lib/platform/integration-readiness'
import { getMaintenanceMode } from '@/lib/ops/maintenance'
import { PLATFORM_ROLES } from '@/lib/auth/platform'

const log = createLogger('health-deep')

interface CheckOutcome {
  ok: boolean
  detail: string
  [key: string]: unknown
}

/**
 * GET /api/health/deep — operational deep health.
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>` (monitoring) OR a signed-in
 * platform-role session (ops UI). Public callers get 401 — the payload
 * exposes operational internals (queue depths, integration configuration).
 *
 * Checks:
 *   database    — service-role probe
 *   migrations  — schema-freshness probe against a recently added table
 *   storage     — documents bucket reachable
 *   webhooks    — failed/dead delivery backlog
 *   cron        — freshness of cron-produced rows (event log + bank syncs)
 *   integrations— readiness summary (misconfigured/blocked flagged)
 *   maintenance — current mode
 */
export async function GET(request: Request) {
  // Auth path 1: cron/monitoring secret.
  let authorized = verifyCronSecret(request) === null

  // Auth path 2: platform-role session (requireAuth enforces MFA on hosted).
  if (!authorized) {
    try {
      const auth = await requireAuth()
      if (!auth.error) {
        const { data: role } = await auth.supabase
          .from('platform_roles')
          .select('role')
          .eq('user_id', auth.user.id)
          .in('role', [...PLATFORM_ROLES])
          // Revocation is recorded, not deleted, so the grant row outlives the
          // access. Without this predicate a revoked operator kept the deep
          // health view (queue depths, integration state, cron freshness).
          .is('revoked_at', null)
          .limit(1)
          .maybeSingle()
        authorized = !!role
      }
    } catch {
      // fall through to 401
    }
  }

  if (!authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    return NextResponse.json(
      { status: 'unhealthy', checks: { database: { ok: false, detail: 'Supabase env vars missing' } } },
      { status: 503 },
    )
  }
  const db = createSupabaseClient(url, key, { auth: { persistSession: false } })

  const checks: Record<string, CheckOutcome> = {}

  // ── Database ────────────────────────────────────────────────────────────
  try {
    const { error } = await db.from('fiscal_periods').select('id', { head: true, count: 'exact' }).limit(1)
    checks.database = error
      ? { ok: false, detail: `query failed (${error.code ?? 'unknown'})` }
      : { ok: true, detail: 'reachable' }
  } catch {
    checks.database = { ok: false, detail: 'unreachable' }
  }

  // ── Migrations (schema freshness) ───────────────────────────────────────
  // Probes a table from the most recent migration wave. A missing relation
  // (42P01) means migrations have not been applied for this release.
  try {
    const { error } = await db
      .from('invoice_financing_providers')
      .select('slug', { head: true, count: 'exact' })
      .limit(1)
    checks.migrations = error
      ? { ok: false, detail: error.code === '42P01' ? 'migrations behind (missing table)' : `probe failed (${error.code ?? 'unknown'})` }
      : { ok: true, detail: 'schema current' }
  } catch {
    checks.migrations = { ok: false, detail: 'probe failed' }
  }

  // ── Storage ─────────────────────────────────────────────────────────────
  try {
    const { data: bucket, error } = await db.storage.getBucket('documents')
    checks.storage = error || !bucket
      ? { ok: false, detail: 'documents bucket missing or unreachable' }
      : { ok: true, detail: 'documents bucket reachable' }
  } catch {
    checks.storage = { ok: false, detail: 'storage unreachable' }
  }

  // ── Webhook delivery backlog ─────────────────────────────────────────────
  try {
    const [{ count: failed }, { count: pendingRetry }] = await Promise.all([
      db.from('webhook_deliveries').select('*', { head: true, count: 'exact' }).eq('status', 'dead'),
      db.from('webhook_deliveries').select('*', { head: true, count: 'exact' }).eq('status', 'failed'),
    ])
    const backlog = (failed ?? 0) + (pendingRetry ?? 0)
    checks.webhooks = {
      ok: backlog < 100,
      detail: backlog < 100 ? 'backlog nominal' : 'delivery backlog high',
      dead: failed ?? 0,
      failed_pending_retry: pendingRetry ?? 0,
    }
  } catch {
    checks.webhooks = { ok: false, detail: 'backlog query failed' }
  }

  // ── Cron freshness ──────────────────────────────────────────────────────
  // event_log receives rows from ordinary activity AND every cron pass;
  // bank_sync_runs records cron-triggered syncs when PSD2 connections exist.
  // The webhook dispatcher runs every minute, so a silent event_log for a
  // whole day means cron scheduling itself is broken — that fails the check.
  // Bank-sync staleness only applies when a cron sync has ever run (fresh
  // installs without PSD2 connections must not page anyone).
  try {
    const [{ data: latestEvent }, { data: latestCronSync }] = await Promise.all([
      db.from('event_log').select('created_at').order('created_at', { ascending: false }).limit(1).maybeSingle(),
      db.from('bank_sync_runs').select('started_at').eq('trigger_source', 'cron').order('started_at', { ascending: false }).limit(1).maybeSingle(),
    ])
    const latestEventAt = (latestEvent as { created_at: string } | null)?.created_at ?? null
    const latestCronSyncAt = (latestCronSync as { started_at: string } | null)?.started_at ?? null

    const DAY_MS = 24 * 60 * 60 * 1000
    const staleEvents = latestEventAt !== null && Date.now() - new Date(latestEventAt).getTime() > DAY_MS
    // Daily bank sync: alert after two missed windows (50h) to avoid
    // flapping around the schedule boundary.
    const staleBankSync = latestCronSyncAt !== null && Date.now() - new Date(latestCronSyncAt).getTime() > 50 * 60 * 60 * 1000

    checks.cron = {
      ok: !staleEvents && !staleBankSync,
      detail: staleEvents
        ? 'no event_log rows for >24h — cron scheduling likely broken'
        : staleBankSync
          ? 'no cron bank sync for >50h — daily sync missing'
          : 'cron activity fresh',
      latest_event_at: latestEventAt,
      latest_cron_bank_sync_at: latestCronSyncAt,
    }
  } catch {
    checks.cron = { ok: false, detail: 'freshness query failed' }
  }

  // ── Integration readiness ───────────────────────────────────────────────
  const readiness = computeIntegrationReadiness()
  const problems = readiness.filter((e) => e.status === 'misconfigured' || e.status === 'blocked')
  checks.integrations = {
    ok: problems.length === 0,
    detail: problems.length === 0 ? 'no misconfigured integrations' : `${problems.length} integration(s) misconfigured/blocked`,
    summary: readiness.map((e) => ({ id: e.id, status: e.status })),
  }

  // ── Maintenance mode ────────────────────────────────────────────────────
  const maintenanceMode = getMaintenanceMode()
  checks.maintenance = {
    ok: maintenanceMode !== 'read_only',
    detail: `mode=${maintenanceMode}`,
    mode: maintenanceMode,
  }

  const critical = ['database', 'migrations', 'storage']
  const healthy = critical.every((name) => checks[name]?.ok)
  const degraded = !Object.values(checks).every((c) => c.ok)

  const status = healthy ? (degraded ? 'degraded' : 'healthy') : 'unhealthy'
  if (status !== 'healthy') {
    log.warn('deep health not healthy', {
      status,
      failing: Object.entries(checks).filter(([, c]) => !c.ok).map(([name]) => name),
    })
  }

  return NextResponse.json(
    { status, timestamp: new Date().toISOString(), checks },
    { status: healthy ? 200 : 503 },
  )
}
