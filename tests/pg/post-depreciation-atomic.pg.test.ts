import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertChartAccounts, seedCompany } from '@/tests/pg/fixtures'
import { getPool, openUserTx } from '@/tests/pg/setup'

/** Covers 20260925123000_post_depreciation_atomic. */

async function setup() {
  const s = await seedCompany()
  await insertChartAccounts({ userId: s.userId, companyId: s.companyId, accountNumbers: ['1229', '7832'] })
  const asset = async () => {
    const id = randomUUID()
    await getPool().query(
      `INSERT INTO public.assets (id, user_id, company_id, name, category, acquisition_date, acquisition_cost,
         useful_life_months, bas_asset_account, bas_accumulated_account, bas_expense_account)
       VALUES ($1, $2, $3, 'Dator', 'computer', '2025-01-01', 30000, 60, '1220', '1229', '7832')`,
      [id, s.userId, s.companyId],
    )
    return id
  }
  const draft = async (balanced = true) => {
    const id = randomUUID()
    await getPool().query(
      `INSERT INTO public.journal_entries (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series, entry_date, description, source_type, status)
       VALUES ($1, $2, $3, $4, 0, 'A', '2026-06-30', 'Avskrivning', 'year_end_depreciation', 'draft')`,
      [id, s.userId, s.companyId, s.fiscalPeriodId],
    )
    await getPool().query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, '7832', 6000, 0), ($1, '1229', 0, $2)`,
      [id, balanced ? 6000 : 5000],
    )
    return id
  }
  return { ...s, asset, draft }
}

async function post(userId: string, companyId: string, periodId: string, items: unknown[]) {
  const tx = await openUserTx(userId)
  try {
    const { rows } = await tx.client.query(`SELECT public.post_depreciation_batch($1, $2, $3, $4::jsonb) AS res`, [companyId, userId, periodId, JSON.stringify(items)])
    await tx.commit()
    return rows[0].res
  } catch (err) {
    await tx.rollback()
    throw err
  }
}

describe('post_depreciation_batch', () => {
  it('commits every voucher and links each schedule row', async () => {
    const s = await setup()
    const [a1, a2] = [await s.asset(), await s.asset()]
    const [e1, e2] = [await s.draft(), await s.draft()]
    const res = await post(s.userId, s.companyId, s.fiscalPeriodId, [
      { asset_id: a1, journal_entry_id: e1, amount: 6000 },
      { asset_id: a2, journal_entry_id: e2, amount: 6000 },
    ])
    expect(res).toHaveLength(2)
    const { rows } = await getPool().query(`SELECT status FROM public.journal_entries WHERE id = ANY($1)`, [[e1, e2]])
    expect(rows.every((r) => r.status === 'posted')).toBe(true)
    const sched = await getPool().query(`SELECT count(*)::int AS n FROM public.depreciation_schedules WHERE journal_entry_id = ANY($1)`, [[e1, e2]])
    expect(sched.rows[0].n).toBe(2)
  })

  it('posts nothing when one voucher does not balance', async () => {
    const s = await setup()
    const [a1, a2] = [await s.asset(), await s.asset()]
    const [e1, e2] = [await s.draft(), await s.draft(false)]
    await expect(post(s.userId, s.companyId, s.fiscalPeriodId, [
      { asset_id: a1, journal_entry_id: e1, amount: 6000 },
      { asset_id: a2, journal_entry_id: e2, amount: 6000 },
    ])).rejects.toBeDefined()
    const { rows } = await getPool().query(`SELECT status FROM public.journal_entries WHERE id = ANY($1)`, [[e1, e2]])
    expect(rows.every((r) => r.status === 'draft')).toBe(true)
    const sched = await getPool().query(`SELECT count(*)::int AS n FROM public.depreciation_schedules WHERE asset_id = ANY($1)`, [[a1, a2]])
    expect(sched.rows[0].n).toBe(0)
  })

  it('refuses to depreciate an asset twice in a period', async () => {
    const s = await setup()
    const a1 = await s.asset()
    await post(s.userId, s.companyId, s.fiscalPeriodId, [{ asset_id: a1, journal_entry_id: await s.draft(), amount: 6000 }])
    const second = await s.draft()
    await expect(post(s.userId, s.companyId, s.fiscalPeriodId, [{ asset_id: a1, journal_entry_id: second, amount: 6000 }]))
      .rejects.toMatchObject({ code: '23505' })
    const { rows } = await getPool().query(`SELECT status FROM public.journal_entries WHERE id = $1`, [second])
    expect(rows[0].status).toBe('draft')
  })
})
