import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const mockCreateSupplierInvoicePaymentEntry = vi.fn()
const mockCreateSupplierInvoiceCashEntry = vi.fn()
vi.mock('@/lib/bookkeeping/supplier-invoice-entries', () => ({
  createSupplierInvoicePaymentEntry: (...args: unknown[]) =>
    mockCreateSupplierInvoicePaymentEntry(...args),
  createSupplierInvoiceCashEntry: (...args: unknown[]) =>
    mockCreateSupplierInvoiceCashEntry(...args),
}))

const mockCreateDraftEntry = vi.fn()
const mockFindFiscalPeriod = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  createDraftEntry: (...args: unknown[]) => mockCreateDraftEntry(...args),
  findFiscalPeriod: (...args: unknown[]) => mockFindFiscalPeriod(...args),
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
  mockCreateSupplierInvoicePaymentEntry.mockResolvedValue({ id: atomic.journal_entry_id })
})

describe('settleSupplierInvoiceAtomic', () => {
  it('replays a completed supplier settlement without staging a new draft', async () => {
    service.enqueue({ data: atomic })

    const result = await settleSupplierInvoiceAtomic(caller.supabase as never, companyId, userId, {
      invoice: supplierInvoice,
      paymentDate: '2026-05-12',
      paymentAmount: 1000,
      idempotencyKey: 'supplier-idem-1',
      requestId: 'req_supplier',
    })

    expect(result).toMatchObject({ ok: true, status: 'paid', remainingAmount: 0 })
    expect(mockCreateSupplierInvoicePaymentEntry).not.toHaveBeenCalled()
  })

  it('stages a draft and delegates AP/payment/audit/outbox to the database RPC', async () => {
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
    expect(mockCreateSupplierInvoicePaymentEntry).toHaveBeenCalledWith(
      expect.anything(), companyId, userId, supplierInvoice, 1000, '2026-05-12',
      undefined, 'Leverantör AB', undefined, { draftOnly: true },
    )
    expect(service.supabase.rpc).toHaveBeenCalledWith(
      'settle_supplier_invoice',
      expect.objectContaining({
        p_supplier_invoice_id: supplierInvoiceId,
        p_idempotency_key: 'supplier-idem-2',
        p_draft_journal_entry_id: atomic.journal_entry_id,
      }),
    )
  })
})
