import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany, insertCompanyMember } from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * Covers 20260925120000_salary_run_atomic_writes. Every call runs as the
 * authenticated owner (RLS applies — both functions are SECURITY INVOKER);
 * withUserContext rolls back, so assertions run inside the same transaction.
 */

async function seed() {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId, orgNumber: null })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  const employee = async (first: string, extra: Record<string, unknown> = {}) => {
    const cols = { first_name: first, last_name: 'Test', personnummer: `enc-${Math.random()}`, personnummer_last4: '1234',
      employment_start: '2025-01-01', monthly_salary: 40000, employment_degree: 100, salary_type: 'monthly', ...extra }
    const keys = Object.keys(cols)
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.employees (company_id, user_id, ${keys.join(', ')})
       VALUES ($1, $2, ${keys.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING id`,
      [companyId, userId, ...Object.values(cols)],
    )
    return rows[0].id
  }
  return { userId, companyId, employee }
}

const createRun = (c: PoolClient, companyId: string, userId: string, month: number) =>
  c.query(`SELECT * FROM public.create_salary_run_with_employees($1, $2, 2026, $3, $4)`,
    [companyId, userId, month, `2026-${String(month).padStart(2, '0')}-25`])

describe('create_salary_run_with_employees', () => {
  it('creates the run, eligible employees and base lines in one call', async () => {
    const { userId, companyId, employee } = await seed()
    await employee('Anna', { employment_degree: 80 })
    await employee('Ägare', { employment_type: 'company_owner' })
    await employee('Slutat', { employment_end: '2025-12-31' })
    await employee('Börjar', { employment_start: '2026-06-01' })

    await withUserContext(userId, async (c) => {
      const { rows } = await createRun(c, companyId, userId, 3)
      expect(rows[0].employee_count).toBe(2)
      const lines = await c.query(
        `SELECT e.first_name, li.item_type, li.amount::float AS amount, li.account_number
           FROM public.salary_line_items li
           JOIN public.salary_run_employees s ON s.id = li.salary_run_employee_id
           JOIN public.employees e ON e.id = s.employee_id
          WHERE s.salary_run_id = $1 ORDER BY e.first_name`,
        [rows[0].run.id],
      )
      expect(lines.rows).toEqual([
        { first_name: 'Anna', item_type: 'monthly_salary', amount: 32000, account_number: '7210' },
        { first_name: 'Ägare', item_type: 'monthly_salary', amount: 40000, account_number: '7220' },
      ])
    })
  })

  it('a second run for the same period fails as a whole', async () => {
    const { userId, companyId, employee } = await seed()
    await employee('Anna')
    await withUserContext(userId, async (c) => {
      await createRun(c, companyId, userId, 4)
      await c.query('SAVEPOINT dup')
      await expect(createRun(c, companyId, userId, 4)).rejects.toMatchObject({ code: '23505' })
      await c.query('ROLLBACK TO SAVEPOINT dup')
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM public.salary_run_employees s JOIN public.salary_runs r ON r.id = s.salary_run_id
          WHERE r.company_id = $1`, [companyId],
      )
      expect(rows[0].n).toBe(1)
    })
  })

  it('refuses a user without write access to the company', async () => {
    const { companyId } = await seed()
    const outsider = await insertAuthUser()
    await expect(withUserContext(outsider, (c) => createRun(c, companyId, outsider, 5)))
      .rejects.toMatchObject({ code: '42501' })
  })
})

describe('persist_salary_run_calculation', () => {
  const payload = (sreId: string, extraLine: Record<string, unknown> = {}) => JSON.stringify([{
    salary_run_employee_id: sreId,
    replace_item_types: ['sick_day2_14', 'semesterersattning'],
    replace_benefit_rows: true,
    insert_lines: [{ item_type: 'sick_day2_14', description: 'Sjuklön', quantity: 2, amount: 2500, account_number: '7281', sort_order: 100, ...extraLine }],
    update: { gross_salary: 40000, tax_withheld: 9000, net_salary: 31000, avgifter_amount: 12568, sick_days: 2, ytd_gross: 40000 },
  }])

  async function inDraftRun(fn: (c: PoolClient, r: { companyId: string; runId: string; sreId: string; userId: string }) => Promise<void>) {
    const s = await seed()
    await s.employee('Anna')
    await withUserContext(s.userId, async (c) => {
      const { rows } = await createRun(c, s.companyId, s.userId, 6)
      const runId = rows[0].run.id as string
      const sre = await c.query<{ id: string }>(`SELECT id FROM public.salary_run_employees WHERE salary_run_id = $1`, [runId])
      await fn(c, { companyId: s.companyId, runId, sreId: sre.rows[0].id, userId: s.userId })
    })
  }

  const persist = (c: PoolClient, companyId: string, runId: string, employees: string, totals = '{"total_gross": 40000, "total_tax": 9000}') =>
    c.query(`SELECT public.persist_salary_run_calculation($1, $2, $3::jsonb, $4::jsonb, '{"config_year": 2026}'::jsonb) AS run`,
      [companyId, runId, employees, totals])

  it('replaces derived lines, updates the snapshot and the run totals together (idempotent)', async () => {
    await inDraftRun(async (c, r) => {
      await persist(c, r.companyId, r.runId, payload(r.sreId))
      await persist(c, r.companyId, r.runId, payload(r.sreId))
      const lines = await c.query(`SELECT item_type FROM public.salary_line_items WHERE salary_run_employee_id = $1 ORDER BY item_type`, [r.sreId])
      expect(lines.rows.map((l) => l.item_type)).toEqual(['monthly_salary', 'sick_day2_14'])
      const snap = await c.query(`SELECT gross_salary::float AS g, sick_days::float AS s FROM public.salary_run_employees WHERE id = $1`, [r.sreId])
      expect(snap.rows[0]).toEqual({ g: 40000, s: 2 })
      const run = await c.query(`SELECT total_gross::float AS g, calculation_params FROM public.salary_runs WHERE id = $1`, [r.runId])
      expect(run.rows[0]).toMatchObject({ g: 40000, calculation_params: { config_year: 2026 } })
    })
  })

  it('writes nothing when any part fails', async () => {
    await inDraftRun(async (c, r) => {
      await c.query('SAVEPOINT p')
      await expect(persist(c, r.companyId, r.runId, payload(r.sreId, { description: null }), '{"total_gross": 1}')).rejects.toBeDefined()
      await c.query('ROLLBACK TO SAVEPOINT p')
      const run = await c.query(`SELECT total_gross FROM public.salary_runs WHERE id = $1`, [r.runId])
      expect(Number(run.rows[0].total_gross ?? 0)).toBe(0)
      const lines = await c.query(`SELECT count(*)::int AS n FROM public.salary_line_items WHERE salary_run_employee_id = $1`, [r.sreId])
      expect(lines.rows[0].n).toBe(1)
    })
  })

  it('refuses a run that is no longer a draft', async () => {
    await inDraftRun(async (c, r) => {
      await c.query(`UPDATE public.salary_runs SET status = 'review' WHERE id = $1`, [r.runId])
      await expect(persist(c, r.companyId, r.runId, '[]')).rejects.toMatchObject({ code: '55000' })
    })
  })

  it('refuses an employee row that is not on the run', async () => {
    await inDraftRun(async (c, r) => {
      await expect(persist(c, r.companyId, r.runId, payload('00000000-0000-4000-8000-000000000000'))).rejects.toMatchObject({ code: '22023' })
    })
  })
})
