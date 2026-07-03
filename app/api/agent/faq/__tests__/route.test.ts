import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const rpcMock = vi.fn()
const getUserMock = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () =>
    Promise.resolve({
      auth: { getUser: getUserMock },
      rpc: rpcMock,
    }),
}))

import { GET, POST } from '../route'

const mockUser = { id: 'user-1', email: 'test@test.se' }

interface StatusBody {
  data?: {
    enabled: boolean
    expected_entries: number
    indexed_entries: number
    db_seeded: boolean
    last_seeded_at: string | null
  }
  error?: string
}

interface TestBody {
  data?: {
    query: string
    low_confidence: boolean
    source: string
    matches: Array<{
      id: string
      confidence: number
      risk_level: string
      escalation: string | null
    }>
  }
  error?: string
}

beforeEach(() => {
  vi.clearAllMocks()
  getUserMock.mockResolvedValue({ data: { user: mockUser } })
  // Default: DB status RPC unavailable → route falls back to bundled dataset.
  rpcMock.mockResolvedValue({ data: null, error: { message: 'not seeded' } })
})

describe('GET /api/agent/faq', () => {
  it('returns 401 when not authenticated', async () => {
    getUserMock.mockResolvedValue({ data: { user: null } })
    const response = await GET()
    const { status } = await parseJsonResponse<StatusBody>(response)
    expect(status).toBe(401)
  })

  it('reports bundled dataset status when the DB is not seeded', async () => {
    const response = await GET()
    const { status, body } = await parseJsonResponse<StatusBody>(response)
    expect(status).toBe(200)
    expect(body.data?.enabled).toBe(true)
    expect(body.data?.expected_entries).toBe(460)
    expect(body.data?.indexed_entries).toBe(460)
    expect(body.data?.db_seeded).toBe(false)
  })

  it('prefers DB status when seeded', async () => {
    rpcMock.mockResolvedValue({
      data: [
        {
          entry_count: 450,
          last_seeded_at: '2026-07-07T12:00:00Z',
          last_updated_at: '2026-07-02T00:00:00Z',
        },
      ],
      error: null,
    })
    const response = await GET()
    const { status, body } = await parseJsonResponse<StatusBody>(response)
    expect(status).toBe(200)
    expect(body.data?.db_seeded).toBe(true)
    expect(body.data?.indexed_entries).toBe(450)
    expect(body.data?.last_seeded_at).toBe('2026-07-07T12:00:00Z')
  })
})

describe('POST /api/agent/faq', () => {
  it('returns 401 when not authenticated', async () => {
    getUserMock.mockResolvedValue({ data: { user: null } })
    const response = await POST(
      createMockRequest('/api/agent/faq', {
        method: 'POST',
        body: { question: 'Hur kopplar jag banken?' },
      }),
    )
    const { status } = await parseJsonResponse<TestBody>(response)
    expect(status).toBe(401)
  })

  it('validates the body', async () => {
    const response = await POST(
      createMockRequest('/api/agent/faq', { method: 'POST', body: { question: '' } }),
    )
    const { status } = await parseJsonResponse<TestBody>(response)
    expect(status).toBe(400)
  })

  it('returns matches for a known question', async () => {
    const response = await POST(
      createMockRequest('/api/agent/faq', {
        method: 'POST',
        body: { question: 'Hur kopplar jag banken?' },
      }),
    )
    const { status, body } = await parseJsonResponse<TestBody>(response)
    expect(status).toBe(200)
    expect(body.data?.low_confidence).toBe(false)
    expect(body.data?.matches[0]?.id).toBe('bank-001')
  })

  it('flags low confidence for unrelated questions', async () => {
    const response = await POST(
      createMockRequest('/api/agent/faq', {
        method: 'POST',
        body: { question: 'vad är meningen med livet egentligen' },
      }),
    )
    const { status, body } = await parseJsonResponse<TestBody>(response)
    expect(status).toBe(200)
    expect(body.data?.low_confidence).toBe(true)
  })
})
