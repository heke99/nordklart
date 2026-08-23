import { createMockRouteParams } from '@/tests/helpers'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFrom = vi.fn()
const mockAuth = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    from: (...args: unknown[]) => mockFrom(...args),
    auth: { getUser: () => mockAuth() },
  }),
  createServiceClient: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const mockRequireWrite = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => mockRequireWrite(...args),
}))

const mockCheckFeatureAccess = vi.fn()
vi.mock('@/lib/platform/entitlements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/entitlements')>()
  return {
    ...actual,
    checkFeatureAccess: (...args: unknown[]) => mockCheckFeatureAccess(...args),
  }
})

import { GET } from '../route'
import { POST } from '../mark-paid/route'

function mockChain(result: { data?: unknown; error?: unknown }) {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'update', 'single', 'maybeSingle']) {
    chain[m] = vi.fn().mockReturnValue(chain)
  }
  chain.single = vi.fn().mockResolvedValue(result)
  chain.maybeSingle = vi.fn().mockResolvedValue(result)
  chain.then = (resolve: (v: unknown) => void) => resolve(result)
  return chain
}

const url = 'http://localhost/api/skatteverket/tax-payments/2026-04'

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireWrite.mockResolvedValue({ ok: true })
  mockCheckFeatureAccess.mockResolvedValue({ allowed: true })
})

describe('GET /api/skatteverket/tax-payments/[period]', () => {
  it('returns 401 when not authenticated', async () => {
    mockAuth.mockResolvedValue({ data: { user: null } })

    const response = await GET(new Request(url), createMockRouteParams({ period: '2026-04' }))

    expect(response.status).toBe(401)
  })

  // The gate this route enforced by hand before it moved to withRouteContext.
  // The wrapper must resolve the SAME feature — bookkeeping.core — or the
  // conversion silently opened a paid surface.
  it('returns the feature error when bookkeeping.core is not entitled', async () => {
    mockAuth.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mockCheckFeatureAccess.mockResolvedValue({ allowed: false, reason: 'not_included' })

    const response = await GET(new Request(url), createMockRouteParams({ period: '2026-04' }))

    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(mockCheckFeatureAccess).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'bookkeeping.core',
    )
  })

  it('rejects a malformed period', async () => {
    mockAuth.mockResolvedValue({ data: { user: { id: 'user-1' } } })

    const response = await GET(new Request(url), createMockRouteParams({ period: 'april' }))

    expect(response.status).toBe(400)
  })

  it('returns null data when the period has no AGI', async () => {
    mockAuth.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mockFrom.mockReturnValue(mockChain({ data: null, error: null }))

    const response = await GET(new Request(url), createMockRouteParams({ period: '2026-04' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data).toBeNull()
  })

  it('returns the AGI payment fields', async () => {
    mockAuth.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mockFrom.mockReturnValue(mockChain({
      data: { total_tax: 1000, total_avgifter: 314, tax_paid_at: null },
      error: null,
    }))

    const response = await GET(new Request(url), createMockRouteParams({ period: '2026-04' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.total_tax).toBe(1000)
  })
})

describe('POST /api/skatteverket/tax-payments/[period]/mark-paid', () => {
  it('rejects a viewer', async () => {
    mockAuth.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mockRequireWrite.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }),
    })

    const response = await POST(
      new Request(`${url}/mark-paid`, { method: 'POST' }),
      createMockRouteParams({ period: '2026-04' }),
    )

    expect(response.status).toBe(403)
  })

  it('returns 404 when the period has no AGI', async () => {
    mockAuth.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mockFrom.mockReturnValue(mockChain({ data: null, error: null }))

    const response = await POST(
      new Request(`${url}/mark-paid`, { method: 'POST' }),
      createMockRouteParams({ period: '2026-04' }),
    )

    expect(response.status).toBe(404)
  })

  it('marks the period paid', async () => {
    mockAuth.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mockFrom.mockReturnValue(mockChain({ data: { id: 'agi-1' }, error: null }))

    const response = await POST(
      new Request(`${url}/mark-paid`, { method: 'POST' }),
      createMockRouteParams({ period: '2026-04' }),
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.ok).toBe(true)
  })
})
