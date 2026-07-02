import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeInvoice,
  makeCustomer,
} from '@/tests/helpers'

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

// The settlement itself is the shared service's responsibility — covered in
// lib/invoices/__tests__/mark-paid-service.test.ts. Route tests verify the
// route-level guards and the delegation contract.
const mockMarkInvoicePaid = vi.fn()
vi.mock('@/lib/invoices/mark-paid-service', () => ({
  markInvoicePaid: (...args: unknown[]) => mockMarkInvoicePaid(...args),
}))

import { POST } from '../route'

function successResult(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    invoice: makeInvoice({ id: 'inv-1', status: 'paid' }),
    journalEntryId: 'je-1',
    paymentId: 'pay-1',
    appliedAmount: 12500,
    overpaymentAmount: 0,
    newStatus: 'paid',
    newPaidAmount: 12500,
    newRemaining: 0,
    customerCreditId: null,
    warnings: [],
    ...overrides,
  }
}

describe('POST /api/invoices/[id]/mark-paid', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    mockMarkInvoicePaid.mockResolvedValue(successResult())
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 404 when invoice not found', async () => {
    enqueue({ data: null, error: { message: 'Not found' } })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(404)
    expect((body.error as unknown as { code: string }).code).toBe('INVOICE_PAID_NOT_FOUND')
    expect(mockMarkInvoicePaid).not.toHaveBeenCalled()
  })

  it('returns 400 when invoice is in draft status', async () => {
    const invoice = makeInvoice({ status: 'draft' })
    enqueue({ data: invoice, error: null })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('INVOICE_PAID_NOT_PAYABLE')
    expect(mockMarkInvoicePaid).not.toHaveBeenCalled()
  })

  it('returns 400 when invoice is already paid', async () => {
    const invoice = makeInvoice({ status: 'paid' })
    enqueue({ data: invoice, error: null })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('INVOICE_PAID_NOT_PAYABLE')
  })

  it('returns 400 when invoice is credited', async () => {
    const invoice = makeInvoice({ status: 'credited' })
    enqueue({ data: invoice, error: null })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
  })

  it('allows partially paid invoices through to the service', async () => {
    const customer = makeCustomer()
    const invoice = makeInvoice({
      id: 'inv-1',
      status: 'partially_paid',
      total: 12500,
      remaining_amount: 5000,
      paid_amount: 7500,
      customer,
    })

    enqueue({ data: invoice, error: null })
    // Duplicate-payment guard queries (merchant + description ILIKE)
    enqueue({ data: [], error: null })
    enqueue({ data: [], error: null })

    mockMarkInvoicePaid.mockResolvedValue(
      successResult({ appliedAmount: 5000, newPaidAmount: 12500, newRemaining: 0 }),
    )

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ success: boolean; status: string }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(mockMarkInvoicePaid).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ invoiceId: 'inv-1' }),
    )
  })

  it('marks a sent invoice as paid via the shared service', async () => {
    const customer = makeCustomer()
    const invoice = makeInvoice({ id: 'inv-1', status: 'sent', total: 12500, customer })

    enqueue({ data: invoice, error: null })
    // Duplicate-payment guard: merchant + description ILIKE — no candidates
    enqueue({ data: [], error: null })
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      status: string
      paid_amount: number
      journal_entry_id: string | null
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.status).toBe('paid')
    expect(body.paid_amount).toBe(12500)
    expect(body.journal_entry_id).toBe('je-1')
  })

  it('maps service failure codes to structured errors', async () => {
    const customer = makeCustomer()
    const invoice = makeInvoice({ id: 'inv-1', status: 'sent', total: 12500, customer })
    enqueue({ data: invoice, error: null })
    enqueue({ data: [], error: null })
    enqueue({ data: [], error: null })

    mockMarkInvoicePaid.mockResolvedValue({
      ok: false,
      code: 'INVOICE_PAID_RACE',
    })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(409)
    expect((body.error as unknown as { code: string }).code).toBe('INVOICE_PAID_RACE')
  })

  it('returns 400 when body has invalid schema (e.g. bad account number)', async () => {
    const invoice = makeInvoice({ id: 'inv-1', status: 'sent', total: 12500 })
    enqueue({ data: invoice, error: null })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', {
      method: 'POST',
      body: {
        payment_date: '2025-03-17',
        lines: [{ account_number: 'XXXX', debit_amount: 12500, credit_amount: 0 }],
      },
    })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
    expect(mockMarkInvoicePaid).not.toHaveBeenCalled()
  })

  it('returns 409 INVOICE_PAID_LIKELY_DUPLICATE when an unlinked transaction matches', async () => {
    const customer = makeCustomer()
    const invoice = makeInvoice({ id: 'inv-1', status: 'sent', total: 12500, customer })

    enqueue({ data: invoice, error: null })
    // Duplicate-payment guard: merchant_name ILIKE returns the match
    enqueue({
      data: [
        {
          id: 'tx-99',
          date: '2026-05-10',
          amount: 12500,
          description: 'Inbetalning Test AB',
          merchant_name: 'Test AB',
          reference: null,
        },
      ],
      error: null,
    })
    // description ILIKE — no additional match
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { candidates: Array<{ id: string; match_reason: string }> } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('INVOICE_PAID_LIKELY_DUPLICATE')
    expect(body.error.details.candidates).toHaveLength(1)
    expect(body.error.details.candidates[0].id).toBe('tx-99')
    expect(body.error.details.candidates[0].match_reason).toBe('name_amount_fuzzy')
    expect(mockMarkInvoicePaid).not.toHaveBeenCalled()
  })

  it('proceeds when force=true even with candidates present', async () => {
    const customer = makeCustomer()
    const invoice = makeInvoice({ id: 'inv-1', status: 'sent', total: 12500, customer })

    enqueue({ data: invoice, error: null })
    // Guard query is SKIPPED because force=true short-circuits the check

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', {
      method: 'POST',
      body: { force: true },
    })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ success: boolean; journal_entry_id: string }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_id).toBe('je-1')
  })

  it('skips duplicate guard on partial payment (lines total < remaining)', async () => {
    const customer = makeCustomer()
    const invoice = makeInvoice({ id: 'inv-1', status: 'sent', total: 12500, customer })

    // No guard query enqueued — guard is skipped for partial payments
    enqueue({ data: invoice, error: null })

    const partialLines = [
      { account_number: '1930', debit_amount: 5000, credit_amount: 0 },
      { account_number: '1510', debit_amount: 0, credit_amount: 5000 },
    ]

    mockMarkInvoicePaid.mockResolvedValue(
      successResult({
        journalEntryId: 'je-partial',
        appliedAmount: 5000,
        newStatus: 'partially_paid',
        newPaidAmount: 5000,
        newRemaining: 7500,
      }),
    )

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', {
      method: 'POST',
      body: { lines: partialLines },
    })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      status: string
      journal_entry_id: string
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.status).toBe('partially_paid')
    expect(body.journal_entry_id).toBe('je-partial')
    expect(mockMarkInvoicePaid).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ customLines: partialLines }),
    )
  })

  it('surfaces ocr_exact match_reason when tx reference normalizes to invoice_number', async () => {
    const customer = makeCustomer()
    const invoice = makeInvoice({
      id: 'inv-1',
      invoice_number: '2026-0042',
      status: 'sent',
      total: 12500,
      customer,
    })

    enqueue({ data: invoice, error: null })
    // OCR match: tx.reference '20260042' normalizes to invoice_number '20260042'
    enqueue({
      data: [
        {
          id: 'tx-ocr',
          date: '2026-05-10',
          amount: 12500,
          description: 'Insättning',
          merchant_name: 'Test AB',
          reference: '2026 0042',
        },
      ],
      error: null,
    })
    // description ILIKE — no additional match
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { candidates: Array<{ id: string; match_reason: string }> } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('INVOICE_PAID_LIKELY_DUPLICATE')
    expect(body.error.details.candidates[0].match_reason).toBe('ocr_exact')
  })

  it('ranks ocr_exact ahead of name_amount_fuzzy when multiple candidates match', async () => {
    const customer = makeCustomer()
    const invoice = makeInvoice({
      id: 'inv-1',
      invoice_number: '2026-0042',
      status: 'sent',
      total: 12500,
      customer,
    })

    enqueue({ data: invoice, error: null })
    enqueue({
      data: [
        // Name+amount only (no OCR)
        {
          id: 'tx-name',
          date: '2026-05-09',
          amount: 12500,
          description: 'Inbetalning Test AB',
          merchant_name: 'Test AB',
          reference: null,
        },
        // OCR exact match
        {
          id: 'tx-ocr',
          date: '2026-05-08',
          amount: 12500,
          description: 'Inbetalning Test AB',
          merchant_name: 'Test AB',
          reference: '2026-0042',
        },
      ],
      error: null,
    })
    // description ILIKE — no additional matches
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { candidates: Array<{ id: string; match_reason: string }> } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.details.candidates[0].id).toBe('tx-ocr')
    expect(body.error.details.candidates[0].match_reason).toBe('ocr_exact')
    expect(body.error.details.candidates[1].id).toBe('tx-name')
    expect(body.error.details.candidates[1].match_reason).toBe('name_amount_fuzzy')
  })
})
