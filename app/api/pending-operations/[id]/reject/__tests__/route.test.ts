import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, enqueueMany, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { POST } from '../../reject/route'

describe('POST /api/pending-operations/:id/reject', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }
  const routeParams = createMockRouteParams({ id: 'op-1' })

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest('/api/pending-operations/op-1/reject', { method: 'POST' })
    const response = await POST(request, routeParams)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(401)
  })

  it('returns 404 when not found', async () => {
    enqueue({ data: null, error: { message: 'not found' } })

    const request = createMockRequest('/api/pending-operations/op-1/reject', { method: 'POST' })
    const response = await POST(request, routeParams)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(404)
  })

  it('returns 409 when already committed', async () => {
    enqueue({ data: { id: 'op-1', status: 'committed' } })

    const request = createMockRequest('/api/pending-operations/op-1/reject', { method: 'POST' })
    const response = await POST(request, routeParams)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(409)
    expect(body.error).toContain('already committed')
  })

  it('rejects successfully', async () => {
    enqueueMany([
      { data: { id: 'op-1', status: 'pending' } },   // fetch op
      { data: null, error: null },                     // update status
    ])

    const request = createMockRequest('/api/pending-operations/op-1/reject', { method: 'POST' })
    const response = await POST(request, routeParams)
    const { status, body } = await parseJsonResponse<{ data: { id: string; status: string } }>(response)

    expect(status).toBe(200)
    expect(body.data.status).toBe('rejected')
  })
})
