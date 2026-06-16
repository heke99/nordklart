import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../route'

describe('GET /api/pending-operations', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  const sampleOps = [
    {
      id: 'op-1',
      user_id: 'user-1',
      operation_type: 'categorize_transaction',
      status: 'pending',
      title: 'Kategorisera: CLAS OHLSON -523 SEK',
      params: { transaction_id: 'tx-1', category: 'expense_office' },
      preview_data: { debit_account: '6100', credit_account: '1930', amount: 523 },
      result_data: null,
      created_at: '2026-03-25T10:00:00Z',
    },
    {
      id: 'op-2',
      user_id: 'user-1',
      operation_type: 'create_customer',
      status: 'pending',
      title: 'Ny kund: Acme AB',
      params: { name: 'Acme AB', customer_type: 'swedish_business' },
      preview_data: { name: 'Acme AB', customer_type: 'swedish_business' },
      result_data: null,
      created_at: '2026-03-25T10:01:00Z',
    },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest('/api/pending-operations')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns pending operations', async () => {
    enqueue({ data: sampleOps, count: 2 })

    const request = createMockRequest('/api/pending-operations')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse<{
      data: typeof sampleOps
      count: number
    }>(response)

    expect(status).toBe(200)
    expect(body.data).toHaveLength(2)
    expect(body.count).toBe(2)
  })

  it('filters by status parameter', async () => {
    enqueue({ data: [], count: 0 })

    const request = createMockRequest('/api/pending-operations', {
      searchParams: { status: 'committed' },
    })
    const response = await GET(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
  })

  it('rejects invalid status parameter', async () => {
    const request = createMockRequest('/api/pending-operations', {
      searchParams: { status: 'invalid' },
    })
    const response = await GET(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
  })
})
