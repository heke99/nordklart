import { emptyRouteParams } from '@/tests/helpers'
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

import { GET, PATCH } from '../route'
import { getActiveCompanyId } from '@/lib/company/context'

function mockChain(result: { data?: unknown; error?: unknown }) {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'update', 'upsert', 'single', 'maybeSingle']) {
    chain[m] = vi.fn().mockReturnValue(chain)
  }
  chain.single = vi.fn().mockResolvedValue(result)
  chain.maybeSingle = vi.fn().mockResolvedValue(result)
  chain.then = (resolve: (v: unknown) => void) => resolve(result)
  return chain
}

function patchRequest(body: unknown) {
  return new Request('http://localhost/api/company/current', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireWrite.mockResolvedValue({ ok: true })
})

describe('GET /api/company/current', () => {
  it('returns 401 when not authenticated', async () => {
    mockAuth.mockResolvedValue({ data: { user: null } })

    const response = await GET()

    expect(response.status).toBe(401)
  })

  // The whole point of this route: CompanyTabSync compares the value against
  // the company the tab is rendering and reloads on mismatch. A user with no
  // resolvable company must get 200 + null, NOT an error — an error is what
  // the client treats as "network trouble, do nothing", which would leave a
  // tab open on a company the user can no longer read.
  it('returns 200 with companyId: null when no company resolves', async () => {
    mockAuth.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    vi.mocked(getActiveCompanyId).mockResolvedValueOnce(null)

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.companyId).toBeNull()
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('returns the active company id', async () => {
    mockAuth.mockResolvedValue({ data: { user: { id: 'user-1' } } })

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.companyId).toBe('company-1')
  })
})

describe('PATCH /api/company/current', () => {
  it('returns 401 when not authenticated', async () => {
    mockAuth.mockResolvedValue({ data: { user: null } })

    const response = await PATCH(patchRequest({ accounting_framework: 'k2' }), emptyRouteParams())

    expect(response.status).toBe(401)
  })

  it('rejects a viewer', async () => {
    mockAuth.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mockRequireWrite.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }),
    })

    const response = await PATCH(patchRequest({ accounting_framework: 'k3' }), emptyRouteParams())

    expect(response.status).toBe(403)
  })

  it('rejects K3 for a non-aktiebolag', async () => {
    mockAuth.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mockFrom.mockReturnValue(mockChain({ data: { entity_type: 'enskild_firma' }, error: null }))

    const response = await PATCH(patchRequest({ accounting_framework: 'k3' }), emptyRouteParams())
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.error).toContain('endast aktiebolag')
  })

  it('applies the framework for an aktiebolag', async () => {
    mockAuth.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mockFrom
      .mockReturnValueOnce(mockChain({ data: { entity_type: 'aktiebolag' }, error: null }))
      .mockReturnValueOnce(mockChain({
        data: { id: 'company-1', accounting_framework: 'k2', entity_type: 'aktiebolag' },
        error: null,
      }))

    const response = await PATCH(patchRequest({ accounting_framework: 'k2' }), emptyRouteParams())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.accounting_framework).toBe('k2')
  })
})
