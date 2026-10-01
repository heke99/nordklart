import { createMockRouteParams } from '@/tests/helpers'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockAuth = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    from: vi.fn(),
    auth: { getUser: () => mockAuth() },
  }),
  createServiceClient: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/platform/entitlements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/entitlements')>()
  return { ...actual, checkFeatureAccess: vi.fn().mockResolvedValue({ allowed: true }) }
})

const mockSuggest = vi.fn()
vi.mock('@/lib/supplier-invoices/booking-proposal', () => ({
  suggestAccountsForSupplier: (...args: unknown[]) => mockSuggest(...args),
}))

import { GET } from '../route'

const SUPPLIER_ID = '11111111-1111-4111-8111-111111111111'
const url = (q: string) => new Request(`http://localhost/api/supplier-invoices/booking-proposal${q}`)

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({ data: { user: { id: 'user-1' } } })
})

describe('GET /api/supplier-invoices/booking-proposal', () => {
  it('returns 401 when not authenticated', async () => {
    mockAuth.mockResolvedValue({ data: { user: null } })
    const res = await GET(url(`?supplier_id=${SUPPLIER_ID}`), createMockRouteParams({}))
    expect(res.status).toBe(401)
    expect(mockSuggest).not.toHaveBeenCalled()
  })

  it('returns 400 without a valid supplier id', async () => {
    const res = await GET(url('?supplier_id=nope'), createMockRouteParams({}))
    expect(res.status).toBe(400)
    expect(mockSuggest).not.toHaveBeenCalled()
  })

  it('returns the suggestion for the active company', async () => {
    const suggestion = { byVatRate: { '0.25': '6110' }, primary: '6110', primarySource: 'history_any_rate', historyLines: 2, supplier: null }
    mockSuggest.mockResolvedValue(suggestion)
    const res = await GET(url(`?supplier_id=${SUPPLIER_ID}`), createMockRouteParams({}))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: suggestion })
    expect(mockSuggest).toHaveBeenCalledWith(expect.anything(), 'company-1', SUPPLIER_ID)
  })

  it('returns 500 when the lookup fails', async () => {
    mockSuggest.mockRejectedValue(new Error('boom'))
    const res = await GET(url(`?supplier_id=${SUPPLIER_ID}`), createMockRouteParams({}))
    expect(res.status).toBe(500)
  })
})
