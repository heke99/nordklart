import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertBalancedLines, insertChartAccounts, insertDraftJournalEntry, seedCompany } from '@/tests/pg/fixtures'
import { getPool, withServiceRole } from '@/tests/pg/setup'

/** Covers 20260925125000_one_posted_voucher_per_source. */
async function sourceDraft(s: Awaited<ReturnType<typeof seedCompany>>, sourceType: string, sourceId: string) {
  const id = await insertDraftJournalEntry({ ...s, entryDate: '2026-03-01' })
  await getPool().query(`UPDATE public.journal_entries SET source_type = $2, source_id = $3 WHERE id = $1`, [id, sourceType, sourceId])
  await insertBalancedLines(id)
  return id
}
const commit = (companyId: string, id: string) =>
  withServiceRole((c) => c.query(`SELECT public.commit_journal_entry($1, $2)`, [companyId, id]))

describe('one posted voucher per source document', () => {
  it('refuses a second posted invoice voucher for the same invoice', async () => {
    const s = await seedCompany()
    await insertChartAccounts({ userId: s.userId, companyId: s.companyId })
    const invoiceId = randomUUID()
    await commit(s.companyId, await sourceDraft(s, 'invoice_created', invoiceId))
    const second = await sourceDraft(s, 'invoice_created', invoiceId)
    await expect(commit(s.companyId, second)).rejects.toMatchObject({ code: '23505' })
  })

  it('allows several payment vouchers for one invoice', async () => {
    const s = await seedCompany()
    await insertChartAccounts({ userId: s.userId, companyId: s.companyId })
    const invoiceId = randomUUID()
    await commit(s.companyId, await sourceDraft(s, 'invoice_paid', invoiceId))
    await expect(commit(s.companyId, await sourceDraft(s, 'invoice_paid', invoiceId))).resolves.toBeDefined()
  })

  it('allows re-booking after the first voucher was reversed', async () => {
    const s = await seedCompany()
    await insertChartAccounts({ userId: s.userId, companyId: s.companyId })
    const txId = randomUUID()
    const first = await sourceDraft(s, 'bank_transaction', txId)
    await commit(s.companyId, first)
    await withServiceRole((c) => c.query(
      `SELECT public.reverse_journal_entry_v2($1, $2, $3, $4::jsonb, '2026-03-02')`,
      [s.companyId, s.userId, first, JSON.stringify({
        fiscal_period_id: s.fiscalPeriodId, entry_date: '2026-03-02', description: 'Storno', source_type: 'storno',
        source_id: txId, voucher_series: 'A',
        lines: [
          { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
          { account_number: '3001', debit_amount: 1000, credit_amount: 0 },
        ],
      })],
    ))
    await expect(commit(s.companyId, await sourceDraft(s, 'bank_transaction', txId))).resolves.toBeDefined()
  })
})
