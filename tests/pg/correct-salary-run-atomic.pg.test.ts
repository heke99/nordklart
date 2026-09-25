import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertBalancedLines, insertChartAccounts, insertDraftJournalEntry, seedCompany } from '@/tests/pg/fixtures'
import { getPool, withServiceRole } from '@/tests/pg/setup'

/** Covers 20260925122000_correct_salary_run_atomic. */

async function bookedRun() {
  const s = await seedCompany()
  await insertChartAccounts({ userId: s.userId, companyId: s.companyId, accountNumbers: ['1930', '3001', '7210'] })
  const runId = randomUUID()
  await getPool().query(
    `INSERT INTO public.salary_runs (id, company_id, user_id, period_year, period_month, payment_date, status)
     VALUES ($1, $2, $3, 2026, 5, '2026-05-25', 'paid')`,
    [runId, s.companyId, s.userId],
  )
  const draft = async () => {
    const id = await insertDraftJournalEntry({ ...s, entryDate: '2026-05-25', voucherSeries: 'L' })
    await getPool().query(`UPDATE public.journal_entries SET source_type = 'salary_payment', source_id = $2 WHERE id = $1`, [id, runId])
    await insertBalancedLines(id, 1000)
    return id
  }
  const salary = await draft()
  const avgifter = await draft()
  await withServiceRole((c) => c.query(`SELECT public.book_salary_run($1, $2, $3, $4, NULL, NULL, $5)`, [s.companyId, runId, salary, avgifter, s.userId]))
  const { rows: [emp] } = await getPool().query<{ id: string }>(
    `INSERT INTO public.employees (company_id, user_id, first_name, last_name, personnummer, personnummer_last4, employment_start, monthly_salary)
     VALUES ($1, $2, 'Anna', 'Test', $3, '1234', '2025-01-01', 30000) RETURNING id`,
    [s.companyId, s.userId, `enc-${randomUUID()}`],
  )
  const { rows: [sre] } = await getPool().query<{ id: string }>(
    `INSERT INTO public.salary_run_employees (salary_run_id, employee_id, company_id, employment_degree, monthly_salary, salary_type)
     VALUES ($1, $2, $3, 100, 30000, 'monthly') RETURNING id`,
    [runId, emp.id, s.companyId],
  )
  await getPool().query(
    `INSERT INTO public.salary_line_items (salary_run_employee_id, company_id, item_type, description, amount, account_number)
     VALUES ($1, $2, 'monthly_salary', 'Grundlön', 30000, '7210'), ($1, $2, 'bonus', 'Bonus', 5000, '7210')`,
    [sre.id, s.companyId],
  )
  return { ...s, runId, salary, avgifter }
}

const plan = (fiscalPeriodId: string, runId: string) => ({
  fiscal_period_id: fiscalPeriodId, entry_date: '2026-06-01', description: 'Storno: Lön', source_type: 'storno',
  source_id: runId, voucher_series: 'L',
  lines: [
    { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
    { account_number: '3001', debit_amount: 1000, credit_amount: 0 },
  ],
})

describe('correct_salary_run', () => {
  it('reverses every voucher, marks the run corrected and copies it into a new draft run', async () => {
    const r = await bookedRun()
    const plans = { [r.salary]: plan(r.fiscalPeriodId, r.runId), [r.avgifter]: plan(r.fiscalPeriodId, r.runId) }
    const { rows } = await withServiceRole((c) => c.query(
      `SELECT public.correct_salary_run($1, $2, $3, $4::jsonb, '2026-06-01') AS res`,
      [r.companyId, r.userId, r.runId, JSON.stringify(plans)],
    ))
    const res = rows[0].res
    expect(res.reversed_entry_count).toBe(2)
    const originals = await getPool().query(`SELECT status FROM public.journal_entries WHERE id = ANY($1)`, [[r.salary, r.avgifter]])
    expect(originals.rows.every((e) => e.status === 'reversed')).toBe(true)
    const run = await getPool().query(`SELECT status FROM public.salary_runs WHERE id = $1`, [r.runId])
    expect(run.rows[0].status).toBe('corrected')
    const copy = await getPool().query(
      `SELECT count(*)::int AS n FROM public.salary_line_items li JOIN public.salary_run_employees s ON s.id = li.salary_run_employee_id
        WHERE s.salary_run_id = $1`, [res.correction_run.id],
    )
    expect(copy.rows[0].n).toBe(2)
    expect(res.correction_run).toMatchObject({ status: 'draft', is_correction: true, corrects_run_id: r.runId })
  })

  it('changes nothing when a storno plan is missing', async () => {
    const r = await bookedRun()
    await expect(withServiceRole((c) => c.query(
      `SELECT public.correct_salary_run($1, $2, $3, $4::jsonb, '2026-06-01')`,
      [r.companyId, r.userId, r.runId, JSON.stringify({ [r.salary]: plan(r.fiscalPeriodId, r.runId) })],
    ))).rejects.toMatchObject({ code: '22023' })
    const originals = await getPool().query(`SELECT status FROM public.journal_entries WHERE id = ANY($1)`, [[r.salary, r.avgifter]])
    expect(originals.rows.every((e) => e.status === 'posted')).toBe(true)
    const run = await getPool().query(`SELECT status FROM public.salary_runs WHERE id = $1`, [r.runId])
    expect(run.rows[0].status).toBe('booked')
  })
})
