import { describe, it, expect } from 'vitest'
import { getRiskLevel, isHighRisk, OPERATION_RISK_TIERS } from '../risk-tiers'

describe('risk-tiers', () => {
  it('classifies all currently-staged op types', () => {
    // Op types that exist in the pending_operations CHECK constraint today.
    const knownOps = [
      'categorize_transaction',
      'create_customer',
      'create_invoice',
      'mark_invoice_paid',
      'send_invoice',
      'mark_invoice_sent',
      'match_transaction_invoice',
    ]
    for (const op of knownOps) {
      expect(OPERATION_RISK_TIERS).toHaveProperty(op)
    }
  })

  it('treats sending invoices and marking paid as high risk', () => {
    expect(getRiskLevel('send_invoice')).toBe('high')
    expect(getRiskLevel('mark_invoice_paid')).toBe('high')
    expect(getRiskLevel('mark_invoice_sent')).toBe('high')
  })

  it('treats period close, year-end, and SIE import as high risk', () => {
    expect(getRiskLevel('close_period')).toBe('high')
    expect(getRiskLevel('lock_period')).toBe('high')
    expect(getRiskLevel('run_year_end')).toBe('high')
    expect(getRiskLevel('import_sie')).toBe('high')
    expect(getRiskLevel('set_opening_balances')).toBe('high')
  })

  it('treats customer creation as low risk (no booking impact)', () => {
    expect(getRiskLevel('create_customer')).toBe('low')
  })

  it('treats reversible bookings as medium risk', () => {
    expect(getRiskLevel('categorize_transaction')).toBe('medium')
    expect(getRiskLevel('match_transaction_invoice')).toBe('medium')
    expect(getRiskLevel('create_invoice')).toBe('medium')
    expect(getRiskLevel('uncategorize_transaction')).toBe('medium')
  })

  it('defaults unknown op types to high (fail-safe)', () => {
    expect(getRiskLevel('totally_unknown_op')).toBe('high')
    expect(isHighRisk('totally_unknown_op')).toBe(true)
  })

  it('isHighRisk returns true only for high-risk ops', () => {
    expect(isHighRisk('send_invoice')).toBe(true)
    expect(isHighRisk('create_customer')).toBe(false)
    expect(isHighRisk('categorize_transaction')).toBe(false)
  })

  // Phase 4: arbitrary-line bookkeeping primitives. These accept any account
  // and any amount from the caller, so they're HIGH despite being structurally
  // similar to uncategorize_transaction (which is medium).
  it('treats arbitrary-line voucher primitives as high risk', () => {
    expect(getRiskLevel('create_voucher')).toBe('high')
    expect(getRiskLevel('correct_entry')).toBe('high')
    expect(isHighRisk('create_voucher')).toBe(true)
    expect(isHighRisk('correct_entry')).toBe(true)
  })
})
