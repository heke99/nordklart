import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertBalancedLines, insertChartAccounts, insertDraftJournalEntry, seedCompany } from '@/tests/pg/fixtures'
import { getPool, withServiceRole } from '@/tests/pg/setup'

/** Covers 20261001140000_prior_period_correction_source. */
async function correctionDraft(s: Awaited<ReturnType<typeof seedCompany>>, closedPeriodId: string) {
  const id = await insertDraftJournalEntry({ ...s, entryDate: '2026-03-01' })
  await getPool().query(
    `UPDATE public.journal_entries SET source_type = 'prior_period_correction', source_id = $2 WHERE id = $1`,
    [id, closedPeriodId],
  )
  await insertBalancedLines(id)
  return id
}
const commit = (companyId: string, id: string) =>
  withServiceRole((c) => c.query(`SELECT public.commit_journal_entry($1, $2)`, [companyId, id]))

describe('prior_period_correction source type', () => {
  it('posts several corrections for errors in the same closed year', async () => {
    const s = await seedCompany()
    await insertChartAccounts({ userId: s.userId, companyId: s.companyId })
    const closedPeriodId = randomUUID()
    await commit(s.companyId, await correctionDraft(s, closedPeriodId))
    await commit(s.companyId, await correctionDraft(s, closedPeriodId))
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM public.journal_entries
        WHERE company_id = $1 AND source_type = 'prior_period_correction' AND source_id = $2 AND status = 'posted'`,
      [s.companyId, closedPeriodId],
    )
    expect(rows[0].n).toBe(2)
  })

  it('still rejects unknown source types', async () => {
    const s = await seedCompany()
    const id = await insertDraftJournalEntry({ ...s, entryDate: '2026-03-01' })
    await expect(
      getPool().query(`UPDATE public.journal_entries SET source_type = 'prior_year_fix' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23514' })
  })
})
