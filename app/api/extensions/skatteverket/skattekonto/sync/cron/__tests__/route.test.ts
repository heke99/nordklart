/**
 * Skattekonto sync cron (migrated to withCronContext): secret enforcement,
 * per-item isolation, and NO tenant identifiers in the response body.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse } from '@/tests/helpers'

process.env.CRON_SECRET = 'test-cron-secret'
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test'

type QueryResult = { data?: unknown; error?: unknown }
let queue: QueryResult[] = []

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => {
      const result = queue.shift() ?? { data: null, error: null }
      const proxy: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result)
            return () => proxy
          },
        },
      ) as Record<string, unknown>
      return proxy
    },
  }),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/extensions/context-factory', () => ({
  createExtensionContext: vi.fn(() => ({ companyId: 'company-1', userId: 'user-1' })),
}))

const syncMock = vi.fn()
vi.mock('@/extensions/general/skatteverket/lib/skattekonto-sync', () => ({
  syncSkattekonto: (...args: unknown[]) => syncMock(...args),
  SKATTEKONTO_LAST_SYNCED_AT_KEY: 'skattekonto_last_synced_at',
}))
vi.mock('@/extensions/general/skatteverket/lib/skattekonto-drift', () => ({
  computeSkattekontoDrift: vi.fn().mockResolvedValue(null),
  maybeAlertDrift: vi.fn(),
}))

import { GET } from '../route'

function cronRequest(secret?: string) {
  return new Request('http://localhost:3000/api/extensions/skatteverket/skattekonto/sync/cron', {
    headers: secret ? { authorization: `Bearer ${secret}` } : undefined,
  })
}

describe('GET skattekonto sync cron', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    queue = []
    process.env.SKATTEVERKET_ENABLED = 'true'
    syncMock.mockResolvedValue({ booked: 3, upcoming: 1 })
  })

  it('rejects requests without the cron secret', async () => {
    const response = await GET(cronRequest())
    expect(response.status).toBe(401)
  })

  it('no-ops when the extension is disabled', async () => {
    process.env.SKATTEVERKET_ENABLED = 'false'
    const response = await GET(cronRequest('test-cron-secret'))
    const { status, body } = await parseJsonResponse<{ processed: number }>(response)
    expect(status).toBe(200)
    expect(body.processed).toBe(0)
  })

  it('syncs connected companies and returns aggregates without tenant ids', async () => {
    queue = [
      { data: [{ user_id: 'user-1', company_id: 'company-1', expires_at: null, refresh_count: 0 }], error: null }, // tokens
      { data: null, error: null }, // cooldown lookup
    ]

    const response = await GET(cronRequest('test-cron-secret'))
    const { status, body } = await parseJsonResponse<{ processed: number; synced: number }>(response)

    expect(status).toBe(200)
    expect(body).toMatchObject({ processed: 1, synced: 1, errors: 0 })
    const text = JSON.stringify(body)
    expect(text).not.toContain('company-1')
    expect(text).not.toContain('user-1')
  })

  it('isolates a failing company so the others still sync', async () => {
    syncMock.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ booked: 1, upcoming: 0 })
    queue = [
      {
        data: [
          { user_id: 'user-1', company_id: 'company-1', expires_at: null, refresh_count: 0 },
          { user_id: 'user-2', company_id: 'company-2', expires_at: null, refresh_count: 0 },
        ],
        error: null,
      },
      { data: null, error: null }, // cooldown company-1
      { data: null, error: null }, // cooldown company-2
    ]

    const response = await GET(cronRequest('test-cron-secret'))
    const { body } = await parseJsonResponse<{ synced: number; errors: number }>(response)
    expect(body.synced).toBe(1)
    expect(body.errors).toBe(1)
  })
})
