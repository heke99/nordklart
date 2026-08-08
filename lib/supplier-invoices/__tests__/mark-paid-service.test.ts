import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const mockPlanSupplierInvoicePaymentEntry = vi.fn()
const mockPlanSupplierInvoiceCashEntry = vi.fn()
vi.mock('@/lib/bookkeeping/supplier-invoice-entries', () => ({
  planSupplierInvoicePaymentEntry: (...args: unknown[]) =>
    mockPlanSupplierInvoicePaymentEntry(...args),
  planSupplierInvoiceCashEntry: (...args: unknown[]) =>
    mockPlanSupplierInvoiceCashEntry(...args),
}))

const mockFindFiscalPeriod = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  findFiscalPeriod: (...args: unknown[]) => mockFindFiscalPeriod(...args),
  resolveSeriesFromSettings: vi.fn().mockResolvedValue('A'),
}))

const service = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => service.supabase }))

import { settleSupplierInvoiceAtomic } from '../mark-paid-service'

const caller = createQueuedMockSupabase()
const companyId = '00000000-0000-4000-8000-000000000101'
const userId = '00000000-0000-4000-8000-000000000102'
const supplierInvoiceId = '00000000-0000-4000-8000-000000000103'
const supplierInvoice = {
  id: supplierInvoiceId,
  supplier_id: '00000000-0000-4000-8000-000000000104',
  supplier_invoice_number: 'LF-42',
  status: 'approved',
  currency: 'SEK',
  total: 1000,
  paid_amount: 0,
  remaining_amount: 1000,
  registration_journal_entry_id: '00000000-0000-4000-8000-000000000105',
  supplier: { id: '00000000-0000-4000-8000-000000000104', name: 'Leverantör AB', supplier_type: 'swedish_business' },
  items: [],
} as never

const atomic = {
  supplier_invoice_id: '00000000-0000-4000-8000-000000000103',
  payment_id: '00000000-0000-4000-8000-000000000106',
  journal_entry_id: '00000000-0000-4000-8000-000000000107',
  applied_amount: 1000,
  paid_amount: 1000,
  remaining_amount: 0,
  status: 'paid',
  paid_at: '2026-05-12',
  request_id: 'req_supplier',
}

beforeEach(() => {
  vi.clearAllMocks()
  caller.reset()
  service.reset()
  mockPlanSupplierInvoicePaymentEntry.mockResolvedValue({
    fiscal_period_id: 'fp-1',
    entry_date: '2026-05-12',
    description: 'Utbetalning leverantörsfaktura LF-42',
    source_type: 'supplier_invoice_paid',
    source_id: supplierInvoiceId,
    lines: [
      { account_number: '2440', debit_amount: 1000, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
    ],
  })
})

describe('settleSupplierInvoiceAtomic', () => {
  it('replays a completed supplier settlement without planning a new voucher', async () => {
    service.enqueue({ data: atomic })

    const result = await settleSupplierInvoiceAtomic(caller.supabase as never, companyId, userId, {
      invoice: supplierInvoice,
      paymentDate: '2026-05-12',
      paymentAmount: 1000,
      idempotencyKey: 'supplier-idem-1',
      requestId: 'req_supplier',
    })

    expect(result).toMatchObject({ ok: true, status: 'paid', remainingAmount: 0 })
    expect(mockPlanSupplierInvoicePaymentEntry).not.toHaveBeenCalled()
  })

  it('sends the planned voucher and delegates AP/payment/audit/outbox to the RPC', async () => {
    service.enqueue({ data: null })
    caller.enqueue({ data: { accounting_method: 'accrual' } })
    service.enqueue({ data: atomic })

    const result = await settleSupplierInvoiceAtomic(caller.supabase as never, companyId, userId, {
      invoice: supplierInvoice,
      paymentDate: '2026-05-12',
      paymentAmount: 1000,
      idempotencyKey: 'supplier-idem-2',
      requestId: 'req_supplier',
    })

    expect(result.ok).toBe(true)
    expect(mockPlanSupplierInvoicePaymentEntry).toHaveBeenCalledWith(
      expect.anything(), companyId, supplierInvoice, 1000, '2026-05-12',
      undefined, 'Leverantör AB', undefined,
    )
    // The voucher travels as data. Nothing is written before the RPC, so there
    // is no draft id to hand over and nothing to compensate if it rolls back.
    expect(service.supabase.rpc).toHaveBeenCalledWith(
      'settle_supplier_invoice_v2',
      expect.objectContaining({
        p_supplier_invoice_id: supplierInvoiceId,
        p_idempotency_key: 'supplier-idem-2',
        p_journal: expect.objectContaining({
          source_type: 'supplier_invoice_paid',
          source_id: supplierInvoiceId,
          voucher_series: 'A',
          lines: expect.arrayContaining([
            expect.objectContaining({ account_number: '2440', debit_amount: 1000 }),
          ]),
        }),
      }),
    )
    expect(service.supabase.from).not.toHaveBeenCalledWith('journal_entries')
  })

  // supplier_invoice.paid is a delivered webhook event and the only signal an
  // integrator gets for an AP payment. It was silently lost once when the
  // routes were refactored onto this service, so both halves of the contract —
  // emitted on a real settlement, NOT re-emitted on an idempotent replay — are
  // locked here rather than only in the route tests.
  it('emits supplier_invoice.paid with the committed invoice state', async () => {
    const emitSpy = vi.spyOn(eventBus, 'emit').mockResolvedValue(undefined as never)
    const settled = {
      ...(supplierInvoice as Record<string, unknown>),
      status: 'paid',
      paid_amount: 1000,
      remaining_amount: 0,
    }
    service.enqueueFor('get_financial_operation_result', { data: null })
    caller.enqueueFor('company_settings', { data: { accounting_method: 'accrual' } })
    service.enqueueFor('settle_supplier_invoice_v2', { data: atomic })
    service.enqueueFor('supplier_invoices', { data: settled })

    await settleSupplierInvoiceAtomic(caller.supabase as never, companyId, userId, {
      invoice: supplierInvoice,
      paymentDate: '2026-05-12',
      paymentAmount: 1000,
      idempotencyKey: 'supplier-idem-3',
      requestId: 'req_supplier',
    })

    expect(emitSpy).toHaveBeenCalledWith({
      type: 'supplier_invoice.paid',
      payload: {
        supplierInvoice: settled,
        paymentAmount: 1000,
        companyId,
        userId,
      },
    })
  })

  it('does not re-emit supplier_invoice.paid when replaying a settled payment', async () => {
    const emitSpy = vi.spyOn(eventBus, 'emit').mockResolvedValue(undefined as never)
    service.enqueueFor('get_financial_operation_result', { data: atomic })

    const result = await settleSupplierInvoiceAtomic(caller.supabase as never, companyId, userId, {
      invoice: supplierInvoice,
      paymentDate: '2026-05-12',
      paymentAmount: 1000,
      idempotencyKey: 'supplier-idem-4',
      requestId: 'req_supplier',
    })

    expect(result.ok).toBe(true)
    expect(emitSpy).not.toHaveBeenCalled()
  })

  it('still settles when the post-settlement hydration read comes back empty', async () => {
    const emitSpy = vi.spyOn(eventBus, 'emit').mockResolvedValue(undefined as never)
    service.enqueueFor('get_financial_operation_result', { data: null })
    caller.enqueueFor('company_settings', { data: { accounting_method: 'accrual' } })
    service.enqueueFor('settle_supplier_invoice_v2', { data: atomic })
    service.enqueueFor('supplier_invoices', { data: null })

    const result = await settleSupplierInvoiceAtomic(caller.supabase as never, companyId, userId, {
      invoice: supplierInvoice,
      paymentDate: '2026-05-12',
      paymentAmount: 1000,
      idempotencyKey: 'supplier-idem-5',
      requestId: 'req_supplier',
    })

    expect(result).toMatchObject({ ok: true, status: 'paid', remainingAmount: 0 })
    // Falls back to the pre-payment snapshot merged with the committed result,
    // so subscribers never see a stale unpaid status.
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'supplier_invoice.paid',
        payload: expect.objectContaining({
          supplierInvoice: expect.objectContaining({
            status: 'paid',
            paid_amount: 1000,
            remaining_amount: 0,
          }),
        }),
      }),
    )
  })

  it('settles even when the event bus throws — the payment is already committed', async () => {
    vi.spyOn(eventBus, 'emit').mockRejectedValue(new Error('bus down'))
    service.enqueueFor('get_financial_operation_result', { data: null })
    caller.enqueueFor('company_settings', { data: { accounting_method: 'accrual' } })
    service.enqueueFor('settle_supplier_invoice_v2', { data: atomic })
    service.enqueueFor('supplier_invoices', { data: supplierInvoice })

    const result = await settleSupplierInvoiceAtomic(caller.supabase as never, companyId, userId, {
      invoice: supplierInvoice,
      paymentDate: '2026-05-12',
      paymentAmount: 1000,
      idempotencyKey: 'supplier-idem-6',
      requestId: 'req_supplier',
    })

    expect(result).toMatchObject({ ok: true, status: 'paid' })
  })
})
