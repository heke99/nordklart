import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertBalancedLines, insertDraftJournalEntry, seedCompany } from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/** Covers 20260925124000_ledger_indexes_and_account_sums. */
describe('account_period_sums', () => {
  it('sums posted vouchers per account with the report filters', async () => {
    const s = await seedCompany()
    // Posted fixture vouchers are 1930 D 1000 / 3001 C 1000 (lines are immutable once posted).
    await insertDraftJournalEntry({ ...s, entryDate: '2026-02-01', status: 'posted', voucherNumber: 1 })
    await insertDraftJournalEntry({ ...s, entryDate: '2026-03-01', status: 'posted', voucherNumber: 2 })
    const draft = await insertDraftJournalEntry({ ...s, entryDate: '2026-03-02' })
    await insertBalancedLines(draft, 9999)

    const sums = await withUserContext(s.userId, (c) => c.query(
      `SELECT account_number, debit::float AS d, credit::float AS c FROM public.account_period_sums($1, $2) ORDER BY account_number`,
      [s.companyId, s.fiscalPeriodId],
    ))
    expect(sums.rows).toEqual([
      { account_number: '1930', d: 2000, c: 0 },
      { account_number: '3001', d: 0, c: 2000 },
    ])

    const march = await withUserContext(s.userId, (c) => c.query(
      `SELECT account_number, debit::float AS d FROM public.account_period_sums($1, $2, '2026-03-01', '2026-03-31') WHERE account_number = '1930'`,
      [s.companyId, s.fiscalPeriodId],
    ))
    expect(march.rows[0].d).toBe(1000)
  })

  it('refuses a user outside the company', async () => {
    const s = await seedCompany()
    const outsider = await insertAuthUser()
    await expect(withUserContext(outsider, (c) => c.query(`SELECT * FROM public.account_period_sums($1, $2)`, [s.companyId, s.fiscalPeriodId])))
      .rejects.toMatchObject({ code: '42501' })
  })
})
