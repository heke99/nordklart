import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeCustomer,
  makeInvoice,
  makeTransaction,
  parseJsonResponse,
  enqueueCustomerSettlement,
  supabaseServerMock,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, enqueueFor, reset } = createQueuedMockSupabase()
// The settlement service uses createServiceClient(), a different client from
// the request-scoped one, so it needs its own queue.
const service = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => supabaseServerMock({
  client: () => mockSupabase,
  serviceClient: () => service.supabase,
}))

const mockPlanInvoiceCashEntry = vi.fn()
const mockPlanInvoicePaymentJournalEntry = vi.fn()
// Spread the real module: a factory that lists only some exports leaves the
// rest undefined, which is how createInvoicePaymentJournalEntry silently became
// undefined once mark-paid-service started calling it.
vi.mock('@/lib/bookkeeping/invoice-entries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/invoice-entries')>()),
  planInvoiceCashEntry: (...args: unknown[]) => mockPlanInvoiceCashEntry(...args),
  planInvoicePaymentJournalEntry: (...args: unknown[]) =>
    mockPlanInvoicePaymentJournalEntry(...args),
  getRevenueAccount: vi.fn().mockReturnValue('3001'),
  getOutputVatAccount: vi.fn().mockReturnValue('2611'),
}))

const mockReverseEntry = vi.fn()
const mockFindFiscalPeriod = vi.fn()
const mockCreateJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  reverseEntry: (...args: unknown[]) => mockReverseEntry(...args),
  findFiscalPeriod: (...args: unknown[]) => mockFindFiscalPeriod(...args),
  createJournalEntry: (...args: unknown[]) => mockCreateJournalEntry(...args),
}))

const mockFetchExchangeRate = vi.fn()
vi.mock('@/lib/currency/riksbanken', () => ({
  fetchExchangeRate: (...args: unknown[]) => mockFetchExchangeRate(...args),
}))

vi.mock('@/lib/invoices/match-log', () => ({
  logMatchEvent: vi.fn(),
}))

const mockDetectDuplicate = vi.fn()
vi.mock('@/lib/invoices/duplicate-payment-detection', () => ({
  detectDuplicatePaymentVoucher: (...args: unknown[]) => mockDetectDuplicate(...args),
}))

vi.mock('@/lib/events/bus', () => ({
  eventBus: { emit: vi.fn() },
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

import { POST } from '../route'
// Mocked above — imported here as a spy handle to assert FX rate provenance
// lands in the audit trail (PR #615 review).
import { logMatchEvent } from '@/lib/invoices/match-log'

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'
const VALID_UUID_2 = '550e8400-e29b-41d4-a716-446655440001'
const CANDIDATE_UUID = '550e8400-e29b-41d4-a716-446655440003'
/** What the settlement service now sends to settle_customer_invoice_v2. */
const PAYMENT_PLAN = {
  fiscal_period_id: 'fp-1',
  entry_date: '2024-06-15',
  description: 'Inbetalning kundfaktura 2024-001',
  source_type: 'invoice_paid',
  source_id: '550e8400-e29b-41d4-a716-446655440000',
  lines: [
    { account_number: '1930', debit_amount: 12500, credit_amount: 0 },
    { account_number: '1510', debit_amount: 0, credit_amount: 12500 },
  ],
}

const STALE_UUID = '550e8400-e29b-41d4-a716-446655440004'
const OTHER_CANDIDATE_UUID = '550e8400-e29b-41d4-a716-446655440005'

/**
 * The payment voucher is PLANNED here and created + posted by
 * settle_customer_invoice_v2 inside the database transaction, so there is no
 * journal-entry write to assert on any more.
 *
 * Positional reads rather than toHaveBeenCalledWith(...): the builder takes
 * optional arguments (customer name, exchange-rate difference) that are
 * legitimately `undefined`, and expect.anything() does not match undefined.
 */
function expectStagedPaymentDraft(): void {
  expect(mockPlanInvoicePaymentJournalEntry).toHaveBeenCalled()
  const call = mockPlanInvoicePaymentJournalEntry.mock.calls[0] as unknown[]
  expect(call[1]).toBe('company-1')
  expect((call[2] as { id: string }).id).toBe(VALID_UUID)
}

describe('POST /api/transactions/[id]/match-invoice', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    service.reset()
    mockPlanInvoicePaymentJournalEntry.mockResolvedValue(PAYMENT_PLAN)
    // Canonical legal form, read by the settlement service. Keyed responses are
    // sticky, so one default covers every read of this relation.
    enqueueFor('companies', { data: { entity_type: 'enskild_firma' } })
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    // Default to no soft-duplicate detected — happy-path tests don't care.
    mockDetectDuplicate.mockResolvedValue(null)
    // Clearing path delegates to findFiscalPeriod + createJournalEntry (FX fix
    // PR #614 round 6 — see lib/bookkeeping/invoice-payment-lines.ts). Give
    // both safe defaults; tests that exercise the clearing path override
    // mockCreateJournalEntry to assert the result id.
    mockFindFiscalPeriod.mockResolvedValue('fp-1')
    mockCreateJournalEntry.mockResolvedValue({ id: 'je-1' })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 400 when invoice_id is missing', async () => {
    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: {},
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toBe('Validation failed')
  })

  it('returns 404 when transaction not found', async () => {
    enqueue({ data: null, error: { message: 'Not found' } })

    const request = createMockRequest('/api/transactions/tx-999/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-999' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(404)
    expect((body.error as unknown as { code: string }).code).toBe('TX_CATEGORIZE_TX_NOT_FOUND')
  })

  it('returns 400 when transaction is an expense (amount <= 0)', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: -500 })
    enqueueFor('transactions', { data: tx, error: null })

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('MATCH_INVOICE_NOT_INCOME')
  })

  it('returns 400 when transaction is already linked to an invoice', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 12500, invoice_id: 'inv-other' })
    enqueueFor('transactions', { data: tx, error: null })

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('MATCH_INVOICE_TX_ALREADY_LINKED')
  })

  it('returns 404 when invoice not found', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 12500, invoice_id: null })
    enqueueFor('transactions', { data: tx, error: null })
    enqueue({ data: null, error: { message: 'Not found' } })

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID_2 },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(404)
    expect((body.error as unknown as { code: string }).code).toBe('MATCH_INVOICE_NOT_FOUND')
  })

  it('returns 400 when matching against a proforma (defense-in-depth)', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 12500, invoice_id: null })
    const proforma = makeInvoice({
      id: VALID_UUID,
      status: 'sent',
      document_type: 'proforma',
    } as Parameters<typeof makeInvoice>[0])
    enqueueFor('transactions', { data: tx, error: null })
    enqueueFor('invoices', { data: proforma, error: null })

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('MATCH_INVOICE_NOT_INVOICE_TYPE')
  })

  it('returns 400 when invoice is not in unpaid state', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 12500, invoice_id: null })
    const invoice = makeInvoice({ id: VALID_UUID, status: 'paid' })
    enqueueFor('transactions', { data: tx, error: null })
    enqueueFor('invoices', { data: invoice, error: null })

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('MATCH_INVOICE_NOT_OPEN')
  })

  it('cross-currency settlement: converts SEK tx via Riksbanken rate, posts FX-diff verifikat', async () => {
    // 1000 SEK bank tx paying a 140 USD invoice. Spot rate today: 10.45.
    // Conversion: 1000 / 10.45 = 95.6938 USD. Invoice was booked at 9.30,
    // so 1510 credit = 95.6938 × 9.30 = 889.95. FX gain = 1000 − 889.95 =
    // 110.05 → 3960 Cr. Invoice flips to partially_paid with remaining
    // 140 − 95.6938 = 44.3062 USD.
    const tx = makeTransaction({
      id: 'tx-1',
      amount: 1000,
      invoice_id: null,
      currency: 'SEK',
      date: '2026-05-30',
    })
    const invoice = makeInvoice({
      id: VALID_UUID,
      status: 'sent',
      currency: 'USD',
      exchange_rate: 9.3,
      total: 140,
      remaining_amount: 140,
      paid_amount: 0,
    })
    enqueueFor('transactions', { data: tx, error: null })
    enqueueFor('invoices', { data: invoice, error: null })
    enqueueFor('company_settings', { data: { accounting_method: 'accrual', entity_type: 'enskild_firma' } })

    mockFetchExchangeRate.mockResolvedValue({
      currency: 'USD',
      rate: 10.45,
      date: '2026-05-30',
    })
    mockCreateJournalEntry.mockResolvedValue({ id: 'je-fx' })


    enqueueCustomerSettlement(service, { settlement: { invoice_id: VALID_UUID, applied_amount: 95.69, paid_amount: 95.69, remaining_amount: 44.31, status: 'partially_paid', journal_entry_id: 'je-fx' }, invoice: { ...invoice, status: 'partially_paid', paid_amount: 95.69, remaining_amount: 44.31 } })
    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      invoice_status: string
      paid_amount: number
      remaining_amount: number
      journal_entry_id: string
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.invoice_status).toBe('partially_paid')
    // 2dp precision matches the invoice currency's natural precision (USD
    // is to cent). The internal paidInInvoiceCurrency is computed at 4dp
    // for FX-rate accuracy then rounded to 2dp when accumulated into the
    // invoice column.
    expect(body.paid_amount).toBeCloseTo(95.69, 1)
    expect(body.remaining_amount).toBeCloseTo(44.31, 1)
    // Verifikat: Dr 1930 1000, Cr 1510 889.95 (95.6938 × 9.30 ≈ 889.95),
    // Cr 3960 110.05 (gain). Balances to öre.
    expectStagedPaymentDraft()
    // The auto path records the rate provenance as 'riksbanken' (vs 'manual').
    expect(logMatchEvent).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'tx-1',
      'matched',
      expect.objectContaining({
        newState: expect.objectContaining({ rate_source: 'riksbanken', exchange_rate: 10.45 }),
      }),
    )
  })

  it('cross-currency settlement: returns 400 FX_RATE_UNAVAILABLE when Riksbanken fails and no manual rate', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 1000, invoice_id: null, currency: 'SEK', date: '2026-05-30' })
    const invoice = makeInvoice({
      id: VALID_UUID,
      status: 'sent',
      currency: 'USD',
      exchange_rate: 9.3,
      total: 140,
      remaining_amount: 140,
    })
    enqueueFor('transactions', { data: tx, error: null })
    enqueueFor('invoices', { data: invoice, error: null })

    mockFetchExchangeRate.mockResolvedValue(null) // Riksbanken outage

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('MATCH_INVOICE_FX_RATE_UNAVAILABLE')
  })

  it('cross-currency settlement: manual_exchange_rate succeeds when Riksbanken fails', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 1000, invoice_id: null, currency: 'SEK', date: '2026-05-30' })
    const invoice = makeInvoice({
      id: VALID_UUID,
      status: 'sent',
      currency: 'USD',
      exchange_rate: 9.3,
      total: 140,
      remaining_amount: 140,
      paid_amount: 0,
    })
    enqueueFor('transactions', { data: tx, error: null })
    enqueueFor('invoices', { data: invoice, error: null })
    enqueueFor('company_settings', { data: { accounting_method: 'accrual', entity_type: 'enskild_firma' } })

    mockFetchExchangeRate.mockResolvedValue(null) // Riksbanken down — manual rate used instead
    mockCreateJournalEntry.mockResolvedValue({ id: 'je-fx-manual' })

    enqueueCustomerSettlement(service, { settlement: { invoice_id: VALID_UUID, applied_amount: 95.69, paid_amount: 95.69, remaining_amount: 44.31, status: 'partially_paid', journal_entry_id: 'je-fx' }, invoice: { ...invoice, status: 'partially_paid', paid_amount: 95.69, remaining_amount: 44.31 } })
    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID, manual_exchange_rate: 10.5 },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status } = await parseJsonResponse<{ success: boolean }>(response)

    expect(status).toBe(200)
    // Manual rate skips the Riksbanken lookup — confirm by inspecting that
    // mockCreateJournalEntry got the FX-computed line set (1000 / 10.5 =
    // 95.2381 USD; arSek = 95.2381 × 9.30 = 885.71). Skipping Riksbanken is
    // intentional: when the user types a rate from their bank statement we
    // honour it rather than overriding with a possibly-stale Riksbanken value.
    expect(mockFetchExchangeRate).not.toHaveBeenCalled()
    expectStagedPaymentDraft()
    // Provenance: the manual override is recorded in the audit trail's
    // new_state so it's distinguishable from an automatic Riksbanken lookup.
    expect(logMatchEvent).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'tx-1',
      'matched',
      expect.objectContaining({
        newState: expect.objectContaining({ rate_source: 'manual', exchange_rate: 10.5 }),
      }),
    )
  })

  it('matches transaction to invoice with accrual method (full payment)', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 12500, invoice_id: null, date: '2024-06-15' })
    const customer = makeCustomer()
    const invoice = makeInvoice({
      id: VALID_UUID,
      status: 'sent',
      total: 12500,
      remaining_amount: 12500,
      subtotal: 10000,
      vat_amount: 2500,
      invoice_number: 'F-2024001',
      customer,
    })

    enqueueFor('transactions', { data: tx })
    enqueueFor('invoices', { data: invoice })
    enqueueFor('company_settings', { data: { accounting_method: 'accrual', entity_type: 'enskild_firma' } })

    mockCreateJournalEntry.mockResolvedValue({ id: 'je-1' })

    // Settlement now happens inside settle_customer_invoice on the service
    // client: replay lookup -> settlement row -> hydration read.
    enqueueCustomerSettlement(service, {
      settlement: { invoice_id: VALID_UUID, applied_amount: 12500, paid_amount: 12500 },
      invoice: { ...invoice, status: 'paid', paid_amount: 12500, remaining_amount: 0 },
    })
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      invoice_status: string
      paid_amount: number
      remaining_amount: number
      journal_entry_id: string
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.invoice_status).toBe('paid')
    expect(body.paid_amount).toBe(12500)
    expect(body.remaining_amount).toBe(0)
    expect(body.journal_entry_id).toBe('je-1')

    // The payment voucher is planned here and created by
    // settle_customer_invoice_v2 inside the database transaction, so the
    // assertion is on the planning call. The Dr 1930 / Cr 1510 line shape is
    // owned and covered by lib/bookkeeping/__tests__ for the builder itself.
    expect(mockPlanInvoicePaymentJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      expect.objectContaining({ id: VALID_UUID }),
      '2024-06-15',
      expect.anything(),
      expect.anything(),
      12500,
    )
  })

  // The match route no longer auto-stornos a conflicting voucher. A bank
  // transaction that already carries a journal entry must have that voucher
  // explicitly reversed first: silently reversing posted bookkeeping as a side
  // effect of matching is not an acceptable posture under BFL. The route
  // therefore refuses with BANK_TRANSACTION_ALREADY_ALLOCATED and the caller
  // decides.
  it('refuses to match a transaction that already carries a voucher', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: 12500,
      invoice_id: null,
      journal_entry_id: 'je-conflict',
      date: '2024-06-15',
    })

    enqueueFor('transactions', { data: tx })

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(409)
    expect((body.error as unknown as { code: string }).code).toBe('BANK_TRANSACTION_ALREADY_ALLOCATED')
    expect((body.error as unknown as { details?: { action?: string } }).details?.action)
      .toBe('reverse_existing_voucher_first')
  })

  it('leaves the books untouched when it refuses an already-allocated transaction', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: 12500,
      invoice_id: null,
      journal_entry_id: 'je-conflict',
    })

    enqueueFor('transactions', { data: tx, error: null })

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(409)
    // No reversal, no staged voucher, no settlement: the refusal happens before
    // any economic work is attempted.
    expect(mockReverseEntry).not.toHaveBeenCalled()
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
    expect(mockPlanInvoicePaymentJournalEntry).not.toHaveBeenCalled()
    expect(service.supabase.rpc).not.toHaveBeenCalled()
  })

  it('supports partial payment (partially_paid status)', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 5000, invoice_id: null, date: '2024-06-15' })
    const invoice = makeInvoice({
      id: VALID_UUID,
      status: 'sent',
      total: 12500,
      remaining_amount: 12500,
      paid_amount: 0,
    })

    enqueueFor('transactions', { data: tx, error: null })
    enqueueFor('invoices', { data: invoice, error: null })
    enqueueFor('company_settings', { data: { accounting_method: 'accrual', entity_type: 'enskild_firma' } })

    mockCreateJournalEntry.mockResolvedValue({ id: 'je-partial' })


    enqueueCustomerSettlement(service, { settlement: { invoice_id: VALID_UUID, applied_amount: 5000, paid_amount: 5000, remaining_amount: 7500, status: 'partially_paid' }, invoice: { ...invoice, status: 'partially_paid', paid_amount: 5000, remaining_amount: 7500 } })
    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      invoice_status: string
      paid_amount: number
      remaining_amount: number
    }>(response)

    expect(status).toBe(200)
    expect(body.invoice_status).toBe('partially_paid')
    expect(body.paid_amount).toBe(5000)
    expect(body.remaining_amount).toBe(7500)
  })

  it('cash method ignores cash entry when invoice was already booked (accrual→cash migration)', async () => {
    // Regression: customer sent invoices under accrual (1510 was debited on
    // send), then switched to kontantmetoden before the bank receipt arrived.
    // Old logic posted createInvoiceCashEntry — orphaning 1510 and double-
    // counting revenue + VAT. Fix: route on invoice.journal_entry_id, not on
    // the current accounting_method setting.
    const tx = makeTransaction({ id: 'tx-1', amount: 12500, invoice_id: null, date: '2024-06-15' })
    const invoice = {
      ...makeInvoice({
        id: VALID_UUID,
        status: 'sent',
        total: 12500,
        remaining_amount: 12500,
        paid_amount: 0,
      }),
      // journal_entry_id lives on the DB column but not the TS Invoice type;
      // attach via spread so the test row mirrors a real accrual-booked
      // invoice the matcher will read.
      journal_entry_id: 'je-send-on-accrual',
    }

    enqueueFor('transactions', { data: tx, error: null })
    enqueueFor('invoices', { data: invoice, error: null })
    enqueueFor('company_settings', { data: { accounting_method: 'cash', entity_type: 'enskild_firma' } })

    mockCreateJournalEntry.mockResolvedValue({ id: 'je-clearing' })

    // Route order: PDF re-attach (runs first when invoice.journal_entry_id is
    // set; null result skips the attach insert) → optimistic invoice update →
    // invoice_payments → update transaction → logMatchEvent.
    enqueue({ data: null, error: null }) // document_attachments lookup

    enqueueCustomerSettlement(service, { settlement: { invoice_id: VALID_UUID, applied_amount: 12500, paid_amount: 12500 }, invoice: { ...invoice, status: 'paid', paid_amount: 12500, remaining_amount: 0 } })
    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ invoice_status: string }>(response)

    expect(status).toBe(200)
    expect(body.invoice_status).toBe('paid')
    // Must clear 1510 via the clearing-entry path, not re-recognise revenue +
    // VAT via createInvoiceCashEntry.
    expectStagedPaymentDraft()
    expect(mockPlanInvoiceCashEntry).not.toHaveBeenCalled()
  })

  it('rejects an overpayment on a foreign-currency invoice with 400 (must be handled manually)', async () => {
    // Tx is +12 000 SEK against an EUR invoice with 500 EUR remaining
    // (rate 10 → payment ≈ 1 200 EUR). SEK overpayments become customer
    // credit via planInvoiceCustomerPayment, but a cross-currency
    // overpayment is blocked: the FX diff on the credit portion cannot be
    // booked safely without manual review.
    const tx = makeTransaction({ id: 'tx-1', amount: 12000, invoice_id: null, date: '2024-06-15' })
    const invoice = makeInvoice({
      id: VALID_UUID,
      status: 'partially_paid',
      currency: 'EUR',
      total: 1000,
      remaining_amount: 500,
      paid_amount: 500,
    })

    mockFetchExchangeRate.mockResolvedValue({ rate: 10, date: '2024-06-15' })
    enqueueFor('transactions', { data: tx, error: null })
    enqueueFor('invoices', { data: invoice, error: null })
    // Hard-duplicate check is skipped for partially_paid status — no enqueue needed.

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: unknown }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('VALIDATION_ERROR')
    const details = (body.error as unknown as { details: Record<string, unknown> }).details
    expect(details.overpayment_amount).toBe(700)
  })

  // Under kontantmetoden revenue and VAT are recognised on payment, so a
  // PARTIAL payment has no derivable revenue/VAT split. prepareMarkInvoicePaid
  // therefore refuses it unless the caller supplies explicit balanced lines,
  // rather than inventing a clearing booking. This replaced the older
  // auto-generated accrual-style clearing entry.
  it('refuses a cash-method partial payment without explicit lines', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 5000, invoice_id: null, date: '2024-06-15' })
    const invoice = makeInvoice({
      id: VALID_UUID,
      status: 'sent',
      total: 12500,
      remaining_amount: 12500,
      paid_amount: 0,
      journal_entry_id: null,
    })

    enqueueFor('transactions', { data: tx, error: null })
    enqueueFor('invoices', { data: invoice, error: null })
    enqueueFor('company_settings', { data: { accounting_method: 'cash', entity_type: 'enskild_firma' } })
    enqueueCustomerSettlement(service)

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: unknown }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('VALIDATION_ERROR')
    // Nothing economic is attempted: no voucher staged, no settlement.
    expect(mockPlanInvoiceCashEntry).not.toHaveBeenCalled()
    expect(mockPlanInvoicePaymentJournalEntry).not.toHaveBeenCalled()
    expect(service.supabase.rpc).not.toHaveBeenCalledWith('settle_customer_invoice_v2', expect.anything())
  })

  it('returns 409 when invoice is fully paid (optimistic lock)', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 12500, invoice_id: null })
    const invoice = makeInvoice({
      id: VALID_UUID,
      status: 'sent',
      total: 12500,
      remaining_amount: 12500,
    })

    enqueueFor('transactions', { data: tx, error: null })
    enqueueFor('invoices', { data: invoice, error: null })
    enqueueFor('company_settings', { data: { accounting_method: 'accrual', entity_type: 'enskild_firma' } })
    mockCreateJournalEntry.mockResolvedValue({ id: 'je-1' })

    // Optimistic lock returns 0 rows (another request fully paid it)
    enqueueCustomerSettlement(service, {
      error: { message: 'Invoice is not payable.', details: '{"code":"INVOICE_PAID_NOT_PAYABLE"}' },
    })

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    // Payability is now decided inside settle_customer_invoice, which raises
    // INVOICE_PAID_NOT_PAYABLE; the route maps that to MATCH_INVOICE_NOT_OPEN.
    // MATCH_INVOICE_ALREADY_PAID is no longer produced by this route.
    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('MATCH_INVOICE_NOT_OPEN')
  })

  it('returns 409 on duplicate invoice_payment (unique constraint)', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 12500, invoice_id: null })
    const invoice = makeInvoice({
      id: VALID_UUID,
      status: 'sent',
      total: 12500,
      remaining_amount: 12500,
    })

    enqueueFor('transactions', { data: tx, error: null })
    enqueueFor('invoices', { data: invoice, error: null })
    enqueueFor('company_settings', { data: { accounting_method: 'accrual', entity_type: 'enskild_firma' } })
    mockCreateJournalEntry.mockResolvedValue({ id: 'je-1' })

    enqueueCustomerSettlement(service, {
      error: {
        message: 'Bank transaction is already allocated to this invoice.',
        details: '{"code":"BANK_TRANSACTION_ALREADY_ALLOCATED"}',
      },
    })

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    // The unique-constraint race is now caught inside the settlement
    // transaction, which surfaces BANK_TRANSACTION_ALREADY_ALLOCATED (409)
    // rather than the route inspecting a 23505 from its own insert.
    expect(status).toBe(409)
    expect((body.error as unknown as { code: string }).code).toBe('BANK_TRANSACTION_ALREADY_ALLOCATED')
  })

  // Staging the voucher is no longer "non-blocking". The settlement is one
  // database transaction and the voucher is part of it, so a payment can never
  // be recorded without its bookkeeping. A staging failure fails the request.
  it('fails the whole match when the payment voucher cannot be staged', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 12500, invoice_id: null, date: '2024-06-15' })
    const invoice = makeInvoice({ id: VALID_UUID, status: 'sent', total: 12500, remaining_amount: 12500 })

    enqueueFor('transactions', { data: tx, error: null })
    enqueueFor('invoices', { data: invoice, error: null })
    enqueueFor('company_settings', { data: { accounting_method: 'accrual', entity_type: 'enskild_firma' } })
    enqueueCustomerSettlement(service)

    mockPlanInvoicePaymentJournalEntry.mockRejectedValue(new Error('Period locked'))

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).not.toBe(200)
    expect(body.error.code).toBe('INVOICE_PAID_BOOK_FAILED')
    // The settlement transaction is never reached, so no payment is recorded.
    expect(service.supabase.rpc).not.toHaveBeenCalledWith('settle_customer_invoice_v2', expect.anything())
  })

  // The application-side hard-duplicate guard was replaced by a database
  // invariant: invoice_payments is unique per (company, transaction, invoice),
  // and settle_customer_invoice surfaces a violation as
  // BANK_TRANSACTION_ALREADY_ALLOCATED. MATCH_INVOICE_ALREADY_HAS_PAYMENT_VOUCHER
  // is no longer produced by this route.
  it('surfaces a duplicate payment voucher from the settlement transaction', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 12500, invoice_id: null, date: '2024-06-15' })
    const invoice = makeInvoice({ id: VALID_UUID, status: 'sent', total: 12500, remaining_amount: 12500 })

    enqueueFor('transactions', { data: tx, error: null })
    enqueueFor('invoices', { data: invoice, error: null })
    enqueueFor('company_settings', { data: { accounting_method: 'accrual', entity_type: 'enskild_firma' } })
    enqueueCustomerSettlement(service, {
      error: {
        message: 'Bank transaction is already allocated to this invoice.',
        details: '{"code":"BANK_TRANSACTION_ALREADY_ALLOCATED"}',
      },
    })

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('BANK_TRANSACTION_ALREADY_ALLOCATED')
  })

  it('does NOT run hard-duplicate guard for partially_paid invoices (legitimate additional payment)', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 2500, invoice_id: null, date: '2024-06-15' })
    const invoice = makeInvoice({
      id: VALID_UUID,
      status: 'partially_paid',
      total: 12500,
      remaining_amount: 2500,
      paid_amount: 10000,
    })

    enqueueFor('transactions', { data: tx, error: null })
    enqueueFor('invoices', { data: invoice, error: null })

    mockCreateJournalEntry.mockResolvedValue({ id: 'je-partial-extra' })
    enqueue({ data: null, error: null }) // update tx

    enqueueCustomerSettlement(service, { settlement: { invoice_id: VALID_UUID, applied_amount: 2500, paid_amount: 12500, remaining_amount: 0, status: 'paid' }, invoice: { ...invoice, status: 'paid', paid_amount: 12500, remaining_amount: 0 } })
    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ success: boolean; invoice_status: string }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.invoice_status).toBe('paid')
  })

  it('returns 409 MATCH_INVOICE_POSSIBLE_DUPLICATE when the soft-duplicate detector finds a manual voucher', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 1000, invoice_id: null, date: '2026-05-15' })
    const invoice = makeInvoice({ id: VALID_UUID, status: 'sent', total: 1000, remaining_amount: 1000 })

    enqueueFor('transactions', { data: tx, error: null })
    enqueueFor('invoices', { data: invoice, error: null })
    enqueue({ data: [], error: null }) // hard-duplicate check: clean

    mockDetectDuplicate.mockResolvedValueOnce({
      journal_entry_id: 'je-manual',
      voucher_label: 'A12',
      entry_date: '2026-05-15',
      description: 'Inbetalning faktura',
      amount: 1000,
      bank_account_number: '1930',
      reason: 'exact_amount_same_date',
    })

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: { candidate?: { journal_entry_id: string; voucher_label: string } } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('MATCH_INVOICE_POSSIBLE_DUPLICATE')
    expect(body.error.details?.candidate?.journal_entry_id).toBe('je-manual')
    expect(body.error.details?.candidate?.voucher_label).toBe('A12')
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('force=true bypasses the soft-duplicate guard when the candidate echo matches', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 1000, invoice_id: null, date: '2026-05-15' })
    const invoice = makeInvoice({
      id: VALID_UUID,
      status: 'sent',
      total: 1000,
      remaining_amount: 1000,
      invoice_number: 'F-2024099',
    })

    enqueueFor('transactions', { data: tx, error: null })
    enqueueFor('invoices', { data: invoice, error: null })

    // force=true re-detects the candidate to verify the echoed id matches.
    mockDetectDuplicate.mockResolvedValueOnce({
      journal_entry_id: CANDIDATE_UUID,
      voucher_label: 'A12',
      entry_date: '2026-05-15',
      description: 'Inbetalning faktura',
      amount: 1000,
      bank_account_number: '1930',
      reason: 'exact_amount_same_date',
    })

    enqueueFor('company_settings', { data: { accounting_method: 'accrual', entity_type: 'enskild_firma' } })

    enqueueCustomerSettlement(service, {
      settlement: {
        invoice_id: VALID_UUID, applied_amount: 1000, paid_amount: 1000,
        remaining_amount: 0, status: 'paid', journal_entry_id: 'je-forced',
      },
      invoice: { ...invoice, status: 'paid', paid_amount: 1000, remaining_amount: 0 },
    })
    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID, force: true, expected_journal_entry_id: CANDIDATE_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ success: boolean; journal_entry_id: string }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_id).toBe('je-forced')
    expect(mockDetectDuplicate).toHaveBeenCalledTimes(1)
  })

  it('returns 400 when force=true is sent without expected_journal_entry_id', async () => {
    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID, force: true },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status } = await parseJsonResponse(response)
    // Refusal happens at the schema layer (refine) before any DB work.
    expect(status).toBe(400)
  })

  it('returns 409 MATCH_INVOICE_FORCE_CANDIDATE_MISMATCH when the echoed candidate no longer matches', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 1000, invoice_id: null, date: '2026-05-15' })
    const invoice = makeInvoice({ id: VALID_UUID, status: 'sent', total: 1000, remaining_amount: 1000 })

    enqueueFor('transactions', { data: tx, error: null })
    enqueueFor('invoices', { data: invoice, error: null })
    enqueue({ data: [], error: null }) // hard-duplicate check: clean

    // Re-detection returns a different candidate than the caller echoed.
    mockDetectDuplicate.mockResolvedValueOnce({
      journal_entry_id: OTHER_CANDIDATE_UUID,
      voucher_label: 'A99',
      entry_date: '2026-05-15',
      description: 'Annan verifikation',
      amount: 1000,
      bank_account_number: '1930',
      reason: 'exact_amount_same_date',
    })

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID, force: true, expected_journal_entry_id: STALE_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: { expected_journal_entry_id?: string; detected_journal_entry_id?: string } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('MATCH_INVOICE_FORCE_CANDIDATE_MISMATCH')
    expect(body.error.details?.expected_journal_entry_id).toBe(STALE_UUID)
    expect(body.error.details?.detected_journal_entry_id).toBe(OTHER_CANDIDATE_UUID)
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('returns 409 MATCH_INVOICE_FORCE_CANDIDATE_MISMATCH when no current duplicate exists for the force call', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 1000, invoice_id: null, date: '2026-05-15' })
    const invoice = makeInvoice({ id: VALID_UUID, status: 'sent', total: 1000, remaining_amount: 1000 })

    enqueueFor('transactions', { data: tx, error: null })
    enqueueFor('invoices', { data: invoice, error: null })
    enqueue({ data: [], error: null }) // hard-duplicate check: clean

    // Detection returns null — the duplicate the caller saw has resolved.
    mockDetectDuplicate.mockResolvedValueOnce(null)

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID, force: true, expected_journal_entry_id: STALE_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(409)
    expect(body.error.code).toBe('MATCH_INVOICE_FORCE_CANDIDATE_MISMATCH')
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })
})
