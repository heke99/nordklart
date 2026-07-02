/**
 * Unified payment-matching service tests — verification rules, payment
 * classification (exact/partial/over/underpayment), ambiguity and
 * recommended actions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createQueuedMockSupabase,
  makeTransaction,
  makeInvoice,
  makeSupplierInvoice,
  makeSupplier,
} from '@/tests/helpers'
import { matchTransactionToPayments } from '../payment-matching-service'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

beforeEach(() => {
  vi.clearAllMocks()
  reset()
})

describe('customer invoice matching', () => {
  it('exact OCR reference match recommends auto_settle', async () => {
    const invoice = makeInvoice({
      id: 'inv-1',
      invoice_number: 'F-2026001',
      status: 'sent',
      total: 12500,
      remaining_amount: 12500,
    })
    // invoices query, then the payment-voucher status-leak filter query
    enqueue({ data: [invoice] })
    enqueue({ data: [] })

    const tx = makeTransaction({ id: 'tx-1', amount: 12500, reference: 'F-2026001' })
    const result = await matchTransactionToPayments(supabase as never, 'company-1', tx)

    expect(result.best?.candidateType).toBe('customer_invoice')
    expect(result.best?.candidateId).toBe('inv-1')
    expect(result.best?.score).toBe(99)
    expect(result.best?.classification).toBe('exact')
    expect(result.best?.recommendedAction).toBe('auto_settle')
    expect(result.ambiguous).toBe(false)
  })

  it('classifies a partial payment and downgrades to review', async () => {
    const invoice = makeInvoice({
      id: 'inv-2',
      invoice_number: 'F-2026002',
      status: 'sent',
      total: 10000,
      remaining_amount: 10000,
    })
    enqueue({ data: [invoice] })
    enqueue({ data: [] })

    const tx = makeTransaction({ id: 'tx-2', amount: 4000, reference: 'F-2026002' })
    const result = await matchTransactionToPayments(supabase as never, 'company-1', tx)

    expect(result.best?.classification).toBe('partial')
    expect(result.best?.blockingReasons).toContain('not_exact_payment')
    expect(result.best?.recommendedAction).toBe('review')
    expect(result.best?.amountDifference).toBe(-6000)
  })

  it('classifies an overpayment and blocks silent settlement', async () => {
    const invoice = makeInvoice({
      id: 'inv-3',
      invoice_number: 'F-2026003',
      status: 'sent',
      total: 10000,
      remaining_amount: 10000,
    })
    enqueue({ data: [invoice] })
    enqueue({ data: [] })

    const tx = makeTransaction({ id: 'tx-3', amount: 12000, reference: 'F-2026003' })
    const result = await matchTransactionToPayments(supabase as never, 'company-1', tx)

    expect(result.best?.classification).toBe('overpayment')
    expect(result.best?.blockingReasons).toContain('overpayment_requires_credit')
    expect(result.best?.recommendedAction).toBe('review')
    expect(result.best?.amountDifference).toBe(2000)
  })

  it('classifies a small shortfall as underpayment', async () => {
    const invoice = makeInvoice({
      id: 'inv-4',
      invoice_number: 'F-2026004',
      status: 'sent',
      total: 10000,
      remaining_amount: 10000,
    })
    enqueue({ data: [invoice] })
    enqueue({ data: [] })

    const tx = makeTransaction({ id: 'tx-4', amount: 9996, reference: 'F-2026004' })
    const result = await matchTransactionToPayments(supabase as never, 'company-1', tx)

    expect(result.best?.classification).toBe('underpayment')
    expect(result.best?.blockingReasons).toContain('not_exact_payment')
  })

  it('flags ambiguity when two open invoices have the same amount', async () => {
    const invoiceA = makeInvoice({
      id: 'inv-a',
      invoice_number: 'F-1',
      status: 'sent',
      total: 5000,
      remaining_amount: 5000,
    })
    const invoiceB = makeInvoice({
      id: 'inv-b',
      invoice_number: 'F-2',
      status: 'sent',
      total: 5000,
      remaining_amount: 5000,
    })
    enqueue({ data: [invoiceA, invoiceB] })
    enqueue({ data: [] })

    // No OCR — amount-only match hits both.
    const tx = makeTransaction({ id: 'tx-5', amount: 5000, reference: null })
    const result = await matchTransactionToPayments(supabase as never, 'company-1', tx)

    expect(result.candidates.length).toBeGreaterThanOrEqual(2)
    expect(result.ambiguous).toBe(true)
    expect(result.best?.recommendedAction).toBe('review')
  })

  it('returns no candidates for an already linked transaction', async () => {
    const tx = makeTransaction({ id: 'tx-6', amount: 5000, invoice_id: 'inv-existing' })
    const result = await matchTransactionToPayments(supabase as never, 'company-1', tx)
    expect(result.candidates).toEqual([])
    expect(result.best).toBeNull()
  })
})

describe('supplier invoice matching', () => {
  it('exact payment-reference match produces a supplier candidate', async () => {
    const supplierInvoice = makeSupplierInvoice({
      id: 'si-1',
      status: 'approved',
      total: 10000,
      remaining_amount: 10000,
      payment_reference: '12345678',
    })
    const tx = makeTransaction({ id: 'tx-7', amount: -10000, reference: '1234 5678' })

    const result = await matchTransactionToPayments(supabase as never, 'company-1', tx, {
      unpaidSupplierInvoices: [supplierInvoice],
    })

    expect(result.best?.candidateType).toBe('supplier_invoice')
    expect(result.best?.candidateId).toBe('si-1')
    expect(result.best?.score).toBe(98)
    expect(result.best?.classification).toBe('exact')
    expect(result.best?.recommendedAction).toBe('auto_settle')
  })

  it('never matches an already paid supplier invoice', async () => {
    const paid = makeSupplierInvoice({
      id: 'si-paid',
      status: 'paid',
      total: 10000,
      remaining_amount: 0,
      payment_reference: '12345678',
    })
    const tx = makeTransaction({ id: 'tx-8', amount: -10000, reference: '12345678' })

    const result = await matchTransactionToPayments(supabase as never, 'company-1', tx, {
      unpaidSupplierInvoices: [paid],
    })

    expect(result.candidates).toEqual([])
  })

  it('flags ambiguity for two supplier invoices with the same amount and due date', async () => {
    const supplier = makeSupplier({ id: 'sup-1', name: 'Leverantör AB' })
    const siA = makeSupplierInvoice({
      id: 'si-a',
      status: 'approved',
      total: 5000,
      remaining_amount: 5000,
      due_date: '2024-06-15',
      supplier,
    } as never)
    const siB = makeSupplierInvoice({
      id: 'si-b',
      status: 'approved',
      total: 5000,
      remaining_amount: 5000,
      due_date: '2024-06-15',
      supplier,
    } as never)
    const tx = makeTransaction({ id: 'tx-9', amount: -5000, date: '2024-06-15', reference: null })

    const result = await matchTransactionToPayments(supabase as never, 'company-1', tx, {
      unpaidSupplierInvoices: [siA, siB],
    })

    expect(result.candidates.length).toBe(2)
    expect(result.ambiguous).toBe(true)
    expect(result.best?.recommendedAction).toBe('review')
  })

  it('blocks an income transaction from matching a supplier invoice', async () => {
    // Defensive: the service only matches suppliers for amount < 0, so an
    // income transaction yields no supplier candidates at all.
    const supplierInvoice = makeSupplierInvoice({
      id: 'si-2',
      status: 'approved',
      payment_reference: '999',
    })
    enqueue({ data: [] }) // invoices query for the income side
    enqueue({ data: [] })

    const tx = makeTransaction({ id: 'tx-10', amount: 10000, reference: '999' })
    const result = await matchTransactionToPayments(supabase as never, 'company-1', tx, {
      unpaidSupplierInvoices: [supplierInvoice],
    })

    expect(result.candidates.filter((c) => c.candidateType === 'supplier_invoice')).toEqual([])
  })
})
