import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createExtensionContext } from '@/lib/extensions/context-factory'
import { syncSkattekonto, SKATTEKONTO_LAST_SYNCED_AT_KEY } from '@/extensions/general/skatteverket/lib/skattekonto-sync'
import { computeSkattekontoDrift, maybeAlertDrift } from '@/extensions/general/skatteverket/lib/skattekonto-drift'
import { SkatteverketAuthError } from '@/extensions/general/skatteverket/lib/api-client'
import { SkatteverketSkattekontoError } from '@/extensions/general/skatteverket/lib/skattekonto-client'

ensureInitialized()

export const maxDuration = 60

/**
 * GET /api/extensions/skatteverket/skattekonto/sync/cron
 *
 * Daily skattekonto sync (cron 0 4 * * * — 04:00 UTC, 06:00 Swedish time).
 * Pulls saldo + transactions for every company that has a connected
 * Skatteverket token, and persists the results to skattekonto_transactions.
 *
 * Skips a company if it was synced within the last hour (cooldown),
 * to keep manual + cron triggers from racing each other.
 *
 * Time budget: 50s (Vercel default 60s function timeout, 10s margin).
 *
 * Per-company outcomes are logged with the run's request id — the response
 * body carries AGGREGATES ONLY (no tenant identifiers).
 */
export const GET = withCronContext('cron.skatteverket_skattekonto_sync', async (_request, cronCtx) => {
  // Respect the runtime extension toggle. When the integration is disabled
  // the cron should no-op rather than spam Skatteverket with stale tokens.
  if (process.env.SKATTEVERKET_ENABLED !== 'true') {
    return NextResponse.json({ message: 'Skatteverket extension disabled', processed: 0 })
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseServiceKey) {
    return NextResponse.json({ error: 'Missing Supabase configuration' }, { status: 500 })
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  // Find all companies with a connected token. The token row is keyed by
  // user_id but carries company_id (added in the multi-tenant refactor).
  const { data: tokens, error: tokensError } = await supabase
    .from('skatteverket_tokens')
    .select('user_id, company_id, expires_at, refresh_count')
    .order('expires_at', { ascending: true })
    .limit(50)

  if (tokensError) {
    cronCtx.log.error('failed to fetch tokens', tokensError)
    return NextResponse.json({ error: 'Failed to fetch tokens' }, { status: 500 })
  }

  if (!tokens || tokens.length === 0) {
    return NextResponse.json({ message: 'No connected tokens', processed: 0 })
  }

  const startTime = Date.now()
  const TIME_BUDGET_MS = 50_000
  const SYNC_COOLDOWN_MS = 60 * 60 * 1000 // 1 hour

  let processed = 0
  let synced = 0
  let skipped = 0
  let expired = 0
  let budgetReached = false

  const summary = await cronCtx.forEach('token', tokens, async (token, itemCtx) => {
    if (budgetReached || Date.now() - startTime > TIME_BUDGET_MS) {
      if (!budgetReached) itemCtx.log.info('time budget reached — remaining tokens deferred to next run')
      budgetReached = true
      return
    }

    const userId = token.user_id as string
    const companyId = token.company_id as string | null

    if (!companyId) {
      // Pre-multi-tenant tokens may lack company_id. Skip — cannot scope.
      itemCtx.log.warn('token without company_id — cannot scope, skipping', { userId })
      return
    }

    processed += 1
    const itemLog = itemCtx.log

    try {
      // Cooldown: skip if synced within the last hour.
      const { data: lastSyncRow } = await supabase
        .from('extension_data')
        .select('value, updated_at')
        .eq('company_id', companyId)
        .eq('extension_id', 'skatteverket')
        .eq('key', SKATTEKONTO_LAST_SYNCED_AT_KEY)
        .maybeSingle()

      const lastSyncedAt = lastSyncRow?.value as string | undefined
      if (lastSyncedAt) {
        const elapsed = Date.now() - new Date(lastSyncedAt).getTime()
        if (elapsed < SYNC_COOLDOWN_MS) {
          skipped += 1
          itemLog.info('skipped (cooldown)', { companyId })
          return
        }
      }

      const ctx = createExtensionContext(supabase, userId, companyId, 'skatteverket')
      const syncResult = await syncSkattekonto(ctx)

      // Drift check: compare the fresh SKV saldo against GL 1630 sum. Emits
      // `skattekonto.drift_detected` when |drift| > tolerance and not throttled.
      try {
        const drift = await computeSkattekontoDrift(ctx)
        if (drift) await maybeAlertDrift(ctx, drift)
      } catch (driftErr) {
        itemLog.error('drift check failed', driftErr as Error, { companyId })
      }

      synced += 1
      itemLog.info('synced', { companyId, booked: syncResult.booked, upcoming: syncResult.upcoming })
    } catch (err) {
      // Expired token / refresh exhausted is a known outcome — surface it
      // distinctly so ops can dashboard "X companies need to reconnect".
      if (
        err instanceof SkatteverketAuthError &&
        (err.code === 'REFRESH_EXHAUSTED' || err.code === 'SESSION_EXPIRED' || err.code === 'TOKEN_CORRUPTED')
      ) {
        expired += 1
        itemLog.warn('token expired — reconnect required', { companyId, code: err.code })
        return
      }

      const felkod = err instanceof SkatteverketSkattekontoError ? err.felkod : null
      itemLog.error('sync failed', err as Error, { companyId, felkod })
      throw err
    }
  })

  cronCtx.log.info('skattekonto sync summary', {
    processed,
    synced,
    skipped,
    expired,
    failed: summary.failed,
  })

  // Aggregates only — per-tenant details live in the structured logs above,
  // correlated via the run's request id.
  return NextResponse.json({
    processed,
    synced,
    skipped,
    expired,
    errors: summary.failed,
  })
})
