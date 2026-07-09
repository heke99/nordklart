/**
 * Recurring invoice cron: secret enforcement + DB-claim idempotency +
 * per-schedule failure isolation.
 *
 * The idempotency contract: the cron INSERTs a claim row in
 * recurring_invoice_runs before spawning; a unique violation means the run
 * date is already claimed (running/succeeded → skip, failed → CAS takeover).
 * The unique index itself is covered in tests/pg/recurring-invoice-runs.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse } from '@/tests/helpers'

process.env.CRON_SECRET = 'test-cron-secret'

type QueryResult = { data?: unknown; error?: unknown }
const calls: Array<{ table: string; method: string; payload?: unknown }> = []
let queue: QueryResult[] = []

function chain(table: string): Record<string, unknown> {
  const result = queue.shift() ?? { data: null, error: null }
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve(result)
        }
        return (...args: unknown[]) => {
          if (prop === 'insert' || prop === 'update') {
            calls.push({ table, method: String(prop), payload: args[0] })
          }
          return proxy
        }
      },
    },
  ) as Record<string, unknown>
  return proxy
}

const mockSupabase = {
  from: vi.fn((table: string) => chain(table)),
}

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => mockSupabase,
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

const executeMock = vi.fn()
vi.mock('@/lib/invoices/recurring-schedule-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/invoices/recurring-schedule-service')>()
  return {
    ...actual,
    executeRecurringSchedule: (...args: unknown[]) => executeMock(...args),
  }
})

import { GET } from '../route'

const todayIso = new Date().toISOString().slice(0, 10)

function makeSchedule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sched-1',
    company_id: 'company-1',
    user_id: 'user-1',
    customer_id: 'cust-1',
    name: 'Retainer',
    day_of_month: 15,
    payment_terms_days: 30,
    currency: 'SEK',
    auto_send: false,
    status: 'active',
    next_run_date: todayIso,
    last_run_at: null,
    last_invoice_id: null,
    last_run_warning: null,
    generated_count: 0,
    items: [{ id: 'item-1', schedule_id: 'sched-1', sort_order: 0, description: 'X', quantity: 1, unit: 'st', unit_price: 100, vat_rate: 25 }],
    ...overrides,
  }
}

function cronRequest(secret?: string) {
  return new Request('http://localhost:3000/api/invoices/recurring/cron', {
    headers: secret ? { authorization: `Bearer ${secret}` } : undefined,
  })
}

describe('GET /api/invoices/recurring/cron', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    queue = []
    calls.length = 0
  })

  it('rejects requests without the cron secret', async () => {
    const response = await GET(cronRequest())
    expect(response.status).toBe(401)
  })

  it('rejects requests with a wrong secret', async () => {
    const response = await GET(cronRequest('wrong-secret'))
    expect(response.status).toBe(401)
  })

  it('spawns one invoice per due schedule and finalizes run + schedule', async () => {
    executeMock.mockResolvedValue({ invoiceId: 'inv-1', invoiceNumber: 'F-100', autoSent: false, warning: null })
    queue = [
      { data: [makeSchedule()], error: null }, // due schedules
      { data: { id: 'run-1' }, error: null }, // claim insert
      { data: null, error: null }, // finalize run update
      { data: null, error: null }, // schedule update
    ]

    const response = await GET(cronRequest('test-cron-secret'))
    const { status, body } = await parseJsonResponse<{ spawned: number; failed: number }>(response)

    expect(status).toBe(200)
    expect(body.spawned).toBe(1)
    expect(body.failed).toBe(0)
    expect(executeMock).toHaveBeenCalledTimes(1)

    const claimInsert = calls.find((c) => c.table === 'recurring_invoice_runs' && c.method === 'insert')
    expect(claimInsert?.payload).toMatchObject({ schedule_id: 'sched-1', run_date: todayIso, status: 'running' })

    const finalize = calls.filter((c) => c.table === 'recurring_invoice_runs' && c.method === 'update')
    expect(finalize[0]?.payload).toMatchObject({ status: 'succeeded', invoice_id: 'inv-1' })

    const scheduleUpdate = calls.find((c) => c.table === 'recurring_invoice_schedules' && c.method === 'update')
    expect(scheduleUpdate?.payload).toMatchObject({ last_invoice_id: 'inv-1', generated_count: 1 })
  })

  it('does not spawn when the run date is already claimed as succeeded (retry idempotency)', async () => {
    queue = [
      { data: [makeSchedule()], error: null }, // due schedules
      { data: null, error: { code: '23505', message: 'duplicate' } }, // claim insert conflict
      { data: { id: 'run-1', status: 'succeeded' }, error: null }, // existing claim lookup
      { data: null, error: null }, // self-heal next_run_date advance
    ]

    const response = await GET(cronRequest('test-cron-secret'))
    const { status, body } = await parseJsonResponse<{ spawned: number; skipped: number }>(response)

    expect(status).toBe(200)
    expect(body.spawned).toBe(0)
    expect(body.skipped).toBe(1)
    expect(executeMock).not.toHaveBeenCalled()
  })

  it('does not spawn when a concurrent run holds the claim', async () => {
    queue = [
      { data: [makeSchedule()], error: null },
      { data: null, error: { code: '23505', message: 'duplicate' } },
      { data: { id: 'run-1', status: 'running' }, error: null },
    ]

    const response = await GET(cronRequest('test-cron-secret'))
    const { body } = await parseJsonResponse<{ spawned: number; skipped: number }>(response)
    expect(body.spawned).toBe(0)
    expect(body.skipped).toBe(1)
    expect(executeMock).not.toHaveBeenCalled()
  })

  it('takes over a previously failed claim and retries', async () => {
    executeMock.mockResolvedValue({ invoiceId: 'inv-2', invoiceNumber: 'F-101', autoSent: true, warning: null })
    queue = [
      { data: [makeSchedule()], error: null },
      { data: null, error: { code: '23505', message: 'duplicate' } }, // claim conflict
      { data: { id: 'run-1', status: 'failed' }, error: null }, // existing failed claim
      { data: [{ id: 'run-1' }], error: null }, // CAS takeover succeeds
      { data: null, error: null }, // finalize run
      { data: null, error: null }, // schedule update
    ]

    const response = await GET(cronRequest('test-cron-secret'))
    const { body } = await parseJsonResponse<{ spawned: number }>(response)
    expect(body.spawned).toBe(1)
    expect(executeMock).toHaveBeenCalledTimes(1)
  })

  it('isolates a failing schedule so the others still run', async () => {
    executeMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ invoiceId: 'inv-3', invoiceNumber: 'F-102', autoSent: false, warning: null })
    queue = [
      { data: [makeSchedule({ id: 'sched-1' }), makeSchedule({ id: 'sched-2' })], error: null },
      // schedule 1
      { data: { id: 'run-1' }, error: null }, // claim
      { data: null, error: null }, // finalize failed run
      // schedule 2
      { data: { id: 'run-2' }, error: null }, // claim
      { data: null, error: null }, // finalize succeeded run
      { data: null, error: null }, // schedule update
    ]

    const response = await GET(cronRequest('test-cron-secret'))
    const { body } = await parseJsonResponse<{ spawned: number; failed: number; succeeded: number }>(response)

    expect(body.failed).toBe(1)
    expect(body.spawned).toBe(1)

    const failedFinalize = calls.filter((c) => c.table === 'recurring_invoice_runs' && c.method === 'update')
    expect(failedFinalize[0]?.payload).toMatchObject({ status: 'failed', error: 'boom' })
  })

  it('does not leak tenant identifiers in the response body', async () => {
    executeMock.mockResolvedValue({ invoiceId: 'inv-1', invoiceNumber: 'F-100', autoSent: false, warning: null })
    queue = [
      { data: [makeSchedule()], error: null },
      { data: { id: 'run-1' }, error: null },
      { data: null, error: null },
      { data: null, error: null },
    ]

    const response = await GET(cronRequest('test-cron-secret'))
    const text = JSON.stringify(await response.clone().json())
    expect(text).not.toContain('company-1')
    expect(text).not.toContain('sched-1')
    expect(text).not.toContain('inv-1')
  })
})
