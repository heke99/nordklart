import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, createMockRouteParams, parseJsonResponse } from '@/tests/helpers'

const mockGetUser = vi.fn()
const mockFrom = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: () => mockGetUser() }, from: (...a: unknown[]) => mockFrom(...a) })),
  createServiceClient: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

const mockAccess = vi.fn()
vi.mock('@/lib/year-end/access', () => ({
  requireYearEndAccess: (...a: unknown[]) => mockAccess(...a),
  yearEndAccessDeniedResponse: vi.fn(() => new Response(JSON.stringify({ error: 'denied' }), { status: 403 })),
}))

const mockBook = vi.fn()
vi.mock('@/lib/core/bookkeeping/prior-period-correction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/bookkeeping/prior-period-correction')>()
  return { ...actual, bookPriorPeriodCorrection: (...a: unknown[]) => mockBook(...a) }
})

import { GET, POST } from '../route'
import { PriorPeriodCorrectionError } from '@/lib/core/bookkeeping/prior-period-correction'

const PERIOD = 'period-2025'
const url = `/api/bookkeeping/fiscal-periods/${PERIOD}/prior-period-correction`
const params = () => createMockRouteParams({ id: PERIOD })
const body = {
  method: 'current_year',
  fiscal_period_id: '22222222-2222-4222-8222-222222222222',
  entry_date: '2026-03-15',
  description: 'Ej bokförd faktura',
  reason: 'Fakturan från december hittades vid avstämningen i mars.',
  lines: [
    { account_number: '5410', debit_amount: 1000, credit_amount: 0 },
    { account_number: '2440', debit_amount: 0, credit_amount: 1000 },
  ],
}
const post = (b: unknown = body) => POST(createMockRequest(url, { method: 'POST', body: b }), params())

beforeEach(() => {
  vi.clearAllMocks()
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
  mockAccess.mockResolvedValue({ allowed: true })
})

describe('POST prior-period-correction', () => {
  it('returns 401 when not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    expect((await post()).status).toBe(401)
    expect(mockBook).not.toHaveBeenCalled()
  })

  it('returns 400 for a short reason or a single line', async () => {
    expect((await post({ ...body, reason: 'för kort' })).status).toBe(400)
    expect((await post({ ...body, lines: [body.lines[0]] })).status).toBe(400)
    expect(mockBook).not.toHaveBeenCalled()
  })

  it('returns 403 without year-end write access', async () => {
    mockAccess.mockResolvedValue({ allowed: false, reason: 'role' })
    expect((await post()).status).toBe(403)
    expect(mockBook).not.toHaveBeenCalled()
  })

  it('books the correction and returns 201', async () => {
    mockBook.mockResolvedValue({ id: 'je-1' })
    const res = await post()
    expect(res.status).toBe(201)
    expect((await parseJsonResponse<{ data: { id: string } }>(res)).body.data.id).toBe('je-1')
    expect(mockBook).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', PERIOD, expect.objectContaining({ method: 'current_year' }))
  })

  it('maps rule violations to 409/400 with the issue text', async () => {
    mockBook.mockRejectedValueOnce(new PriorPeriodCorrectionError('PRIOR_CORRECTION_PERIOD_NOT_CLOSED'))
    expect((await post()).status).toBe(409)

    mockBook.mockRejectedValueOnce(new PriorPeriodCorrectionError('PRIOR_CORRECTION_LINES_INVALID', ['closing_result_account']))
    const res = await post()
    expect(res.status).toBe(400)
    const json = (await parseJsonResponse<{ error: { code: string; details: { issues: { code: string; message: string }[] } } }>(res)).body
    expect(json.error.code).toBe('PRIOR_CORRECTION_LINES_INVALID')
    expect(json.error.details.issues[0].code).toBe('closing_result_account')
  })

  it('returns 404 for a period of another company and 500 on unexpected errors', async () => {
    mockBook.mockRejectedValueOnce(new PriorPeriodCorrectionError('NOT_FOUND'))
    expect((await post()).status).toBe(404)
    mockBook.mockRejectedValueOnce(new Error('boom'))
    expect((await post()).status).toBe(500)
  })
})

describe('GET prior-period-correction', () => {
  it('lists corrections booked for the closed year', async () => {
    const rows = [{ id: 'je-1', description: 'Rättelse 2025: x' }]
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'order']) chain[m] = vi.fn(() => chain)
    chain.then = (resolve: (v: unknown) => void) => resolve({ data: rows, error: null })
    mockFrom.mockReturnValue(chain)
    const res = await GET(createMockRequest(url), params())
    expect(res.status).toBe(200)
    expect((await parseJsonResponse<{ data: unknown[] }>(res)).body.data).toEqual(rows)
    expect(chain.eq).toHaveBeenCalledWith('source_type', 'prior_period_correction')
    expect(chain.eq).toHaveBeenCalledWith('source_id', PERIOD)
  })
})
