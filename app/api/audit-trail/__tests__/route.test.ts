import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

vi.mock('@/lib/core/audit/audit-service', () => ({
  getAuditLog: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { createClient } from '@/lib/supabase/server'
import { getAuditLog } from '@/lib/core/audit/audit-service'
import { GET } from '../route'

const mockCreateClient = vi.mocked(createClient)
const mockGetAuditLog = vi.mocked(getAuditLog)

function mockAuth(userId: string | null) {
  mockCreateClient.mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: userId ? { id: userId } : null },
      }),
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/audit-trail', () => {
  it('returns 401 when not authenticated', async () => {
    mockAuth(null)
    const req = createMockRequest('/api/audit-trail')
    const { status, body } = await parseJsonResponse(await GET(req))
    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns audit log with data and count', async () => {
    mockAuth('user-1')
    const entries = [
      { id: '1', action: 'INSERT', table_name: 'journal_entries', created_at: '2024-01-01T00:00:00Z' },
      { id: '2', action: 'COMMIT', table_name: 'journal_entries', created_at: '2024-01-02T00:00:00Z' },
    ]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetAuditLog.mockResolvedValue({ data: entries as any, count: 2 })

    const req = createMockRequest('/api/audit-trail')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { status, body } = await parseJsonResponse<{ data: any[]; count: number }>(await GET(req))

    expect(status).toBe(200)
    expect(body.data).toHaveLength(2)
    expect(body.count).toBe(2)
    expect(mockGetAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      expect.objectContaining({})
    )
  })

  it('passes query param filters to getAuditLog', async () => {
    mockAuth('user-1')
    mockGetAuditLog.mockResolvedValue({ data: [], count: 0 })

    const req = createMockRequest('/api/audit-trail', {
      searchParams: {
        action: 'INSERT',
        table_name: 'journal_entries',
        record_id: 'rec-1',
        from_date: '2024-01-01',
        to_date: '2024-12-31',
        page: '2',
        page_size: '25',
      },
    })

    await GET(req)

    expect(mockGetAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      {
        action: 'INSERT',
        table_name: 'journal_entries',
        record_id: 'rec-1',
        from_date: '2024-01-01',
        to_date: '2024-12-31',
        page: 2,
        pageSize: 25,
      }
    )
  })

  it('returns 500 on service error', async () => {
    mockAuth('user-1')
    mockGetAuditLog.mockRejectedValue(new Error('DB error'))

    const req = createMockRequest('/api/audit-trail')
    const { status, body } = await parseJsonResponse(await GET(req))

    expect(status).toBe(500)
    expect(body).toEqual({ error: 'DB error' })
  })
})
