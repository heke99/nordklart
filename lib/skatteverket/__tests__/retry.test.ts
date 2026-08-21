import { describe, expect, it } from 'vitest'
import { decideSkvRetry, parseRetryAfter, SKV_MAX_ATTEMPTS } from '../retry'

const always = (v: number) => () => v

describe('decideSkvRetry', () => {
  it('never repeats a POST, whatever the failure', () => {
    // Skatteverket has no idempotency header: a POST that timed out may already
    // have created the filing, and a successful second one leaves two.
    for (const statusCode of [0, 429, 502, 503, 504]) {
      expect(decideSkvRetry({ method: 'POST', statusCode, attempt: 1 })).toEqual({
        retry: false, delayMs: 0, reason: 'not_repeatable',
      })
    }
  })

  it('retries a GET that never got a response', () => {
    const d = decideSkvRetry({ method: 'GET', statusCode: 0, attempt: 1, random: always(0.5) })
    expect(d.retry).toBe(true)
    expect(d.reason).toBe('transport')
    expect(d.delayMs).toBeGreaterThan(0)
  })

  it('retries throttling and upstream unavailability, and nothing else', () => {
    for (const statusCode of [429, 502, 503, 504]) {
      expect(decideSkvRetry({ method: 'GET', statusCode, attempt: 1, random: always(0.5) }).retry).toBe(true)
    }
    // 400/401/403/404/500 are answers. Repeating them burns quota and delays
    // the real error.
    for (const statusCode of [400, 401, 403, 404, 409, 422, 500]) {
      expect(decideSkvRetry({ method: 'GET', statusCode, attempt: 1 })).toEqual({
        retry: false, delayMs: 0, reason: 'not_retryable',
      })
    }
  })

  it('stops at the attempt cap', () => {
    expect(
      decideSkvRetry({ method: 'GET', statusCode: 503, attempt: SKV_MAX_ATTEMPTS }),
    ).toEqual({ retry: false, delayMs: 0, reason: 'attempts_exhausted' })
  })

  it('grows the backoff ceiling exponentially and jitters below it', () => {
    const ceilings = [1, 2].map((attempt) =>
      decideSkvRetry({ method: 'GET', statusCode: 503, attempt, random: always(0.999) }).delayMs,
    )
    expect(ceilings[1]).toBeGreaterThan(ceilings[0])

    // Full jitter: a random draw of 0 means retry immediately, which is the
    // point — synchronised retries recreate the 429 they back off from.
    expect(
      decideSkvRetry({ method: 'GET', statusCode: 503, attempt: 2, random: always(0) }).delayMs,
    ).toBe(0)
  })

  it('lets the provider Retry-After win over our backoff', () => {
    const d = decideSkvRetry({
      method: 'GET', statusCode: 429, attempt: 1, retryAfterSeconds: 7, random: always(0.999),
    })
    expect(d.delayMs).toBe(7000)
  })

  it('caps even a very long Retry-After', () => {
    const d = decideSkvRetry({ method: 'GET', statusCode: 429, attempt: 1, retryAfterSeconds: 3600 })
    expect(d.delayMs).toBe(30_000)
  })
})

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-08-21T12:00:00Z')

  it('reads delta-seconds', () => {
    expect(parseRetryAfter('30', now)).toBe(30)
    expect(parseRetryAfter('0', now)).toBe(0)
  })

  it('reads an HTTP-date as seconds from now', () => {
    expect(parseRetryAfter('Fri, 21 Aug 2026 12:00:45 GMT', now)).toBe(45)
  })

  it('never goes negative on a date already past', () => {
    expect(parseRetryAfter('Fri, 21 Aug 2026 11:59:00 GMT', now)).toBe(0)
  })

  it('returns null for nothing usable', () => {
    expect(parseRetryAfter(null, now)).toBeNull()
    expect(parseRetryAfter(undefined, now)).toBeNull()
    expect(parseRetryAfter('soon', now)).toBeNull()
  })
})
