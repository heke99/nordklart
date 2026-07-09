/**
 * Sysorg API client audit trail: every request writes a
 * skatteverket_api_requests row that records WHICH Skatteverket environment
 * was targeted, plus correlation/request ids and the outcome.
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
      return {
        eq: () => ({ then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }) }),
      }
    },
  }),
} as never

import { skvSysorgRequest } from '../client'

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }

describe('skvSysorgRequest audit rows', () => {
  beforeEach(() => {
    inserted.length = 0
    updated.length = 0
    process.env.SKV_APIGW_CLIENT_ID = 'gw-id'
    process.env.SKV_APIGW_CLIENT_SECRET = 'gw-secret'
    delete process.env.SKV_ENV
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'OK' }), { status: 200, headers: { 'content-type': 'application/json' } }),
    ) as never
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
    process.env = originalEnv
  })

  it('records the targeted environment on the audit row', async () => {
    const result = await skvSysorgRequest({
      service: 'momsdeklaration',
      method: 'POST',
      path: '/kontrollera/165560000167/202605',
      body: { summaMoms: 100 },
      operation: 'moms.kontrollera',
      supabase: mockSupabase,
      companyId: 'company-1',
      userId: 'user-1',
      requestId: 'req-1',
    })

    expect(result.ok).toBe(true)
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({
      table: 'skatteverket_api_requests',
      company_id: 'company-1',
      user_id: 'user-1',
      operation: 'moms.kontrollera',
      environment: 'test',
      auth_flow: 'ccg_sysorg',
      request_id: 'req-1',
      status: 'started',
    })
    expect(typeof inserted[0].correlation_id).toBe('string')
    // Finalization update recorded the outcome.
    expect(updated[0]).toMatchObject({ table: 'skatteverket_api_requests', status: 'succeeded' })
  })

  it('records environment=prod when SKV_ENV is prod', async () => {
    process.env.SKV_ENV = 'prod'
    // Point the prod base URL at the mocked fetch anyway (no real network).
    await skvSysorgRequest({
      service: 'momsdeklaration',
      method: 'GET',
      path: '/utkast/165560000167/202605',
      operation: 'moms.hamta_utkast',
      supabase: mockSupabase,
      companyId: 'company-1',
      userId: 'user-1',
    })
    expect(inserted[0]).toMatchObject({ environment: 'prod' })
  })
})
