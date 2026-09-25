import { createMockRouteParams } from '@/tests/helpers'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockAuth = vi.fn()
const mockServiceFrom = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    from: vi.fn(),
    auth: { getUser: () => mockAuth() },
  }),
  createServiceClient: vi.fn(() => ({ from: (...args: unknown[]) => mockServiceFrom(...args) })),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/platform/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/entitlements')>()),
  checkFeatureAccess: vi.fn().mockResolvedValue({ allowed: true }),
}))

const mockAccess = vi.fn()
vi.mock('@/lib/access/company', () => ({
  resolveCompanyAccess: (...args: unknown[]) => mockAccess(...args),
}))

import { PATCH } from '../route'

function chain(result: { data?: unknown; error?: unknown }) {
  const c: Record<string, ReturnType<typeof vi.fn> | unknown> = {}
  for (const m of ['select', 'eq', 'in', 'update', 'insert']) c[m] = vi.fn().mockReturnValue(c)
  c.maybeSingle = vi.fn().mockResolvedValue(result)
  c.then = (resolve: (v: unknown) => void) => resolve(result)
  return c as Record<string, ReturnType<typeof vi.fn>>
}

const url = 'http://localhost/api/company/agency-links/link-1'
const req = (body: unknown) => new Request(url, { method: 'PATCH', body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({ data: { user: { id: 'owner-1', email: 'o@x.se' } } })
  mockAccess.mockResolvedValue({ canManageCompany: true })
})

describe('PATCH /api/company/agency-links/[id]', () => {
  it('returns 401 without a user', async () => {
    mockAuth.mockResolvedValue({ data: { user: null } })
    const res = await PATCH(req({ action: 'approve' }), createMockRouteParams({ id: 'link-1' }))
    expect(res.status).toBe(401)
  })

  it('returns 403 for agency staff (no canManageCompany)', async () => {
    mockAccess.mockResolvedValue({ canManageCompany: false, accessSource: 'agency' })
    const res = await PATCH(req({ action: 'approve' }), createMockRouteParams({ id: 'link-1' }))
    expect(res.status).toBe(403)
    expect(mockServiceFrom).not.toHaveBeenCalled()
  })

  it('returns 400 on an unknown action', async () => {
    const res = await PATCH(req({ action: 'promote' }), createMockRouteParams({ id: 'link-1' }))
    expect(res.status).toBe(400)
  })

  it('approves only a pending link of the active company', async () => {
    const update = chain({ data: { id: 'link-1', agency_id: 'a1', status: 'active', access_level: 'review' }, error: null })
    mockServiceFrom.mockReturnValueOnce(update).mockReturnValue(chain({ data: null, error: null }))
    const res = await PATCH(req({ action: 'approve', access_level: 'review' }), createMockRouteParams({ id: 'link-1' }))
    expect(res.status).toBe(200)
    expect(update.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'active', access_level: 'review', approved_by_client_user_id: 'owner-1' }))
    expect(update.eq).toHaveBeenCalledWith('company_id', 'company-1')
    expect(update.in).toHaveBeenCalledWith('status', ['pending'])
  })

  it('returns 409 when the link was already handled', async () => {
    mockServiceFrom.mockReturnValue(chain({ data: null, error: null }))
    const res = await PATCH(req({ action: 'revoke' }), createMockRouteParams({ id: 'link-1' }))
    expect(res.status).toBe(409)
  })

  it('returns 500 on a database error', async () => {
    mockServiceFrom.mockReturnValue(chain({ data: null, error: { message: 'boom' } }))
    const res = await PATCH(req({ action: 'revoke' }), createMockRouteParams({ id: 'link-1' }))
    expect(res.status).toBe(500)
  })
})
