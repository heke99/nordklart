import { NextResponse } from 'next/server'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { checkRateLimit, type RateLimitResult } from '@/lib/auth/rate-limit-http'
import { createLogger } from '@/lib/logger'

const log = createLogger('rate-limit.durable')

export interface DurableRateLimitOptions {
  /** Namespace for the counter, e.g. `bankid:start`. */
  prefix: string
  /** Caller identity. Truncate IPs with `truncateIp()` before passing them. */
  identifier: string
  maxRequests: number
  windowMs: number
  /**
   * Swedish message for the 429 body. Defaults to the generic one used by
   * `checkRateLimit`.
   */
  message?: string
}

/**
 * A rate limit that is enforced in every deployment.
 *
 * `checkRateLimit()` is the right primitive when Upstash is configured — it is
 * a sliding window and it never touches the database. But it deliberately
 * no-ops when `UPSTASH_REDIS_REST_URL`/`_TOKEN` are absent, which is the
 * normal state for the Docker deployment and for local dev. For an endpoint
 * whose only protection is the limit — an unauthenticated route with a
 * billable side effect, such as starting a BankID session — "no Redis means no
 * limit" is not an acceptable default.
 *
 * So: Upstash when it is configured, and otherwise a fixed-window counter in
 * Postgres via `consume_rate_limit()`, which every deployment has.
 *
 * **Fails closed.** If the database cannot answer, the request is refused with
 * 503 rather than let through. That is the opposite of `checkRateLimit`'s
 * posture and it is deliberate: this helper only guards endpoints where an
 * unlimited call costs money or hands an attacker a free amplifier, so the
 * safe direction on an outage is to stop.
 */
export async function checkDurableRateLimit(
  opts: DurableRateLimitOptions
): Promise<RateLimitResult> {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    return checkRateLimit({
      prefix: opts.prefix,
      identifier: opts.identifier,
      maxRequests: opts.maxRequests,
      windowMs: opts.windowMs,
    })
  }

  const supabase = createServiceClientNoCookies()
  const { data, error } = await supabase.rpc('consume_rate_limit', {
    p_bucket: opts.prefix,
    p_identifier: opts.identifier,
    p_max_requests: opts.maxRequests,
    p_window_seconds: Math.max(1, Math.ceil(opts.windowMs / 1000)),
  })

  if (error || !data) {
    log.error('consume_rate_limit failed — refusing the request', error ?? undefined, {
      prefix: opts.prefix,
    })
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Tjänsten är tillfälligt otillgänglig. Försök igen om en stund.' },
        { status: 503 }
      ),
    }
  }

  const result = data as {
    allowed: boolean
    limit: number
    remaining: number
    reset_at: string
  }

  if (result.allowed) return { ok: true }

  const resetMs = Date.parse(result.reset_at)
  const retryAfterSec = Number.isFinite(resetMs)
    ? Math.max(1, Math.ceil((resetMs - Date.now()) / 1000))
    : Math.max(1, Math.ceil(opts.windowMs / 1000))

  const response = NextResponse.json(
    { error: opts.message ?? 'För många förfrågningar. Försök igen om en stund.' },
    { status: 429 }
  )
  response.headers.set('Retry-After', String(retryAfterSec))
  response.headers.set('X-RateLimit-Limit', String(result.limit))
  response.headers.set('X-RateLimit-Remaining', String(result.remaining))
  if (Number.isFinite(resetMs)) {
    response.headers.set('X-RateLimit-Reset', String(Math.ceil(resetMs / 1000)))
  }
  return { ok: false, response }
}
