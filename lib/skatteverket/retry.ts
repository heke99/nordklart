/**
 * Retry policy for Skatteverket calls.
 *
 * Two rules do most of the work here, and both are about not making things
 * worse:
 *
 * 1. **Never auto-retry a POST.** Skatteverket exposes no idempotency header,
 *    so a POST that timed out may or may not have created a filing on their
 *    side — and a second one that succeeds leaves the company with two. A
 *    duplicate AGI or momsdeklaration is a worse outcome than an error the
 *    operator can act on. Safe and idempotent methods (GET, HEAD, PUT, DELETE)
 *    have no such hazard and are retried.
 *
 * 2. **Only retry what a retry can fix.** A timeout, a 429, and 502/503/504
 *    are the provider or the gateway being momentarily unavailable. A 400, a
 *    401, a 403 and a 500 are answers: retrying them burns quota and hides the
 *    real failure behind a delay.
 *
 * Backoff is exponential with full jitter — synchronised retries from several
 * instances would recreate the 429 they are backing off from.
 */

export const SKV_MAX_ATTEMPTS = 3
const BASE_DELAY_MS = 1_000
const MAX_DELAY_MS = 30_000

/** Methods with no risk of creating a second filing when repeated. */
const REPEATABLE_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE'])

/** Provider-side transients. 500 is excluded on purpose: it is an answer. */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504])

export interface RetryDecision {
  retry: boolean
  /** Milliseconds to wait before the next attempt; 0 when not retrying. */
  delayMs: number
  /** Short machine-readable reason, for the request log. */
  reason:
    | 'transport'
    | 'throttled'
    | 'upstream_unavailable'
    | 'not_repeatable'
    | 'not_retryable'
    | 'attempts_exhausted'
}

export interface RetryInput {
  method: string
  /** 0 when the request never produced a response (timeout, connection reset). */
  statusCode: number
  /** 1-based number of the attempt that just failed. */
  attempt: number
  /** `Retry-After` in seconds, when the provider sent one. */
  retryAfterSeconds?: number | null
  /** Deterministic jitter for tests; defaults to Math.random. */
  random?: () => number
}

export function decideSkvRetry(input: RetryInput): RetryDecision {
  const method = input.method.toUpperCase()

  if (!REPEATABLE_METHODS.has(method)) {
    return { retry: false, delayMs: 0, reason: 'not_repeatable' }
  }

  const isTransport = input.statusCode === 0
  const isThrottled = input.statusCode === 429
  const isUpstream = RETRYABLE_STATUS.has(input.statusCode) && !isThrottled

  if (!isTransport && !isThrottled && !isUpstream) {
    return { retry: false, delayMs: 0, reason: 'not_retryable' }
  }

  const reason: RetryDecision['reason'] = isTransport
    ? 'transport'
    : isThrottled
      ? 'throttled'
      : 'upstream_unavailable'

  if (input.attempt >= SKV_MAX_ATTEMPTS) {
    return { retry: false, delayMs: 0, reason: 'attempts_exhausted' }
  }

  return { retry: true, delayMs: backoffMs(input), reason }
}

function backoffMs(input: RetryInput): number {
  // The provider's own Retry-After wins when it sent one — it knows when its
  // quota window resets and we do not.
  if (input.retryAfterSeconds != null && Number.isFinite(input.retryAfterSeconds)) {
    return Math.min(MAX_DELAY_MS, Math.max(0, Math.ceil(input.retryAfterSeconds * 1000)))
  }

  const random = input.random ?? Math.random
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (input.attempt - 1))
  // Full jitter: uniform in [0, ceiling]. Retrying at a fixed delay would line
  // up every instance that failed at the same moment.
  return Math.floor(random() * ceiling)
}

/** Parses a `Retry-After` header value (delta-seconds or HTTP-date). */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds)
  const at = Date.parse(value)
  if (Number.isNaN(at)) return null
  return Math.max(0, Math.ceil((at - now) / 1000))
}
