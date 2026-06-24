import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

import { createClient, createServiceClient } from '@/lib/supabase/server'
import { GET } from '../route'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const mockCreateClient = vi.mocked(createClient)
const mockCreateServiceClient = vi.mocked(createServiceClient)

/**
 * Minimal Supabase mock. `memberCompanies` seeds the RLS-scoped client and
 * `platformCompanies` seeds the service-client lookup used to detect existing
 * companies outside the caller's memberships.
 */
function buildSupabase(opts: {
  user: { id: string } | null
  memberCompanies?: { data?: unknown; error?: unknown }
  platformCompanies?: { data?: unknown; error?: unknown }
}) {
  const makeClient = (result: { data?: unknown; error?: unknown }) => {
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'is', 'limit', 'order', 'maybeSingle']) {
      chain[m] = () => chain
    }
    ;(chain as { then?: unknown }).then = (resolve: (v: unknown) => void) => {
      resolve({ data: result.data ?? null, error: result.error ?? null })
    }
    return { from: vi.fn(() => chain) }
  }

  const memberClient = makeClient(opts.memberCompanies ?? {})
  const serviceClient = makeClient(opts.platformCompanies ?? opts.memberCompanies ?? {})

  return {
    supabase: {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: opts.user } }) },
      from: memberClient.from,
    },
    service: serviceClient,
  }
}

function mockClients(opts: Parameters<typeof buildSupabase>[0]) {
  const { supabase, service } = buildSupabase(opts)
  mockCreateClient.mockResolvedValue(supabase as never)
  mockCreateServiceClient.mockReturnValue(service as never)
  return { supabase, service }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/company/check-org-number', () => {
  it('returns 401 when unauthenticated', async () => {
    mockClients({ user: null })
    const res = await GET(createMockRequest('/api/company/check-org-number?org_number=5560125790'))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns 400 when org_number is missing', async () => {
    mockClients({ user: { id: 'u1' } })
    const res = await GET(createMockRequest('/api/company/check-org-number'))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(400)
  })

  it('returns exists:false for malformed org_number without querying', async () => {
    const { supabase } = mockClients({ user: { id: 'u1' } })
    const res = await GET(createMockRequest('/api/company/check-org-number?org_number=not-a-number'))
    const { status, body } = await parseJsonResponse<{
      data: { exists: boolean; companies: unknown[] }
    }>(res)
    expect(status).toBe(200)
    expect(body.data.exists).toBe(false)
    expect(body.data.companies).toEqual([])
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it("reports the user's own matching companies (account-scoped via RLS)", async () => {
    mockClients({
      user: { id: 'u1' },
      memberCompanies: { data: [{ id: 'c1', name: 'Acme AB' }] },
      platformCompanies: { data: { id: 'c1' } },
    })
    const res = await GET(createMockRequest('/api/company/check-org-number?org_number=556012-5790'))
    const { status, body } = await parseJsonResponse<{
      data: { exists: boolean; companies: { id: string; name: string }[] }
    }>(res)
    expect(status).toBe(200)
    expect(body.data.exists).toBe(true)
    expect(body.data.companies).toEqual([{ id: 'c1', name: 'Acme AB' }])
  })

  it('returns exists:false when the user has no company with that org number', async () => {
    mockClients({
      user: { id: 'u1' },
      memberCompanies: { data: [] },
      platformCompanies: { data: null },
    })
    const res = await GET(createMockRequest('/api/company/check-org-number?org_number=5560125790'))
    const { status, body } = await parseJsonResponse<{ data: { exists: boolean } }>(res)
    expect(status).toBe(200)
    expect(body.data.exists).toBe(false)
  })

  it('returns 500 when the query errors', async () => {
    mockClients({ user: { id: 'u1' }, memberCompanies: { error: { message: 'boom' } } })
    const res = await GET(createMockRequest('/api/company/check-org-number?org_number=5560125790'))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(500)
  })
})
