import { describe, it, expect, vi } from 'vitest'
import { createJournalEntry, ONE_VOUCHER_PER_SOURCE_TYPES } from '../engine'

function supabaseWithPosted(existing: unknown) {
  const insert = vi.fn()
  const q: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'limit', 'in', 'order']) q[m] = () => q
  q.maybeSingle = async () => ({ data: existing, error: null })
  q.insert = insert
  return { client: { from: () => q, rpc: vi.fn() } as never, insert }
}

const input = {
  fiscal_period_id: 'fp',
  entry_date: '2026-03-01',
  description: 'Faktura 1001',
  source_type: 'invoice_created' as const,
  source_id: 'inv-1',
  lines: [
    { account_number: '1510', debit_amount: 1250, credit_amount: 0 },
    { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
    { account_number: '2611', debit_amount: 0, credit_amount: 250 },
  ],
}

describe('createJournalEntry — one voucher per document', () => {
  it('returns the already posted voucher instead of booking the invoice twice', async () => {
    const existing = { id: 'je-1', status: 'posted', source_id: 'inv-1' }
    const { client, insert } = supabaseWithPosted(existing)
    const result = await createJournalEntry(client, 'c1', 'u1', input as never)
    expect(result).toBe(existing)
    expect(insert).not.toHaveBeenCalled()
  })

  it('covers the document source types', () => {
    expect([...ONE_VOUCHER_PER_SOURCE_TYPES].sort()).toEqual(
      ['bank_transaction', 'credit_note', 'invoice_created', 'supplier_credit_note', 'supplier_invoice_registered'],
    )
  })
})
