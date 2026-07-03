import { describe, it, expect } from 'vitest'
import { buildNonRecourseLines, buildRecourseLines } from '../accounting'

function sum(lines: Array<{ debit_amount: number; credit_amount: number }>) {
  return {
    debit: lines.reduce((s, l) => s + l.debit_amount, 0),
    credit: lines.reduce((s, l) => s + l.credit_amount, 0),
  }
}

describe('buildNonRecourseLines (fakturaförsäljning)', () => {
  it('books payout 1930 + fee 6064 against full receivable 1510', () => {
    const lines = buildNonRecourseLines({
      invoiceAmount: 12500,
      payoutAmount: 12125,
      feeAmount: 375,
      invoiceTag: 'faktura F-1001',
    })

    expect(lines).toHaveLength(3)
    const bank = lines.find((l) => l.account_number === '1930')
    const fee = lines.find((l) => l.account_number === '6064')
    const ar = lines.find((l) => l.account_number === '1510')

    expect(bank?.debit_amount).toBe(12125)
    expect(fee?.debit_amount).toBe(375)
    expect(ar?.credit_amount).toBe(12500)

    const { debit, credit } = sum(lines)
    expect(debit).toBe(credit)
  })

  it('throws when payout + fee does not equal the invoice amount', () => {
    expect(() =>
      buildNonRecourseLines({
        invoiceAmount: 12500,
        payoutAmount: 12000,
        feeAmount: 375,
        invoiceTag: 'F-1',
      }),
    ).toThrow(/balanserar inte/)
  })

  it('handles öre amounts without drift', () => {
    const lines = buildNonRecourseLines({
      invoiceAmount: 999.99,
      payoutAmount: 969.99,
      feeAmount: 30,
      invoiceTag: 'F-2',
    })
    const { debit, credit } = sum(lines)
    expect(debit).toBeCloseTo(credit, 2)
  })
})

describe('buildRecourseLines (fakturabelåning)', () => {
  it('reclasses 1510 → 1512 and books the loan on 2330', () => {
    const lines = buildRecourseLines({
      invoiceAmount: 12500,
      payoutAmount: 12125,
      feeAmount: 375,
      invoiceTag: 'faktura F-1001',
    })

    expect(lines).toHaveLength(5)
    const pledged = lines.find((l) => l.account_number === '1512')
    const ar = lines.find((l) => l.account_number === '1510')
    const bank = lines.find((l) => l.account_number === '1930')
    const fee = lines.find((l) => l.account_number === '6064')
    const loan = lines.find((l) => l.account_number === '2330')

    expect(pledged?.debit_amount).toBe(12500)
    expect(ar?.credit_amount).toBe(12500)
    expect(bank?.debit_amount).toBe(12125)
    expect(fee?.debit_amount).toBe(375)
    expect(loan?.credit_amount).toBe(12500)

    const { debit, credit } = sum(lines)
    expect(debit).toBe(credit)
  })

  it('never books VAT lines (financial service is exempt)', () => {
    const nonRecourse = buildNonRecourseLines({
      invoiceAmount: 1000,
      payoutAmount: 970,
      feeAmount: 30,
      invoiceTag: 'F-3',
    })
    const recourse = buildRecourseLines({
      invoiceAmount: 1000,
      payoutAmount: 970,
      feeAmount: 30,
      invoiceTag: 'F-3',
    })
    for (const line of [...nonRecourse, ...recourse]) {
      expect(line.account_number.startsWith('26')).toBe(false)
    }
  })
})
