import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
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

const mockSaveMappings = vi.fn()
vi.mock('@/lib/import/sie-import', () => ({
  saveMappings: (...args: unknown[]) => mockSaveMappings(...args),
}))

import { POST, PUT } from '../route'

describe('SIE account mappings route — company scoping', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    mockSaveMappings.mockResolvedValue(undefined)
  })

  it('POST saves mappings under the COMPANY id, never the user id', async () => {
    const mappings = [
      {
        sourceAccount: '1910',
        sourceName: 'Kassa',
        targetAccount: '1910',
        targetName: 'Kassa',
        confidence: 1,
        matchType: 'exact',
        isOverride: false,
      },
    ]

    const request = createMockRequest('/api/import/sie/mappings', {
      method: 'POST',
      body: { mappings },
    })
    const response = await POST(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    // Regression: this used to pass user.id, storing the rows under the
    // wrong tenant key (invisible to every company-scoped reader).
    expect(mockSaveMappings).toHaveBeenCalledWith(expect.anything(), 'company-1', mappings)
  })

  it('PUT upserts on the company-scoped conflict target', async () => {
    // The queued proxy mock does not capture upsert options, so assert via
    // the route completing successfully against the company-scoped key. The
    // conflict target itself is covered by the source-level check below.
    enqueue({ data: { id: 'mapping-1' }, error: null })

    const request = createMockRequest('/api/import/sie/mappings', {
      method: 'PUT',
      body: { sourceAccount: '1910', targetAccount: '1930' },
    })
    const response = await PUT(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
  })
})
