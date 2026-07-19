/**
 * Shared mark-paid service tests — the single settlement orchestration used
 * by the dashboard route, the v1 API and the pending-operation executor.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createQueuedMockSupabase,
  makeInvoice,
  makeCustomer,
} from '@/tests/helpers'

const mockCreateInvoicePaymentJournalEntry = vi.fn()
const mockCreateInvoiceCashEntry = vi.fn()
vi.mock('@/lib/bookkeeping/invoice-entries', () => ({
  createInvoicePaymentJournalEntry: (...args: unknown[]) =>
    mockCreateInvoicePaymentJournalEntry(...args),
  createInvoiceCashEntry: (...args: unknown[]) => mockCreateInvoiceCashEntry(...args),
}))

const mockCreateJournalEntry = vi.fn()
const mockFindFiscalPeriod = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: (...args: unknown[]) => mockCreateJournalEntry(...args),
  findFiscalPeriod: (...args: unknown[]) => mockFindFiscalPeriod(...args),
}))

const mockRecordOverpayment = vi.fn()
const mockRecordUnderpayment = vi.fn()
vi.mock('@/lib/invoices/customer-credit-recording', () => ({
  recordCustomerOverpayment: (...args: unknown[]) => mockRecordOverpayment(...args),
  recordInvoiceUnderpayment: (...args: unknown[]) => mockRecordUnderpayment(...args),
}))

const mockEmit = vi.fn()
vi.mock('@/lib/events', () => ({
  eventBus: { emit: (...args: unknown[]) => mockEmit(...args) },
}))

import { markInvoicePaid } from '../mark-paid-service'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const COMPANY_ID = 'company-1'
const USER_ID = 'user-1'

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mockEmit.mockResolvedValue(undefined)
  mockRecordOverpayment.mockResolvedValue({ creditId: 'credit-1' })
  mockRecordUnderpayment.mockResolvedValue(undefined)
})

describe('markInvoicePaid', () => {
  it('books a full payment under faktureringsmetoden and records the payment row', async () => {
    const invoice = makeInvoice({
      id: 'inv-1',
      status: 'sent',
      total: 12500,
      remaining_amount: 12500,
      customer: makeCustomer(),
    } as never)

    enqueue({ data: invoice })                     // invoice fetch
    enqueue({ data: { accounting_method: 'accrual' } }) // company_settings (accounting_method only)
    enqueue({ data: { entity_type: 'enskild_firma' } }) // companies (canonical entity type, B13)
    enqueue({ data: { ...invoice, status: 'paid', remaining_amount: 0, paid_amount: 12500 } }) // update
    enqueue({ data: { id: 'pay-1' } })             // invoice_payments insert

    mockCreateInvoicePaymentJournalEntry.mockResolvedValue({ id: 'je-1' })

    const result = await markInvoicePaid(supabase as never, COMPANY_ID, USER_ID, {
      invoiceId: 'inv-1',
      paymentDate: '2026-05-12',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.newStatus).toBe('paid')
    expect(result.journalEntryId).toBe('je-1')
    expect(result.paymentId).toBe('pay-1')
    expect(result.appliedAmount).toBe(12500)
    expect(result.overpaymentAmount).toBe(0)
    expect(mockCreateInvoicePaymentJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      USER_ID,
      expect.objectContaining({ id: 'inv-1' }),
      '2026-05-12',
      undefined,
      expect.anything(),
      12500,
    )
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'invoice.paid' }),
    )
  })

  it('uses cash-basis booking for a never-booked invoice under kontantmetoden', async () => {
    const invoice = makeInvoice({
      id: 'inv-2',
      status: 'sent',
      total: 5000,
      remaining_amount: 5000,
      customer: makeCustomer(),
    } as never)

    enqueue({ data: invoice })
    enqueue({ data: { accounting_method: 'cash' } })
    enqueue({ data: { entity_type: 'enskild_firma' } }) // companies (canonical entity type, B13)
    enqueue({ data: { ...invoice, status: 'paid', remaining_amount: 0, paid_amount: 5000 } })
    enqueue({ data: { id: 'pay-2' } })

    mockCreateInvoiceCashEntry.mockResolvedValue({ id: 'je-cash' })

    const result = await markInvoicePaid(supabase as never, COMPANY_ID, USER_ID, {
      invoiceId: 'inv-2',
    })

    expect(result.ok).toBe(true)
    expect(mockCreateInvoiceCashEntry).toHaveBeenCalled()
    expect(mockCreateInvoicePaymentJournalEntry).not.toHaveBeenCalled()
  })

  it('records a partial payment as partially_paid with an underpayment ledger row', async () => {
    const invoice = makeInvoice({
      id: 'inv-3',
      status: 'sent',
      total: 10000,
      remaining_amount: 10000,
      customer: makeCustomer(),
    } as never)

    enqueue({ data: invoice })
    enqueue({ data: { accounting_method: 'accrual' } })
    enqueue({ data: { entity_type: 'enskild_firma' } }) // companies (canonical entity type, B13)
    enqueue({
      data: { ...invoice, status: 'partially_paid', remaining_amount: 6000, paid_amount: 4000 },
    })
    enqueue({ data: { id: 'pay-3' } })

    mockCreateInvoicePaymentJournalEntry.mockResolvedValue({ id: 'je-3' })

    const result = await markInvoicePaid(supabase as never, COMPANY_ID, USER_ID, {
      invoiceId: 'inv-3',
      paymentAmount: 4000,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.newStatus).toBe('partially_paid')
    expect(result.appliedAmount).toBe(4000)
    expect(result.newRemaining).toBe(6000)
    expect(mockRecordUnderpayment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ invoiceId: 'inv-3', amount: 6000 }),
    )
  })

  it('routes an overpayment through the customer-credit lines and ledger', async () => {
    const invoice = makeInvoice({
      id: 'inv-4',
      status: 'sent',
      total: 10000,
      remaining_amount: 10000,
      customer: makeCustomer(),
    } as never)

    enqueue({ data: invoice })
    enqueue({ data: { accounting_method: 'accrual' } })
    enqueue({ data: { entity_type: 'enskild_firma' } }) // companies (canonical entity type, B13)
    enqueue({ data: { ...invoice, status: 'paid', remaining_amount: 0, paid_amount: 10000 } })
    enqueue({ data: { id: 'pay-4' } })

    mockFindFiscalPeriod.mockResolvedValue('fp-1')
    mockCreateJournalEntry.mockResolvedValue({ id: 'je-over' })

    const result = await markInvoicePaid(supabase as never, COMPANY_ID, USER_ID, {
      invoiceId: 'inv-4',
      paymentAmount: 12000,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.appliedAmount).toBe(10000)
    expect(result.overpaymentAmount).toBe(2000)
    expect(result.customerCreditId).toBe('credit-1')
    expect(mockCreateJournalEntry).toHaveBeenCalled()
    expect(mockRecordOverpayment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ amount: 2000 }),
    )
  })

  it('rejects unbalanced custom lines', async () => {
    const invoice = makeInvoice({
      id: 'inv-5',
      status: 'sent',
      total: 10000,
      remaining_amount: 10000,
    })
    enqueue({ data: invoice })

    const result = await markInvoicePaid(supabase as never, COMPANY_ID, USER_ID, {
      invoiceId: 'inv-5',
      customLines: [
        { account_number: '1930', debit_amount: 10000, credit_amount: 0 },
        { account_number: '1510', debit_amount: 0, credit_amount: 8000 },
      ],
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('INVOICE_PAID_LINES_UNBALANCED')
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('rejects non-payable statuses', async () => {
    const invoice = makeInvoice({ id: 'inv-6', status: 'paid' })
    enqueue({ data: invoice })

    const result = await markInvoicePaid(supabase as never, COMPANY_ID, USER_ID, {
      invoiceId: 'inv-6',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('INVOICE_PAID_NOT_PAYABLE')
  })

  it('cancels the orphaned journal entry and documents the gap on a lost race', async () => {
    const invoice = makeInvoice({
      id: 'inv-7',
      status: 'sent',
      total: 10000,
      remaining_amount: 10000,
      customer: makeCustomer(),
    } as never)

    enqueue({ data: invoice })
    enqueue({ data: { accounting_method: 'accrual' } })
    enqueue({ data: { entity_type: 'enskild_firma' } }) // companies (canonical entity type, B13)
    // Race-guarded update matches no row (status flipped concurrently).
    enqueue({ data: null })
    // Orphan JE lookup for the gap explanation.
    enqueue({ data: { fiscal_period_id: 'fp-1', voucher_series: 'A', voucher_number: 42 } })
    // JE cancel update + gap explanation insert.
    enqueue({ data: null })
    enqueue({ data: null })

    mockCreateInvoicePaymentJournalEntry.mockResolvedValue({ id: 'je-orphan' })

    const result = await markInvoicePaid(supabase as never, COMPANY_ID, USER_ID, {
      invoiceId: 'inv-7',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('INVOICE_PAID_RACE')
  })
})
