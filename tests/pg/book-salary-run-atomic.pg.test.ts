import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertBalancedLines, insertChartAccounts, insertDraftJournalEntry, seedCompany } from '@/tests/pg/fixtures'
import { getPool, openUserTx, withUserContext } from '@/tests/pg/setup'

/** Covers 20260925121000_book_salary_run_atomic. */

async function paidRun() {
  const s = await seedCompany()
  await insertChartAccounts({ userId: s.userId, companyId: s.companyId, accountNumbers: ['1930', '3001', '7210'] })
  const runId = randomUUID()
  await getPool().query(
    `INSERT INTO public.salary_runs (id, company_id, user_id, period_year, period_month, payment_date, status)
     VALUES ($1, $2, $3, 2026, 5, '2026-05-25', 'paid')`,
    [runId, s.companyId, s.userId],
  )
  const draft = async (balanced = true) => {
    const id = await insertDraftJournalEntry({ ...s, entryDate: '2026-05-25', voucherSeries: 'L' })
    await getPool().query(`UPDATE public.journal_entries SET source_type = 'salary_payment', source_id = $2 WHERE id = $1`, [id, runId])
    if (balanced) await insertBalancedLines(id, 1000)
    else await getPool().query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount) VALUES ($1, '7210', 1000, 0), ($1, '1930', 0, 900)`,
      [id],
    )
    return id
  }
  return { ...s, runId, draft }
}

const book = (userId: string, companyId: string, runId: string, salary: string, avgifter: string | null) =>
  withUserContext(userId, async (c) => {
    await c.query(`SELECT public.book_salary_run($1, $2, $3, $4, NULL, NULL, $5)`, [companyId, runId, salary, avgifter, userId])
    const run = await c.query(`SELECT status, salary_entry_id, avgifter_entry_id FROM public.salary_runs WHERE id = $1`, [runId])
    const entries = await c.query(`SELECT id, status, voucher_number FROM public.journal_entries WHERE source_id = $1 ORDER BY voucher_number`, [runId])
    return { run: run.rows[0], entries: entries.rows }
  })

describe('book_salary_run', () => {
  it('posts every voucher and books the run in one transaction', async () => {
    const r = await paidRun()
    const salary = await r.draft()
    const avgifter = await r.draft()
    const { run, entries } = await book(r.userId, r.companyId, r.runId, salary, avgifter)
    expect(run).toMatchObject({ status: 'booked', salary_entry_id: salary, avgifter_entry_id: avgifter })
    expect(entries.map((e) => e.status)).toEqual(['posted', 'posted'])
    expect(entries.every((e) => e.voucher_number > 0)).toBe(true)
  })

  it('posts nothing when one voucher does not balance', async () => {
    const r = await paidRun()
    const salary = await r.draft()
    const bad = await r.draft(false)
    // The balance check is a deferred constraint trigger: it fires at COMMIT,
    // so this test must really commit.
    const tx = await openUserTx(r.userId)
    try {
      await tx.client.query(`SELECT public.book_salary_run($1, $2, $3, $4, NULL, NULL, $5)`, [r.companyId, r.runId, salary, bad, r.userId])
      await expect(tx.commit()).rejects.toBeDefined()
    } catch (err) {
      await tx.rollback()
      expect(err).toBeDefined()
    }
    const { rows } = await getPool().query(`SELECT status FROM public.journal_entries WHERE source_id = $1`, [r.runId])
    expect(rows.every((e) => e.status === 'draft')).toBe(true)
    const run = await getPool().query(`SELECT status FROM public.salary_runs WHERE id = $1`, [r.runId])
    expect(run.rows[0].status).toBe('paid')
  })

  it('refuses a run that is not paid', async () => {
    const r = await paidRun()
    const salary = await r.draft()
    await getPool().query(`UPDATE public.salary_runs SET status = 'approved' WHERE id = $1`, [r.runId])
    await expect(book(r.userId, r.companyId, r.runId, salary, null)).rejects.toMatchObject({ code: '55000' })
  })

  it('refuses a voucher that belongs to something else', async () => {
    const r = await paidRun()
    const foreign = await insertDraftJournalEntry({ ...r, entryDate: '2026-05-25' })
    await insertBalancedLines(foreign)
    await expect(book(r.userId, r.companyId, r.runId, foreign, null)).rejects.toMatchObject({ code: '22023' })
  })
})
