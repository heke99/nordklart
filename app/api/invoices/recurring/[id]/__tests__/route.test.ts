/**
 * /api/invoices/recurring/[id]: GET includes run history; PATCH replaces
 * items via the atomic replace_recurring_schedule_items RPC; DELETE removes
 * the schedule.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { GET, PATCH, DELETE } from '../route'

const mockUser = { id: 'user-1', email: 'test@test.se' }
const routeParams = { params: Promise.resolve({ id: 'sched-1' }) }

describe('/api/invoices/recurring/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('GET returns the schedule with run history', async () => {
    enqueue({ data: { id: 'sched-1', name: 'Retainer' }, error: null }) // schedule
    enqueue({
      data: [
        { id: 'run-1', run_date: '2026-08-15', status: 'succeeded', invoice: { id: 'inv-1', invoice_number: 'F-100', status: 'sent', total: 125 } },
      ],
      error: null,
    }) // runs

    const response = await GET(createMockRequest('/api/invoices/recurring/sched-1'), routeParams)
    const { status, body } = await parseJsonResponse<{ data: { id: string }; runs: Array<{ id: string }> }>(response)

    expect(status).toBe(200)
    expect(body.data.id).toBe('sched-1')
    expect(body.runs).toHaveLength(1)
    expect(body.runs[0].id).toBe('run-1')
  })

  it('PATCH replaces items through the atomic RPC', async () => {
    enqueue({ data: null, error: null }) // schedule field update (name)
    enqueue({ data: null, error: null }) // rpc replace items
    enqueue({ data: { id: 'sched-1', name: 'Nytt namn' }, error: null }) // refetch

    const response = await PATCH(
      createMockRequest('/api/invoices/recurring/sched-1', {
        method: 'PATCH',
        body: {
          name: 'Nytt namn',
          items: [{ description: 'Rad', quantity: 2, unit: 'st', unit_price: 100, vat_rate: 25 }],
        },
      }),
      routeParams,
    )
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(mockSupabase.rpc).toHaveBeenCalledWith('replace_recurring_schedule_items', {
      p_schedule_id: 'sched-1',
      p_company_id: 'company-1',
      p_items: [{ description: 'Rad', quantity: 2, unit: 'st', unit_price: 100, vat_rate: 25 }],
    })
  })

  it('PATCH maps the RPC tenant-guard error to 404', async () => {
    enqueue({ data: null, error: { code: 'P0002', message: 'Schemat hittades inte.' } }) // rpc error

    const response = await PATCH(
      createMockRequest('/api/invoices/recurring/sched-1', {
        method: 'PATCH',
        body: { items: [{ description: 'Rad', quantity: 1, unit: 'st', unit_price: 100 }] },
      }),
      routeParams,
    )
    const { status, body } = await parseJsonResponse<{ type: string }>(response)

    expect(status).toBe(404)
    expect(body.type).toBe('not_found')
  })

  it('DELETE removes the schedule', async () => {
    enqueue({ data: null, error: null })

    const response = await DELETE(
      createMockRequest('/api/invoices/recurring/sched-1', { method: 'DELETE' }),
      routeParams,
    )
    const { status, body } = await parseJsonResponse<{ success: boolean }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
  })
})
