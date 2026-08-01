/**
 * Canonical customer settlement service tests.
 *
 * These tests deliberately assert the transaction boundary: the application
 * may stage a draft, but only settle_customer_invoice may post it and mutate
 * AR/payment/bank/audit/outbox state.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase, makeCustomer, makeInvoice } from '@/tests/helpers'

const mockCreateInvoicePaymentJournalEntry = vi.fn()
const mockCreateInvoiceCashEntry = vi.fn()
vi.mock('@/lib/bookkeeping/invoice-entries', () => ({
  createInvoicePaymentJournalEntry: (...args: unknown[]) =>
    mockCreateInvoicePaymentJournalEntry(...args),
  createInvoiceCashEntry: (...args: unknown[]) => mockCreateInvoiceCashEntry(...args),
}))

const mockCreateDraftEntry = vi.fn()
const mockFindFiscalPeriod = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  createDraftEntry: (...args: unknown[]) => mockCreateDraftEntry(...args),
  findFiscalPeriod: (...args: unknown[]) => mockFindFiscalPeriod(...args),
}))

const mockService = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => mockService.supabase,
}))

const mockGetCompanyEntityType = vi.fn()
vi.mock('@/lib/company/entity-type', () => ({
  getCompanyEntityType: (...args: unknown[]) => mockGetCompanyEntityType(...args),
}))

const mockEmit = vi.fn()
vi.mock('@/lib/events', () => ({
  eventBus: { emit: (...args: unknown[]) => mockEmit(...args) },
}))

vi.mock('@/lib/webhooks/diff', () => ({
  computePreviousAttributes: () => ({}),
}))

import { markInvoicePaid } from '../mark-paid-service'

const caller = createQueuedMockSupabase()
const COMPANY_ID = '00000000-0000-4000-8000-000000000001'
const USER_ID = '00000000-0000-4000-8000-000000000002'

function invoice(overrides: Record<string, unknown> = {}) {
  return makeInvoice({
    id: '00000000-0000-4000-8000-000000000010',
    status: 'sent',
    document_type: 'invoice',
    invoice_number: '2026-0042',
    currency: 'SEK',
    total: 12500,
    paid_amount: 0,
    remaining_amount: 12500,
    journal_entry_id: '00000000-0000-4000-8000-000000000020',
    customer: makeCustomer({ name: 'Testkund AB' }),
    ...overrides,
  } as never)
}

function atomic(overrides: Record<string, unknown> = {}) {
  return {
    invoice_id: '00000000-0000-4000-8000-000000000010',
    payment_id: '00000000-0000-4000-8000-000000000030',
    journal_entry_id: '00000000-0000-4000-8000-000000000040',
    customer_credit_id: null,
    applied_amount: 12500,
    overpayment_amount: 0,
    paid_amount: 12500,
    remaining_amount: 0,
    status: 'paid',
    paid_at: '2026-05-12',
    request_id: 'req_test',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  caller.reset()
  mockService.reset()
  mockGetCompanyEntityType.mockResolvedValue('aktiebolag')
  mockCreateInvoicePaymentJournalEntry.mockResolvedValue({
    id: '00000000-0000-4000-8000-000000000040',
  })
  mockEmit.mockResolvedValue(undefined)
})

describe('markInvoicePaid atomic settlement', () => {
  it('replays a committed operation before reading mutable invoice state', async () => {
    const committed = atomic()
    mockService.enqueue({ data: committed })
    mockService.enqueue({ data: invoice({ status: 'paid', remaining_amount: 0, paid_amount: 12500 }) })

    const result = await markInvoicePaid(caller.supabase as never, COMPANY_ID, USER_ID, {
      invoiceId: committed.invoice_id,
      paymentDate: '2026-05-12',
      idempotencyKey: 'idem-1',
      requestId: 'req_test',
    })

    expect(result.ok).toBe(true)
    expect(caller.supabase.from).not.toHaveBeenCalled()
    expect(mockCreateInvoicePaymentJournalEntry).not.toHaveBeenCalled()
    expect(mockService.supabase.rpc).toHaveBeenCalledWith(
      'get_financial_operation_result',
      expect.objectContaining({ p_idempotency_key: 'idem-1' }),
    )
  })

  it('stages a draft and delegates every economic write to settle_customer_invoice', async () => {
    const original = invoice()
    mockService.enqueue({ data: null }) // initial replay lookup
    caller.enqueue({ data: original })
    caller.enqueue({ data: { accounting_method: 'accrual' } })
    mockService.enqueue({ data: atomic() })
    mockService.enqueue({ data: invoice({ status: 'paid', remaining_amount: 0, paid_amount: 12500 }) })

    const result = await markInvoicePaid(caller.supabase as never, COMPANY_ID, USER_ID, {
      invoiceId: original.id,
      paymentDate: '2026-05-12',
      idempotencyKey: 'idem-2',
      requestId: 'req_test',
    })

    expect(result.ok).toBe(true)
    expect(mockCreateInvoicePaymentJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      USER_ID,
      expect.objectContaining({ id: original.id }),
      '2026-05-12',
      undefined,
      'Testkund AB',
      12500,
      { draftOnly: true },
    )
    expect(mockService.supabase.rpc).toHaveBeenCalledWith(
      'settle_customer_invoice',
      expect.objectContaining({
        p_invoice_id: original.id,
        p_draft_journal_entry_id: '00000000-0000-4000-8000-000000000040',
        p_idempotency_key: 'idem-2',
        p_request_id: 'req_test',
      }),
    )
    expect(mockEmit).toHaveBeenCalledWith(expect.objectContaining({ type: 'invoice.paid' }))
  })

  it('resolves a lost HTTP response through the committed idempotency result', async () => {
    const original = invoice()
    mockService.enqueue({ data: null })
    caller.enqueue({ data: original })
    caller.enqueue({ data: { accounting_method: 'accrual' } })
    mockService.enqueue({ error: { message: 'transport timeout' } })
    mockService.enqueue({ data: atomic() })
    mockService.enqueue({ data: invoice({ status: 'paid', remaining_amount: 0, paid_amount: 12500 }) })

    const result = await markInvoicePaid(caller.supabase as never, COMPANY_ID, USER_ID, {
      invoiceId: original.id,
      paymentDate: '2026-05-12',
      idempotencyKey: 'idem-3',
      requestId: 'req_test',
    })

    expect(result.ok).toBe(true)
    expect(mockService.supabase.from).toHaveBeenCalledTimes(1) // hydration only; draft was not cancelled
  })

  it('cancels only the unposted draft when the database transaction rolled back', async () => {
    const original = invoice()
    mockService.enqueue({ data: null })
    caller.enqueue({ data: original })
    caller.enqueue({ data: { accounting_method: 'accrual' } })
    mockService.enqueue({
      error: {
        message: 'period closed',
        details: '{"code":"PERIOD_LOCKED"}',
      },
    })
    mockService.enqueue({ data: null })
    mockService.enqueue({ data: null }) // draft cancellation update

    const result = await markInvoicePaid(caller.supabase as never, COMPANY_ID, USER_ID, {
      invoiceId: original.id,
      paymentDate: '2026-05-12',
      idempotencyKey: 'idem-4',
      requestId: 'req_test',
    })

    expect(result).toMatchObject({ ok: false, code: 'PERIOD_LOCKED' })
    expect(mockService.supabase.from).toHaveBeenCalledWith('journal_entries')
  })
})
