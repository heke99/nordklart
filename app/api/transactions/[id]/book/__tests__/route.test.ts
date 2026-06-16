import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeTransaction,
  makeJournalEntry,
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

const mockCreateJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: (...args: unknown[]) => mockCreateJournalEntry(...args),
}))

import { POST } from '../route'

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'

describe('POST /api/transactions/[id]/book', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }
  const validBody = {
    fiscal_period_id: VALID_UUID,
    entry_date: '2025-01-15',
    description: 'Test booking',
    lines: [
      { account_number: '6200', debit_amount: 500, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 500 },
    ],
  }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest('/api/transactions/tx-1/book', {
      method: 'POST',
      body: validBody,
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 400 when missing required fields', async () => {
    const request = createMockRequest('/api/transactions/tx-1/book', {
      method: 'POST',
      body: { fiscal_period_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toBe('Validation failed')
  })

  it('returns 404 when transaction not found', async () => {
    enqueue({ data: null, error: { message: 'Not found' } })

    const request = createMockRequest('/api/transactions/tx-999/book', {
      method: 'POST',
      body: validBody,
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-999' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(404)
    expect(body.error).toBe('Transaction not found')
  })

  it('returns 409 when transaction already has a journal entry', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      journal_entry_id: 'je-existing',
    })
    enqueue({ data: tx, error: null })

    const request = createMockRequest('/api/transactions/tx-1/book', {
      method: 'POST',
      body: validBody,
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(409)
    expect(body.error).toBe('Transaction already has a journal entry')
  })

  it('returns 400 when journal entry creation fails (engine error)', async () => {
    const tx = makeTransaction({ id: 'tx-1', journal_entry_id: null })
    enqueue({ data: tx, error: null })

    mockCreateJournalEntry.mockRejectedValue(new Error('Entry is not balanced'))

    const request = createMockRequest('/api/transactions/tx-1/book', {
      method: 'POST',
      body: validBody,
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toBe('Entry is not balanced')
  })

  it('creates journal entry and links to transaction (happy path)', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -500,
      journal_entry_id: null,
    })
    const je = makeJournalEntry({ id: 'je-new' })

    // Fetch transaction
    enqueue({ data: tx, error: null })

    mockCreateJournalEntry.mockResolvedValue(je)

    // Update transaction
    enqueue({ data: null, error: null })

    const emitSpy = vi.spyOn(eventBus, 'emit')

    const request = createMockRequest('/api/transactions/tx-1/book', {
      method: 'POST',
      body: validBody,
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      journal_entry_id: string
      data: { id: string }
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_id).toBe('je-new')
    expect(body.data.id).toBe('je-new')

    expect(mockCreateJournalEntry).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', {
      fiscal_period_id: VALID_UUID,
      entry_date: '2025-01-15',
      description: 'Test booking',
      source_type: 'bank_transaction',
      source_id: 'tx-1',
      lines: validBody.lines,
    })

    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'transaction.categorized' })
    )
  })

  it('returns 500 when transaction update fails', async () => {
    const tx = makeTransaction({ id: 'tx-1', journal_entry_id: null })
    const je = makeJournalEntry({ id: 'je-new' })

    enqueue({ data: tx, error: null })
    mockCreateJournalEntry.mockResolvedValue(je)
    // Update fails
    enqueue({ data: null, error: { message: 'Update failed' } })

    const request = createMockRequest('/api/transactions/tx-1/book', {
      method: 'POST',
      body: validBody,
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(500)
    expect(body.error).toBe('Failed to update transaction')
  })
})
