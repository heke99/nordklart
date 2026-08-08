import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse, createMockRouteParams } from '@/tests/helpers'

/**
 * Finding #21 (2026-08-08): this route resolved the caller's platform role
 * without filtering `revoked_at`. `platform_roles` records revocation instead
 * of deleting the grant, so a revoked operator kept the ability to export a
 * company's operational report — org number, integration state, failure log.
 *
 * The fake below models the table honestly: rows carry `revoked_at`, and the
 * builder only drops revoked rows when the query actually asks it to. A route
 * that forgets the predicate therefore still sees the revoked grant, exactly as
 * production did.
 */

type RoleRow = { user_id: string; role: string; revoked_at: string | null }

let roleRows: RoleRow[] = []

function platformRolesBuilder() {
  let rows = roleRows
  const builder = {
    select: () => builder,
    eq: (col: string, value: unknown) => {
      rows = rows.filter((r) => (r as unknown as Record<string, unknown>)[col] === value)
      return builder
    },
    in: (col: string, values: unknown[]) => {
      rows = rows.filter((r) => values.includes((r as unknown as Record<string, unknown>)[col]))
      return builder
    },
    is: (col: string, value: null) => {
      rows = rows.filter((r) => (r as unknown as Record<string, unknown>)[col] === value)
      return builder
    },
    limit: () => builder,
    maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
  }
  return builder
}

/** Every other table the report touches — shape matters, contents do not. */
function dataBuilder(table: string) {
  const result = table === 'companies'
    ? {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Testbolaget AB',
      org_number: '556677-8899',
      entity_type: 'aktiebolag',
      created_at: '2026-01-01T00:00:00Z',
      archived_at: null,
    }
    : null
  const builder: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'in', 'is', 'order', 'limit']) {
    builder[method] = () => builder
  }
  builder.maybeSingle = async () => ({ data: result, error: null, count: 0 })
  builder.insert = async () => ({ error: null })
  builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null, count: 0 })
  return builder
}

const authSupabase = { from: (table: string) => (table === 'platform_roles' ? platformRolesBuilder() : dataBuilder(table)) }
const serviceClient = { from: (table: string) => dataBuilder(table) }

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => serviceClient,
}))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(),
}))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const mockUser = { id: 'user-1', email: 'support@nordklart.se' }

describe('GET /api/platform/companies/[companyId]/troubleshooting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    roleRows = []
    vi.mocked(requireAuth).mockResolvedValue({
      user: mockUser as never,
      supabase: authSupabase as never,
      error: null,
    })
  })

  it('exports the report for an active platform role', async () => {
    roleRows = [{ user_id: 'user-1', role: 'platform_support', revoked_at: null }]

    const response = await GET(new Request('http://localhost/x'), createMockRouteParams({ companyId: COMPANY_ID }))

    expect(response.status).toBe(200)
  })

  it('refuses a caller whose platform role has been revoked', async () => {
    roleRows = [{ user_id: 'user-1', role: 'platform_support', revoked_at: '2026-08-01T00:00:00Z' }]

    const response = await GET(new Request('http://localhost/x'), createMockRouteParams({ companyId: COMPANY_ID }))

    expect(response.status).toBe(403)
    const { body } = await parseJsonResponse<{ error: string }>(response)
    expect(body.error).toBe('Forbidden')
  })

  it('refuses a caller with no platform role at all', async () => {
    const response = await GET(new Request('http://localhost/x'), createMockRouteParams({ companyId: COMPANY_ID }))

    expect(response.status).toBe(403)
  })
})
