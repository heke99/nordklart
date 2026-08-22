import { beforeEach, describe, expect, it, vi } from 'vitest'

const { rpc, checkRateLimit } = vi.hoisted(() => ({
  rpc: vi.fn(),
  checkRateLimit: vi.fn(),
}))

vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: () => ({ rpc }),
}))
vi.mock('@/lib/auth/rate-limit-http', () => ({ checkRateLimit }))

import { checkDurableRateLimit } from '../rate-limit-durable'

const OPTS = {
  prefix: 'bankid:start',
  identifier: '203.0.113.0/24',
  maxRequests: 3,
  windowMs: 15_000,
}

describe('checkDurableRateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.UPSTASH_REDIS_REST_URL
    delete process.env.UPSTASH_REDIS_REST_TOKEN
  })

  it('delegates to Upstash when it is configured', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example'
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token'
    checkRateLimit.mockResolvedValue({ ok: true })

    const result = await checkDurableRateLimit(OPTS)

    expect(result.ok).toBe(true)
    expect(checkRateLimit).toHaveBeenCalledWith({
      prefix: 'bankid:start',
      identifier: '203.0.113.0/24',
      maxRequests: 3,
      windowMs: 15_000,
    })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('falls back to the database when Upstash is absent — never to no limit', async () => {
    rpc.mockResolvedValue({
      data: { allowed: true, limit: 3, remaining: 2, reset_at: new Date().toISOString() },
      error: null,
    })

    const result = await checkDurableRateLimit(OPTS)

    expect(result.ok).toBe(true)
    expect(checkRateLimit).not.toHaveBeenCalled()
    expect(rpc).toHaveBeenCalledWith('consume_rate_limit', {
      p_bucket: 'bankid:start',
      p_identifier: '203.0.113.0/24',
      p_max_requests: 3,
      p_window_seconds: 15,
    })
  })

  it('returns 429 with Retry-After derived from the window reset', async () => {
    const resetAt = new Date(Date.now() + 9_000).toISOString()
    rpc.mockResolvedValue({
      data: { allowed: false, limit: 3, remaining: 0, reset_at: resetAt },
      error: null,
    })

    const result = await checkDurableRateLimit({ ...OPTS, message: 'Vänta lite.' })

    expect(result.ok).toBe(false)
    expect(result.response!.status).toBe(429)
    const retryAfter = Number(result.response!.headers.get('Retry-After'))
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(9)
    expect(result.response!.headers.get('X-RateLimit-Limit')).toBe('3')
    await expect(result.response!.json()).resolves.toEqual({ error: 'Vänta lite.' })
  })

  it('fails closed when the database cannot answer', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'connection refused' } })

    const result = await checkDurableRateLimit(OPTS)

    // The endpoints behind this helper have a billable side effect. An
    // unavailable counter must stop the request, not wave it through.
    expect(result.ok).toBe(false)
    expect(result.response!.status).toBe(503)
  })
})
