import { beforeEach, describe, expect, it, vi } from 'vitest'

const createClientMock = vi.fn()
const createServiceClientMock = vi.fn()
const getActiveCompanyIdMock = vi.fn()
const resolveAccessMock = vi.fn()
const auditMock = vi.fn()
const validateBodyMock = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: (...args: unknown[]) => createClientMock(...args),
  createServiceClient: (...args: unknown[]) => createServiceClientMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: (...args: unknown[]) => getActiveCompanyIdMock(...args),
}))
vi.mock('@/lib/year-end/period-access', () => ({
  resolveFiscalPeriodAccess: (...args: unknown[]) => resolveAccessMock(...args),
  auditPlatformFiscalPeriodOperation: (...args: unknown[]) => auditMock(...args),
}))
vi.mock('@/lib/api/validate', () => ({
  validateBody: (...args: unknown[]) => validateBodyMock(...args),
}))

import { GET, POST } from '../route'

function sessionClient(user: { id: string } | null = { id: 'user-1' }) {
  return { auth: { getUser: vi.fn().mockResolvedValue({ data: { user } }) } }
}

function serviceClient(periods: unknown[] = [], rpcResult: unknown = { id: 'period-1' }) {
  const inSpy = vi.fn()
  const orderResult = { data: periods, error: null }
  const query = {
    in: inSpy.mockResolvedValue(orderResult),
    then: (resolve: (value: typeof orderResult) => unknown) => Promise.resolve(resolve(orderResult)),
  }
  const order = vi.fn(() => query)
  const eq = vi.fn(() => ({ order }))
  const select = vi.fn(() => ({ eq }))
  return {
    client: {
      from: vi.fn(() => ({ select })),
      rpc: vi.fn().mockResolvedValue({ data: [rpcResult], error: null }),
    },
    inSpy,
  }
}

const allowed = {
  allowed: true,
  canWrite: true,
  canCreateFiscalYear: true,
  companyExists: true,
  accessSource: 'feature_entitlement',
  allowedPeriodIds: null,
}

describe('/api/bookkeeping/fiscal-periods', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createClientMock.mockResolvedValue(sessionClient())
    getActiveCompanyIdMock.mockResolvedValue('11111111-1111-4111-8111-111111111111')
    resolveAccessMock.mockResolvedValue(allowed)
    auditMock.mockResolvedValue(undefined)
    validateBodyMock.mockResolvedValue({
      success: true,
      data: { name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' },
    })
  })

  it('returns a real empty state rather than a generic fetch error', async () => {
    const { client } = serviceClient([])
    createServiceClientMock.mockReturnValue(client)
    const response = await GET(new Request('http://localhost/api/bookkeeping/fiscal-periods'))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'empty', periods: [], canCreateFiscalYear: true,
    })
  })

  it('rejects an invalid requested company id', async () => {
    const response = await GET(new Request('http://localhost/api/bookkeeping/fiscal-periods?company_id=bad'))
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'INVALID_COMPANY_ID' } })
  })

  it('denies a manipulated company id after canonical access resolution', async () => {
    const { client } = serviceClient([])
    createServiceClientMock.mockReturnValue(client)
    resolveAccessMock.mockResolvedValue({ ...allowed, allowed: false, reason: 'permission_denied' })
    const response = await GET(new Request(
      'http://localhost/api/bookkeeping/fiscal-periods?company_id=22222222-2222-4222-8222-222222222222',
    ))
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'PERMISSION_DENIED' } })
  })

  it('filters one-off customers to purchased periods', async () => {
    const { client, inSpy } = serviceClient([{ id: 'period-1' }])
    createServiceClientMock.mockReturnValue(client)
    resolveAccessMock.mockResolvedValue({ ...allowed, accessSource: 'one_time_purchase', allowedPeriodIds: ['period-1'] })
    const response = await GET(new Request('http://localhost/api/bookkeeping/fiscal-periods'))
    expect(response.status).toBe(200)
    expect(inSpy).toHaveBeenCalledWith('id', ['period-1'])
  })

  it('creates the fiscal year through the atomic service-only RPC', async () => {
    const { client } = serviceClient([], { id: 'period-1', name: '2026' })
    createServiceClientMock.mockReturnValue(client)
    const response = await POST(new Request('http://localhost/api/bookkeeping/fiscal-periods', {
      method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json' },
    }))
    expect(response.status).toBe(201)
    expect(client.rpc).toHaveBeenCalledWith('create_fiscal_year_atomic_internal', expect.objectContaining({
      p_company_id: '11111111-1111-4111-8111-111111111111',
      p_actor_user_id: 'user-1',
    }))
  })

  it('fails closed when the resolved role cannot write', async () => {
    const { client } = serviceClient([])
    createServiceClientMock.mockReturnValue(client)
    resolveAccessMock.mockResolvedValue({ ...allowed, canWrite: false })
    const response = await POST(new Request('http://localhost/api/bookkeeping/fiscal-periods', {
      method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json' },
    }))
    expect(response.status).toBe(403)
  })
})
