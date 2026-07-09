/**
 * POST /api/bankid/consents/[sessionId]/cancel — pending-only cancel.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const cancelConsentSessionMock = vi.fn()
vi.mock('@/lib/auth/consent-service', () => ({
  cancelConsentSession: (...args: unknown[]) => cancelConsentSessionMock(...args),
}))

import { POST } from '../route'

const mockUser = { id: 'user-1', email: 'test@test.se' }
const routeParams = { params: Promise.resolve({ sessionId: 'session-1' }) }

describe('POST /api/bankid/consents/[sessionId]/cancel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when unauthenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const response = await POST(createMockRequest('/api/bankid/consents/session-1/cancel', { method: 'POST' }), routeParams)
    expect(response.status).toBe(401)
    expect(cancelConsentSessionMock).not.toHaveBeenCalled()
  })

  it('cancels a pending session scoped to the caller', async () => {
    cancelConsentSessionMock.mockResolvedValue({ status: 'cancelled' })
    const response = await POST(createMockRequest('/api/bankid/consents/session-1/cancel', { method: 'POST' }), routeParams)
    const { status, body } = await parseJsonResponse<{ data: { status: string } }>(response)

    expect(status).toBe(200)
    expect(body.data.status).toBe('cancelled')
    expect(cancelConsentSessionMock).toHaveBeenCalledWith(expect.anything(), {
      sessionId: 'session-1',
      userId: 'user-1',
    })
  })

  it('returns 409 when the session is already completed (cannot cancel evidence)', async () => {
    cancelConsentSessionMock.mockRejectedValue(new Error('Sessionen är redan slutförd och kan inte avbrytas.'))
    const response = await POST(createMockRequest('/api/bankid/consents/session-1/cancel', { method: 'POST' }), routeParams)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)
    expect(status).toBe(409)
    expect(body.error).toContain('slutförd')
  })

  it('returns 404 when the session does not belong to the caller', async () => {
    cancelConsentSessionMock.mockRejectedValue(new Error('Signeringssessionen kunde inte hittas.'))
    const response = await POST(createMockRequest('/api/bankid/consents/session-1/cancel', { method: 'POST' }), routeParams)
    expect(response.status).toBe(404)
  })
})
