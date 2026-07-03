import { describe, it, expect } from 'vitest'
import { checkFinancingEligibility, type EligibilityInput } from '../eligibility'

const TODAY = new Date('2026-07-01T00:00:00Z')

function baseInput(overrides?: {
  invoice?: Partial<EligibilityInput['invoice']>
  customer?: Partial<NonNullable<EligibilityInput['customer']>> | null
  provider?: Partial<EligibilityInput['provider']>
}): EligibilityInput {
  return {
    invoice: {
      status: 'sent',
      total: 12500,
      remaining_amount: 12500,
      currency: 'SEK',
      due_date: '2026-07-30',
      credited_invoice_id: null,
      invoice_number: 'F-1001',
      deduction_total: 0,
      ...overrides?.invoice,
    },
    customer:
      overrides?.customer === null
        ? null
        : {
            name: 'Kund AB',
            org_number: '5566778899',
            customer_type: 'swedish_business',
            ...overrides?.customer,
          },
    provider: { min_amount: 1000, max_amount: null, ...overrides?.provider },
    today: TODAY,
  } as EligibilityInput
}

describe('checkFinancingEligibility', () => {
  it('accepts a sent, unpaid B2B SEK invoice within window', () => {
    expect(checkFinancingEligibility(baseInput())).toEqual([])
  })

  it('rejects drafts and paid invoices', () => {
    const draft = checkFinancingEligibility(baseInput({ invoice: { status: 'draft' } }))
    expect(draft.map((i) => i.code)).toContain('INVALID_STATUS')

    const paid = checkFinancingEligibility(baseInput({ invoice: { status: 'paid' } }))
    expect(paid.map((i) => i.code)).toContain('INVALID_STATUS')
  })

  it('rejects credit notes', () => {
    const issues = checkFinancingEligibility(
      baseInput({ invoice: { credited_invoice_id: 'orig-1' } }),
    )
    expect(issues.map((i) => i.code)).toContain('IS_CREDIT_NOTE')
  })

  it('rejects partially paid invoices', () => {
    const issues = checkFinancingEligibility(
      baseInput({ invoice: { remaining_amount: 5000 } }),
    )
    expect(issues.map((i) => i.code)).toContain('PARTIALLY_PAID')
  })

  it('rejects non-SEK invoices', () => {
    const issues = checkFinancingEligibility(baseInput({ invoice: { currency: 'EUR' } }))
    expect(issues.map((i) => i.code)).toContain('CURRENCY')
  })

  it('rejects ROT/RUT invoices', () => {
    const issues = checkFinancingEligibility(
      baseInput({
        invoice: { deduction_total: 3000, remaining_amount: 9500 },
      }),
    )
    expect(issues.map((i) => i.code)).toContain('ROT_RUT')
  })

  it('enforces provider min/max amounts', () => {
    const below = checkFinancingEligibility(
      baseInput({ invoice: { total: 500, remaining_amount: 500 } }),
    )
    expect(below.map((i) => i.code)).toContain('BELOW_MINIMUM')

    const above = checkFinancingEligibility(
      baseInput({ provider: { max_amount: 10000 } }),
    )
    expect(above.map((i) => i.code)).toContain('ABOVE_MAXIMUM')
  })

  it('rejects due dates too far ahead or severely overdue', () => {
    const tooFar = checkFinancingEligibility(
      baseInput({ invoice: { due_date: '2026-12-24' } }),
    )
    expect(tooFar.map((i) => i.code)).toContain('DUE_TOO_FAR')

    const overdue = checkFinancingEligibility(
      baseInput({ invoice: { status: 'overdue', due_date: '2026-05-01' } }),
    )
    expect(overdue.map((i) => i.code)).toContain('SEVERELY_OVERDUE')

    // Slightly overdue (< 30 days) is still fine.
    const slightlyOverdue = checkFinancingEligibility(
      baseInput({ invoice: { status: 'overdue', due_date: '2026-06-20' } }),
    )
    expect(slightlyOverdue).toEqual([])
  })

  it('requires a B2B customer with org number', () => {
    const b2c = checkFinancingEligibility(
      baseInput({ customer: { customer_type: 'individual' } }),
    )
    expect(b2c.map((i) => i.code)).toContain('B2C')

    const noOrg = checkFinancingEligibility(baseInput({ customer: { org_number: '' } }))
    expect(noOrg.map((i) => i.code)).toContain('CUSTOMER_ORG_MISSING')

    const missing = checkFinancingEligibility(baseInput({ customer: null }))
    expect(missing.map((i) => i.code)).toContain('CUSTOMER_MISSING')
  })

  it('all messages are Swedish', () => {
    const issues = checkFinancingEligibility(
      baseInput({
        invoice: {
          status: 'draft',
          currency: 'EUR',
          total: 100,
          remaining_amount: 50,
          credited_invoice_id: 'x',
          deduction_total: 10,
        },
        customer: { customer_type: 'individual', org_number: null },
      }),
    )
    expect(issues.length).toBeGreaterThan(4)
    for (const issue of issues) {
      expect(issue.message_sv).toMatch(/faktur|kund|belopp|SEK|finansier/i)
    }
  })
})
