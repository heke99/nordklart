import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, parseJsonResponse } from '@/tests/helpers'

const mockCreateClient = vi.fn()
const mockCreateServiceClient = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => mockCreateClient(),
  createServiceClient: () => mockCreateServiceClient(),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
const mockRequireYearEndAccess = vi.fn()
vi.mock('@/lib/year-end/access', () => ({
  requireYearEndAccess: (...args: unknown[]) => mockRequireYearEndAccess(...args),
  yearEndAccessDeniedResponse: () => NextResponse.json({ error: { code: 'YEAR_END_ACCESS_DENIED' } }, { status: 403 }),
}))
const mockBookDecision = vi.fn()
const mockBookPayment = vi.fn()
vi.mock('@/lib/core/bookkeeping/dividend-service', async () => {
  const actual = (await vi.importActual('@/lib/core/bookkeeping/dividend-service')) as Record<string, unknown>
  return {
    ...actual,
    bookDividendDecision: (...args: unknown[]) => mockBookDecision(...args),
    bookDividendPayment: (...args: unknown[]) => mockBookPayment(...args),
  }
})

import { DividendError } from '@/lib/core/bookkeeping/dividend-service'

const user = { id: 'user-1', email: 'test@test.se' }

/** Service client whose from(table) resolves the next queued result for that table. */
function serviceDb(tables: Record<string, Array<{ data: unknown; error?: unknown }>>, rpc: Record<string, unknown> = {}) {
  return {
    from: vi.fn((table: string) => {
      const next = () => Promise.resolve({ error: null, ...(tables[table]?.shift() ?? { data: null }) })
      const builder: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'neq', 'in', 'order']) builder[m] = () => builder
      builder.maybeSingle = next
      builder.single = next
      builder.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => next().then(resolve, reject)
      return builder
    }),
    rpc: vi.fn(async (name: string) => ({ data: rpc[name] ?? 0, error: null })),
  }
}

const url = '/api/bookkeeping/fiscal-periods/period-1/dividend'
const params = () => createMockRouteParams({ id: 'period-1' })
const post = (body: unknown) => createMockRequest(url, { method: 'POST', body })
const proposal = { id: 'dp-1', total_amount: 40000, amount_per_share: 40, share_count: 1000, planned_payment_date: '2026-06-01', status: 'approved_for_annual_report' }
const decision = { id: 'dd-1', decision_date: '2026-05-15', decided_amount: 40000, payment_date: '2026-06-01', deviation_reason: null, journal_entry_id: 'je-1' }

beforeEach(() => {
  vi.clearAllMocks()
  mockCreateClient.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user } }) } })
  mockRequireYearEndAccess.mockResolvedValue({ allowed: true })
})

describe('GET /dividend', () => {
  it('returns 401 when unauthenticated', async () => {
    mockCreateClient.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) } })
    const { GET } = await import('../route')
    expect((await GET(createMockRequest(url), params())).status).toBe(401)
  })

  it('returns 403 when year-end access is denied', async () => {
    mockCreateServiceClient.mockReturnValue(serviceDb({}))
    mockRequireYearEndAccess.mockResolvedValue({ allowed: false, reason: 'missing_entitlement' })
    const { GET } = await import('../route')
    expect((await GET(createMockRequest(url), params())).status).toBe(403)
  })

  it('returns the proposal with the ABL 17:3 limit and prudence figures', async () => {
    mockCreateServiceClient.mockReturnValue(serviceDb(
      {
        fiscal_periods: [{ data: { id: 'period-1', period_end: '2025-12-31' } }],
        year_end_profit_dispositions: [{ data: { id: 'disp-1', free_equity: 140000 } }],
        dividend_proposals: [{ data: proposal }],
        dividend_decisions: [{ data: null }],
      },
      { dividend_distributable_amount: { distributable: 140000 }, __ledger_balance_at: 0 },
    ))
    const { GET } = await import('../route')
    const res = await GET(createMockRequest(url), params())
    const { body } = await parseJsonResponse<{ data: { limits: { distributable: number }; prudence: unknown; ku31: unknown } }>(res)
    expect(res.status).toBe(200)
    expect(body.data.limits.distributable).toBe(140000)
    expect(body.data.prudence).not.toBeNull()
    expect(body.data.ku31).toBeNull()
  })
})

describe('POST /dividend', () => {
  const stateWith = (p: unknown, d: unknown = null) =>
    serviceDb({
      year_end_profit_dispositions: [{ data: { id: 'disp-1' } }],
      dividend_proposals: [{ data: p }],
      dividend_decisions: [{ data: d }],
      dividend_payments: [{ data: [] }],
    })

  it('returns 400 on an invalid body', async () => {
    mockCreateServiceClient.mockReturnValue(stateWith(proposal))
    const { POST } = await import('../route')
    expect((await POST(post({ action: 'decide', decision_date: 'x', amount: -1 }), params())).status).toBe(400)
  })

  it('returns 404 when there is no dividend proposal', async () => {
    mockCreateServiceClient.mockReturnValue(stateWith(null))
    const { POST } = await import('../route')
    const res = await POST(post({ action: 'decide', decision_date: '2026-05-15', amount: 40000 }), params())
    expect(res.status).toBe(404)
    expect(mockBookDecision).not.toHaveBeenCalled()
  })

  it('books the decision for the period\'s proposal', async () => {
    mockCreateServiceClient.mockReturnValue(stateWith(proposal))
    mockBookDecision.mockResolvedValue({
      dividendDecisionId: 'dd-1', entry: { id: 'je-1' }, paymentDate: '2026-06-01', limits: {}, ku31: { incomeYear: 2026, dueDate: '2027-01-31' },
    })
    const { POST } = await import('../route')
    const res = await POST(post({ action: 'decide', decision_date: '2026-05-15', amount: 40000 }), params())
    expect(res.status).toBe(201)
    expect(mockBookDecision).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId: 'company-1', userId: 'user-1', dividendProposalId: 'dp-1', decisionDate: '2026-05-15', amount: 40000,
    }))
  })

  it('maps a legal refusal to its structured error', async () => {
    mockCreateServiceClient.mockReturnValue(stateWith(proposal))
    mockBookDecision.mockRejectedValue(new DividendError('DIVIDEND_EXCEEDS_DISTRIBUTABLE'))
    const { POST } = await import('../route')
    const res = await POST(post({ action: 'decide', decision_date: '2026-05-15', amount: 400000, deviation_reason: 'Minoritet' }), params())
    const { body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(res.status).toBe(409)
    expect(body.error.code).toBe('DIVIDEND_EXCEEDS_DISTRIBUTABLE')
  })

  it('returns 404 when paying before a decision exists', async () => {
    mockCreateServiceClient.mockReturnValue(stateWith(proposal, null))
    const { POST } = await import('../route')
    const res = await POST(post({ action: 'pay', payment_date: '2026-06-01', amount: 100 }), params())
    expect(res.status).toBe(404)
    expect(mockBookPayment).not.toHaveBeenCalled()
  })

  it('books a payment against the decision', async () => {
    mockCreateServiceClient.mockReturnValue(stateWith(proposal, decision))
    mockBookPayment.mockResolvedValue({ entry: { id: 'je-2' }, remaining: 15000 })
    const { POST } = await import('../route')
    const res = await POST(post({ action: 'pay', payment_date: '2026-06-01', amount: 25000 }), params())
    expect(res.status).toBe(201)
    expect(mockBookPayment).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ dividendDecisionId: 'dd-1', amount: 25000 }))
  })
})
