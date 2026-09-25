import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, parseJsonResponse } from '@/tests/helpers'

const mockCreateClient = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => mockCreateClient(),
  createServiceClient: () => ({}),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
const mockRequireYearEndAccess = vi.fn()
vi.mock('@/lib/year-end/access', () => ({
  requireYearEndAccess: (...args: unknown[]) => mockRequireYearEndAccess(...args),
  yearEndAccessDeniedResponse: () => NextResponse.json({ error: { code: 'YEAR_END_ACCESS_DENIED' } }, { status: 403 }),
}))
const mockBook = vi.fn()
const mockBalances = vi.fn()
vi.mock('@/lib/bokslut/inventory/book-inventory-adjustment', async () => {
  const actual = (await vi.importActual('@/lib/bokslut/inventory/book-inventory-adjustment')) as Record<string, unknown>
  return {
    ...actual,
    bookInventoryAdjustment: (...args: unknown[]) => mockBook(...args),
    loadInventoryBalances: (...args: unknown[]) => mockBalances(...args),
  }
})

import { InventoryAdjustmentError } from '@/lib/bokslut/inventory/book-inventory-adjustment'

const user = { id: 'user-1', email: 'test@test.se' }
const openPeriod = { id: 'period-1', period_end: '2026-12-31', is_closed: false, locked_at: null }

function userClient(period: unknown, authed = true) {
  const builder: Record<string, unknown> = {}
  for (const m of ['select', 'eq']) builder[m] = () => builder
  builder.maybeSingle = () => Promise.resolve({ data: period, error: null })
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: authed ? user : null } }) },
    from: vi.fn(() => builder),
  }
}

const url = '/api/bookkeeping/fiscal-periods/period-1/inventory'
const params = () => createMockRouteParams({ id: 'period-1' })
const post = (body: unknown) => createMockRequest(url, { method: 'POST', body })
const count = { account: '1460', cost: 120000, method: 'lowest_value' }

beforeEach(() => {
  vi.clearAllMocks()
  mockCreateClient.mockResolvedValue(userClient(openPeriod))
  mockRequireYearEndAccess.mockResolvedValue({ allowed: true })
  mockBalances.mockResolvedValue({ '1460': 100000 })
})

describe('GET /inventory', () => {
  it('returns 401 when unauthenticated', async () => {
    mockCreateClient.mockResolvedValue(userClient(openPeriod, false))
    const { GET } = await import('../route')
    expect((await GET(createMockRequest(url), params())).status).toBe(401)
  })

  it('lists the booked balance per inventory account', async () => {
    const { GET } = await import('../route')
    const res = await GET(createMockRequest(url), params())
    const { body } = await parseJsonResponse<{ data: { accounts: Array<{ account: string; booked_balance: number; change_account: string }> } }>(res)
    expect(res.status).toBe(200)
    expect(body.data.accounts.find((a) => a.account === '1460')).toMatchObject({ booked_balance: 100000, change_account: '4960' })
  })
})

describe('POST /inventory', () => {
  it('returns 403 when year-end access is denied', async () => {
    mockRequireYearEndAccess.mockResolvedValue({ allowed: false, reason: 'no_write' })
    const { POST } = await import('../route')
    expect((await POST(post({ counts: [count] }), params())).status).toBe(403)
  })

  it('rejects a non-inventory account and duplicate accounts', async () => {
    const { POST } = await import('../route')
    expect((await POST(post({ counts: [{ ...count, account: '1930' }] }), params())).status).toBe(400)
    expect((await POST(post({ counts: [count, count] }), params())).status).toBe(400)
    expect(mockBook).not.toHaveBeenCalled()
  })

  it('returns 404 for an unknown period and refuses a closed one', async () => {
    const { POST } = await import('../route')
    mockCreateClient.mockResolvedValue(userClient(null))
    expect((await POST(post({ counts: [count] }), params())).status).toBe(404)
    mockCreateClient.mockResolvedValue(userClient({ ...openPeriod, is_closed: true }))
    expect((await POST(post({ counts: [count] }), params())).status).toBe(400)
    expect(mockBook).not.toHaveBeenCalled()
  })

  it('books the valued count at the balance date', async () => {
    mockBook.mockResolvedValue({ id: 'je-1' })
    const { POST } = await import('../route')
    const res = await POST(post({ counts: [{ ...count, method: 'alternative_97' }] }), params())
    expect(res.status).toBe(201)
    const [ctx, valuations] = mockBook.mock.calls[0]
    expect(ctx).toMatchObject({ companyId: 'company-1', fiscalPeriodId: 'period-1', balanceDate: '2026-12-31' })
    expect(valuations).toEqual([expect.objectContaining({ account: '1460', value: 116400, changeAccount: '4960' })])
  })

  it('returns 200 with no voucher when nothing changes', async () => {
    mockBook.mockResolvedValue(null)
    const { POST } = await import('../route')
    const res = await POST(post({ counts: [count] }), params())
    const { body } = await parseJsonResponse<{ data: { journal_entry: unknown } }>(res)
    expect(res.status).toBe(200)
    expect(body.data.journal_entry).toBeNull()
  })

  it('reports a concurrent count as a conflict', async () => {
    mockBook.mockRejectedValue(new InventoryAdjustmentError('INVENTORY_BALANCE_CHANGED'))
    const { POST } = await import('../route')
    const res = await POST(post({ counts: [count] }), params())
    const { body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(res.status).toBe(409)
    expect(body.error.code).toBe('INVENTORY_BALANCE_CHANGED')
  })
})
