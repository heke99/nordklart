import { describe, it, expect, vi } from 'vitest'
import { fetchAccountSums } from '../account-sums'

describe('fetchAccountSums', () => {
  it('uses the database aggregate and never fetches rows', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ account_number: '1930', debit: '1500.50', credit: 200 }], error: null })
    const fallback = vi.fn()
    const sums = await fetchAccountSums(
      { rpc } as never,
      { companyId: 'c', fiscalPeriodId: 'fp', excludeSourceTypes: ['year_end', 'year_end_closing'], excludeEntryId: 'ob' },
      fallback,
    )
    expect(sums.get('1930')).toEqual({ debit: 1500.5, credit: 200 })
    expect(fallback).not.toHaveBeenCalled()
    expect(rpc).toHaveBeenCalledWith('account_period_sums', expect.objectContaining({
      p_company_id: 'c', p_fiscal_period_id: 'fp', p_exclude_entry_id: 'ob', p_exclude_source_types: ['year_end', 'year_end_closing'],
    }))
  })

  it('sums rows when the aggregate is not available', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: 'PGRST202' } })
    const sums = await fetchAccountSums({ rpc } as never, { companyId: 'c', fiscalPeriodId: 'fp' }, async () => [
      { account_number: '3001', debit_amount: 0, credit_amount: '1000' },
      { account_number: '3001', debit_amount: null, credit_amount: 250 },
    ])
    expect(sums.get('3001')).toEqual({ debit: 0, credit: 1250 })
  })
})
