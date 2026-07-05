import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'

const log = createLogger('inbox-rate-limit')

/**
 * Per-company rate limiter for document-inbox ingestion. Backed by the
 * `check_and_increment_inbox_quota` Postgres RPC (atomic check + increment),
 * not Upstash — keeps the limiter on the same shared distributed store the
 * rest of the app already hits, and works without extra env vars on Vercel
 * and Docker deployments alike.
 *
 * Both windows are per-company:
 *   - MINUTE_MAX: a real user could only ever hit this with a script or by
 *     holding the upload button. The defense is against burst floods.
 *   - DAY_MAX: the backstop against slow drip abuse. A legitimate end-of-
 *     month batch is well under this number.
 */
export interface InboxLimitResult {
  ok: boolean
  retryAfterSec?: number
  scope?: 'minute' | 'day'
}

const MINUTE_MAX = 30
const DAY_MAX = 500

// Circuit breaker: single blips fail open (per-file size + MIME checks still
// apply), sustained RPC failure fails closed so a flood cannot ride out an
// outage of the quota store unmetered.
const FAIL_CLOSED_AFTER_CONSECUTIVE_FAILURES = 3
let consecutiveRpcFailures = 0

export async function checkInboxUploadRateLimit(
  supabase: SupabaseClient,
  companyId: string,
): Promise<InboxLimitResult> {
  const { data, error } = await supabase.rpc('check_and_increment_inbox_quota', {
    p_company_id: companyId,
    p_minute_max: MINUTE_MAX,
    p_day_max: DAY_MAX,
  })
  if (error) {
    consecutiveRpcFailures += 1
    log.error('inbox quota RPC failed', error as unknown as Error, {
      consecutiveFailures: consecutiveRpcFailures,
    })
    if (consecutiveRpcFailures >= FAIL_CLOSED_AFTER_CONSECUTIVE_FAILURES) {
      return { ok: false, scope: 'minute', retryAfterSec: 30 }
    }
    return { ok: true }
  }
  consecutiveRpcFailures = 0
  // RPC returns jsonb_build_object payload. The JS client decodes as object.
  const result = (data ?? { ok: true }) as {
    ok: boolean
    scope?: 'minute' | 'day'
    retry_after_sec?: number
  }
  return {
    ok: result.ok,
    scope: result.scope,
    retryAfterSec: result.retry_after_sec,
  }
}
