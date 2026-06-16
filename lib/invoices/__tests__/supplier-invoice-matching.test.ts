import { describe, it, expect } from 'vitest'
import { findSupplierInvoiceMatch } from '../supplier-invoice-matching'
import { makeTransaction, makeSupplierInvoice, makeSupplier } from '@/tests/helpers'

describe('findSupplierInvoiceMatch', () => {
  const supplier = makeSupplier({
    name: 'Kontorsbolaget AB',
    bankgiro: '123-4567',
    plusgiro: '987654-3',
  })

  it('returns null for empty invoice list', () => {
    const tx = makeTransaction({ amount: -1000 })
    expect(findSupplierInvoiceMatch(tx, [])).toBeNull()
  })

  it('returns null for zero-amount transactions', () => {
    const tx = makeTransaction({ amount: 0 })
    const inv = makeSupplierInvoice({ status: 'registered', remaining_amount: 1000 })
    expect(findSupplierInvoiceMatch(tx, [inv])).toBeNull()
  })

  it('skips paid invoices (remaining_amount = 0)', () => {
    const tx = makeTransaction({ amount: -1000, reference: '12345' })
    const inv = makeSupplierInvoice({
      status: 'registered',
      remaining_amount: 0,
      payment_reference: '12345',
    })
    expect(findSupplierInvoiceMatch(tx, [inv])).toBeNull()
  })

  it('skips invoices with non-matching status', () => {
    const tx = makeTransaction({ amount: -1000, reference: '12345' })
    const inv = makeSupplierInvoice({
      status: 'paid',
      remaining_amount: 1000,
      payment_reference: '12345',
    })
    expect(findSupplierInvoiceMatch(tx, [inv])).toBeNull()
  })

  // Pass 1: Payment reference
  it('matches by payment reference with confidence 0.98', () => {
    const tx = makeTransaction({ amount: -5000, reference: '73100 12345 67890' })
    const inv = makeSupplierInvoice({
      status: 'registered',
      remaining_amount: 5000,
      payment_reference: '731001234567890',
    })

    const result = findSupplierInvoiceMatch(tx, [inv])

    expect(result).not.toBeNull()
    expect(result!.confidence).toBe(0.98)
    expect(result!.matchMethod).toBe('payment_reference')
  })

  // Pass 2: Amount + bankgiro
  it('matches by exact amount + bankgiro in description with confidence 0.92', () => {
    const tx = makeTransaction({
      amount: -10000,
      description: 'Betalning BG 1234567 Kontorsbolaget',
    })
    const inv = makeSupplierInvoice({
      status: 'approved',
      remaining_amount: 10000,
      supplier: { ...supplier, bankgiro: '123-4567' },
    })

    const result = findSupplierInvoiceMatch(tx, [inv])

    expect(result).not.toBeNull()
    expect(result!.confidence).toBe(0.92)
    expect(result!.matchMethod).toBe('amount_bankgiro')
  })

  // Pass 3: Amount + date
  it('matches by exact amount + due date within 5 days with confidence 0.85', () => {
    const tx = makeTransaction({
      amount: -10000,
      date: '2024-07-03', // 2 days after due date
    })
    const inv = makeSupplierInvoice({
      status: 'registered',
      remaining_amount: 10000,
      due_date: '2024-07-01',
    })

    const result = findSupplierInvoiceMatch(tx, [inv])

    expect(result).not.toBeNull()
    expect(result!.confidence).toBe(0.85)
    expect(result!.matchMethod).toBe('amount_date')
  })

  it('does not match when date difference exceeds 5 days', () => {
    const tx = makeTransaction({
      amount: -10000,
      date: '2024-07-10', // 9 days after due date
      description: 'random payment',
    })
    const inv = makeSupplierInvoice({
      status: 'registered',
      remaining_amount: 10000,
      due_date: '2024-07-01',
    })

    const result = findSupplierInvoiceMatch(tx, [inv])

    expect(result).toBeNull()
  })

  // Pass 4: Fuzzy amount + name
  it('matches by fuzzy amount + supplier name in description with confidence 0.70', () => {
    const tx = makeTransaction({
      amount: -10000,
      description: 'Betalning Kontorsbolaget',
    })
    const inv = makeSupplierInvoice({
      status: 'registered',
      remaining_amount: 10000,
      due_date: '2024-01-01', // far away date — won't match pass 3
      supplier: { ...supplier, name: 'Kontorsbolaget AB' },
    })

    const result = findSupplierInvoiceMatch(tx, [inv])

    expect(result).not.toBeNull()
    expect(result!.confidence).toBe(0.70)
    expect(result!.matchMethod).toBe('fuzzy_name')
  })

  it('prefers higher-confidence matches', () => {
    const tx = makeTransaction({
      amount: -5000,
      date: '2024-07-02',
      reference: '999888777',
    })

    const invoiceRef = makeSupplierInvoice({
      status: 'registered',
      remaining_amount: 5000,
      payment_reference: '999888777',
      due_date: '2024-07-01',
    })

    const invoiceDate = makeSupplierInvoice({
      status: 'registered',
      remaining_amount: 5000,
      due_date: '2024-07-01',
    })

    // Payment reference match should win (0.98 > 0.85)
    const result = findSupplierInvoiceMatch(tx, [invoiceDate, invoiceRef])

    expect(result).not.toBeNull()
    expect(result!.confidence).toBe(0.98)
    expect(result!.matchMethod).toBe('payment_reference')
  })

  it('handles öresavrundning (±0.01 fuzzy)', () => {
    const tx = makeTransaction({
      amount: -999.99,
      description: 'Betalning Kontorsbolaget faktura',
    })
    const inv = makeSupplierInvoice({
      status: 'registered',
      remaining_amount: 1000,
      due_date: '2024-01-01',
      supplier: { ...supplier, name: 'Kontorsbolaget AB' },
    })

    const result = findSupplierInvoiceMatch(tx, [inv])

    expect(result).not.toBeNull()
    expect(result!.confidence).toBe(0.70)
  })

  it('ignores short words when matching supplier name', () => {
    const tx = makeTransaction({
      amount: -5000,
      description: 'AB payment', // "AB" is only 2 chars, should be ignored
    })
    const inv = makeSupplierInvoice({
      status: 'registered',
      remaining_amount: 5000,
      due_date: '2024-01-01',
      supplier: { ...supplier, name: 'AB' },
    })

    const result = findSupplierInvoiceMatch(tx, [inv])

    // "AB" is filtered out (length < 3), so no name match
    expect(result).toBeNull()
  })
})
