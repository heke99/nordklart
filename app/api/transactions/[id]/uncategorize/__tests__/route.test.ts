import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

const mockReverseEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  reverseEntry: (...args: unknown[]) => mockReverseEntry(...args),
}))

import { POST } from '../route'

describe('POST /api/transactions/[id]/uncategorize', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest('/api/transactions/tx-1/uncategorize', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 404 when transaction not found', async () => {
    enqueue({ data: null, error: { message: 'Not found' } })

    const request = createMockRequest('/api/transactions/tx-999/uncategorize', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'tx-999' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(404)
    expect(body).toEqual({ error: 'Transaction not found' })
  })

  it('returns 400 when transaction has no journal entry', async () => {
    enqueue({ data: { id: 'tx-1', journal_entry_id: null }, error: null })

    const request = createMockRequest('/api/transactions/tx-1/uncategorize', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(400)
    expect(body).toEqual({ error: 'Transaction has no journal entry' })
  })

  it('returns 400 when journal entry is not posted', async () => {
    enqueue({ data: { id: 'tx-1', journal_entry_id: 'je-1' }, error: null })
    enqueue({ data: { id: 'je-1', status: 'draft' }, error: null })

    const request = createMockRequest('/api/transactions/tx-1/uncategorize', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(400)
    expect(body).toEqual({ error: 'Journal entry is not posted' })
  })

  it('returns 500 when reversal fails', async () => {
    enqueue({ data: { id: 'tx-1', journal_entry_id: 'je-1' }, error: null })
    enqueue({ data: { id: 'je-1', status: 'posted' }, error: null })
    mockReverseEntry.mockRejectedValue(new Error('Period is locked'))

    const request = createMockRequest('/api/transactions/tx-1/uncategorize', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(500)
    expect(body).toEqual({ error: 'Period is locked' })
  })

  it('returns 200 and reverses entry on success', async () => {
    enqueue({ data: { id: 'tx-1', journal_entry_id: 'je-1' }, error: null })
    enqueue({ data: { id: 'je-1', status: 'posted' }, error: null })
    mockReverseEntry.mockResolvedValue({ id: 'je-reversal' })
    enqueue({ data: { id: 'tx-1' }, error: null })

    const request = createMockRequest('/api/transactions/tx-1/uncategorize', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(body).toEqual({ success: true })
    expect(mockReverseEntry).toHaveBeenCalledWith(mockSupabase, 'company-1', 'user-1', 'je-1')
  })
})
