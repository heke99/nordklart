import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRouteParams } from '@/tests/helpers'

const mockRequireAuth = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: () => mockRequireAuth() }))

const mockRpc = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ rpc: (...a: unknown[]) => mockRpc(...a) }),
}))

import { POST } from '../route'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const FOUNDER = '22222222-2222-4222-8222-222222222222'

function authWithRole(role: unknown) {
  const q: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'is', 'limit']) q[m] = vi.fn().mockReturnValue(q)
  q.maybeSingle = vi.fn().mockResolvedValue({ data: role, error: null })
  mockRequireAuth.mockResolvedValue({ error: null, user: { id: 'admin-1' }, supabase: { from: () => q } })
}

const req = (body: unknown) => new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body) })
const valid = { user_id: FOUNDER, decision: 'verified', note: 'Kontrollerat mot registreringsbevis' }

beforeEach(() => vi.clearAllMocks())

describe('POST /api/platform/companies/[companyId]/founder-verification', () => {
  it('passes through an auth error', async () => {
    mockRequireAuth.mockResolvedValue({ error: new Response(null, { status: 401 }) })
    const res = await POST(req(valid), createMockRouteParams({ companyId: COMPANY }))
    expect(res.status).toBe(401)
  })

  it('is forbidden for non platform admins', async () => {
    authWithRole(null)
    const res = await POST(req(valid), createMockRouteParams({ companyId: COMPANY }))
    expect(res.status).toBe(403)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('validates the body', async () => {
    authWithRole({ role: 'platform_admin' })
    const res = await POST(req({ ...valid, decision: 'maybe' }), createMockRouteParams({ companyId: COMPANY }))
    expect(res.status).toBe(400)
  })

  it('records the decision', async () => {
    authWithRole({ role: 'platform_admin' })
    mockRpc.mockResolvedValue({ data: 'verified', error: null })
    const res = await POST(req(valid), createMockRouteParams({ companyId: COMPANY }))
    expect(res.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('platform_decide_founder_verification', expect.objectContaining({
      p_company_id: COMPANY, p_user_id: FOUNDER, p_decision: 'verified', p_actor: 'admin-1',
    }))
  })

  it('returns 409 when nobody awaits review', async () => {
    authWithRole({ role: 'platform_admin' })
    mockRpc.mockResolvedValue({ data: null, error: { code: '55000' } })
    const res = await POST(req(valid), createMockRouteParams({ companyId: COMPANY }))
    expect(res.status).toBe(409)
  })
})
