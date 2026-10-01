import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { parseJsonResponse } from '@/tests/helpers'

const rpc = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: () => ({ rpc }),
}))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(),
}))

vi.mock('@/lib/auth/rate-limit-durable', () => ({
  checkDurableRateLimit: vi.fn().mockResolvedValue({ ok: true }),
}))

import { POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { checkDurableRateLimit } from '@/lib/auth/rate-limit-durable'

const user = { id: '11111111-1111-4111-8111-111111111111', email: 'a@test.se' }
const versionIds = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333']

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/legal/accept', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('POST /api/legal/accept', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireAuth).mockResolvedValue({ user: user as never, supabase: {} as never, error: null })
    vi.mocked(checkDurableRateLimit).mockResolvedValue({ ok: true } as never)
    rpc.mockResolvedValue({ data: { ok: true, accepted: 2, pending: 0 }, error: null })
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null as never,
      supabase: {} as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await POST(post({ versionIds }))
    expect(res.status).toBe(401)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('returns 429 when rate limited', async () => {
    vi.mocked(checkDurableRateLimit).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'rate' }, { status: 429 }),
    } as never)
    const res = await POST(post({ versionIds }))
    expect(res.status).toBe(429)
  })

  it('returns 400 for a body without version ids', async () => {
    expect((await POST(post({ versionIds: [] }))).status).toBe(400)
    expect((await POST(post({ versionIds: ['not-a-uuid'] }))).status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('records the acceptance for the authenticated user with request IP and user agent', async () => {
    const res = await POST(post({ versionIds }, { 'x-forwarded-for': '203.0.113.7, 10.0.0.1', 'user-agent': 'UA/1' }))
    const { status, body } = await parseJsonResponse<{ data: { accepted: boolean } }>(res)
    expect(status).toBe(200)
    expect(body.data.accepted).toBe(true)
    expect(rpc).toHaveBeenCalledWith('accept_legal_documents', {
      p_user_id: user.id,
      p_version_ids: versionIds,
      p_source: 'reacceptance',
      p_ip_address: '203.0.113.7',
      p_user_agent: 'UA/1',
    })
    expect(res.headers.get('set-cookie')).toContain('nordklart-legal-ack=;')
  })

  it('drops a malformed forwarded address instead of failing the insert', async () => {
    await POST(post({ versionIds }, { 'x-forwarded-for': 'not-an-ip' }))
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_ip_address: null })
  })

  it('returns 409 when a version is stale or documents remain', async () => {
    rpc.mockResolvedValue({ data: { ok: false, error: 'version_not_active' }, error: null })
    expect((await POST(post({ versionIds }))).status).toBe(409)
  })

  it('returns 500 when the database call fails', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'boom' } })
    const res = await POST(post({ versionIds }))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('boom')
  })
})
