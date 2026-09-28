import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const rpc = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(() => ({ rpc })),
}))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/auth/rate-limit-durable', () => ({
  checkDurableRateLimit: vi.fn().mockResolvedValue({ ok: true }),
}))

import { requireAuth } from '@/lib/auth/require-auth'
import { checkDurableRateLimit } from '@/lib/auth/rate-limit-durable'
import { POST } from '../route'

const user = { id: 'user-1', email: 'anna@example.se' }

function post(body: unknown) {
  return POST(createMockRequest('/api/team/accept', { method: 'POST', body }) as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAuth).mockResolvedValue({ user, supabase: {} as never, error: null } as never)
  vi.mocked(checkDurableRateLimit).mockResolvedValue({ ok: true } as never)
})

describe('POST /api/team/accept', () => {
  it('returns the auth error (401 or MFA 403) unchanged', async () => {
    const denied = new Response(JSON.stringify({ code: 'mfa_enrollment_required' }), { status: 403 })
    vi.mocked(requireAuth).mockResolvedValue({ user: null, supabase: {} as never, error: denied } as never)
    const res = await post({ token: 'nordklart_inv_abcdefghijklmnop' })
    expect(res.status).toBe(403)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('rejects a missing token', async () => {
    const res = await post({})
    expect(res.status).toBe(400)
  })

  it('accepts a company invitation through the atomic RPC', async () => {
    rpc.mockResolvedValue({ data: { ok: true, type: 'company', company_id: 'c1', role: 'member' }, error: null })
    const res = await post({ token: 'nordklart_inv_abcdefghijklmnop' })
    const { status, body } = await parseJsonResponse<{ data: { type: string; companyId: string } }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual({ type: 'company', companyId: 'c1' })
    expect(rpc).toHaveBeenCalledWith('accept_invitation', expect.objectContaining({ p_user_id: 'user-1' }))
    expect(rpc.mock.calls[0][1].p_token_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('accepts an agency invitation', async () => {
    rpc.mockResolvedValue({ data: { ok: true, type: 'agency', agency_id: 'a1', company_id: null, role: 'accountant' }, error: null })
    const { body } = await parseJsonResponse<{ data: unknown }>(await post({ token: 'nordklart_inv_abcdefghijklmnop' }))
    expect(body.data).toEqual({ type: 'agency', agencyId: 'a1', companyId: null })
  })

  it.each([
    ['email_mismatch', 403],
    ['expired', 410],
    ['not_pending', 409],
    ['not_found', 404],
    ['membership_suspended', 403],
  ])('maps %s to %i', async (code, status) => {
    rpc.mockResolvedValue({ data: { ok: false, error: code }, error: null })
    const res = await post({ token: 'nordklart_inv_abcdefghijklmnop' })
    const parsed = await parseJsonResponse<{ code: string }>(res)
    expect(parsed.status).toBe(status)
    expect(parsed.body.code).toBe(code)
  })

  it('returns 503 when the RPC fails', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'XX000' } })
    const res = await post({ token: 'nordklart_inv_abcdefghijklmnop' })
    expect(res.status).toBe(503)
  })

  it('honours the rate limit', async () => {
    vi.mocked(checkDurableRateLimit).mockResolvedValue({ ok: false, response: new Response(null, { status: 429 }) } as never)
    const res = await post({ token: 'nordklart_inv_abcdefghijklmnop' })
    expect(res.status).toBe(429)
    expect(rpc).not.toHaveBeenCalled()
  })
})
