/**
 * The retry loop around a sysorg call: what is repeated, what is not, and what
 * the request log says about it afterwards.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

vi.mock('../token', () => ({
  getSkvSysorgAccessToken: vi.fn().mockResolvedValue({
    accessToken: 'token-1',
    tokenType: 'Bearer',
    scope: 'momsdeklaration',
    expiresAt: Date.now() + 3600_000,
  }),
}))

vi.mock('@/lib/skatteverket/ombud', () => ({
  recordSkvOmbudObservation: vi.fn(),
  verdictFromResponse: () => null,
}))

const inserted: Array<Record<string, unknown>> = []
const updated: Array<Record<string, unknown>> = []

const mockSupabase = {
  from: (table: string) => ({
    insert: (row: Record<string, unknown>) => {
      inserted.push({ table, ...row })
      return { then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }) }
    },
    update: (row: Record<string, unknown>) => {
      updated.push({ table, ...row })
      const chain = {
        eq: () => chain,
        then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
      }
      return chain
    },
  }),
} as never

import { skvSysorgRequest } from '../client'

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }

function base(method: 'GET' | 'POST' = 'GET') {
  return {
    service: 'momsdeklaration' as const,
    method,
    path: '/deklaration/165560000167/202605',
    operation: 'moms.hamta',
    supabase: mockSupabase,
    companyId: 'company-1',
    userId: 'user-1',
  }
}

describe('skvSysorgRequest retries', () => {
  beforeEach(() => {
    // Full jitter with random()=0 means every backoff is 0 ms, so the loop runs
    // at full speed without fake timers getting in the way of the awaits.
    vi.spyOn(Math, 'random').mockReturnValue(0)
    inserted.length = 0
    updated.length = 0
    process.env.SKV_APIGW_CLIENT_ID = 'gw-id'
    process.env.SKV_APIGW_CLIENT_SECRET = 'gw-secret'
  })

  afterAll(() => {
    vi.restoreAllMocks()
    globalThis.fetch = originalFetch
    process.env = originalEnv
  })

  it('retries a 503 on a GET and succeeds on the next attempt', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('down', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200, headers: { 'content-type': 'application/json' },
        }),
      )
    globalThis.fetch = fetchMock as never

    const result = await skvSysorgRequest(base('GET'))

    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // One row per attempt, both under the same idempotency key, numbered.
    const starts = inserted.filter((r) => r.table === 'skatteverket_api_requests')
    expect(starts).toHaveLength(2)
    expect(starts[0].attempt_count).toBe(1)
    expect(starts[1].attempt_count).toBe(2)
    expect(starts[0].idempotency_key).toBe(starts[1].idempotency_key)
    expect(starts[0].idempotency_key).toEqual(expect.any(String))

    // The failed attempt carries when the retry was due.
    const retryMarks = updated.filter((r) => r.next_retry_at !== undefined)
    expect(retryMarks).toHaveLength(1)
  })

  it('does not retry a POST, even on a 503', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('down', { status: 503 }))
    globalThis.fetch = fetchMock as never

    const result = await skvSysorgRequest({ ...base('POST'), body: { summaMoms: 1 } })

    // Repeating a POST could file the same declaration twice; the caller gets
    // the 503 to act on instead.
    expect(result.ok).toBe(false)
    expect(result.status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(updated.filter((r) => r.next_retry_at !== undefined)).toHaveLength(0)
  })

  it('does not retry a 403', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('Behörighet saknas', { status: 403 }))
    globalThis.fetch = fetchMock as never

    const result = await skvSysorgRequest(base('GET'))

    expect(result.status).toBe(403)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('gives up after the attempt cap and returns the last response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('down', { status: 503 }))
    globalThis.fetch = fetchMock as never

    const result = await skvSysorgRequest(base('GET'))

    expect(result.status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('retries a transport failure and rethrows when the cap is reached', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('socket hang up'))
    globalThis.fetch = fetchMock as never

    await expect(skvSysorgRequest(base('GET'))).rejects.toThrow('socket hang up')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('rethrows a transport failure on a POST immediately', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('socket hang up'))
    globalThis.fetch = fetchMock as never

    await expect(
      skvSysorgRequest({ ...base('POST'), body: { summaMoms: 1 } }),
    ).rejects.toThrow('socket hang up')
    // A timed-out POST may already have been accepted by Skatteverket.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps a caller-supplied idempotency key across the attempts', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('down', { status: 503 })) as never

    await skvSysorgRequest({ ...base('GET'), idempotencyKey: 'agi-2026-05-run-7' })

    const starts = inserted.filter((r) => r.table === 'skatteverket_api_requests')
    expect(starts.map((r) => r.idempotency_key)).toEqual([
      'agi-2026-05-run-7', 'agi-2026-05-run-7', 'agi-2026-05-run-7',
    ])
  })
})
