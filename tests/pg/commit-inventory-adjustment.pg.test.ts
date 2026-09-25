import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { backendPid, getPool, openServiceRoleTx, waitUntilBlocked, withServiceRole, withUserContext } from '@/tests/pg/setup'

/** Covers 20260925132000_commit_inventory_adjustment. */

type Line = [account: string, debit: number, credit: number]

async function entry(s: { userId: string; companyId: string; fiscalPeriodId: string }, status: 'posted' | 'draft', source: string, date: string, lines: Line[]) {
  const id = randomUUID()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series, entry_date, description, source_type, status)
       VALUES ($1, $2, $3, $4, $5, 'A', $6, 'test', $7, $8)`,
      [id, s.userId, s.companyId, s.fiscalPeriodId, status === 'draft' ? 0 : Math.floor(Math.random() * 1e8) + 1, date, source, status],
    )
    for (const [account, debit, credit] of lines) {
      await client.query(
        `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount) VALUES ($1, $2, $3, $4)`,
        [id, account, debit, credit],
      )
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
  return id
}

async function setup() {
  const s = await seedCompany()
  await entry(s, 'posted', 'manual', '2026-03-01', [['1460', 100000, 0], ['1930', 0, 100000]])
  const draft = (lines: Line[] = [['1460', 20000, 0], ['4960', 0, 20000]]) =>
    entry(s, 'draft', 'year_end_inventory', '2026-12-31', lines)
  return { ...s, draft }
}

const commitSql = `SELECT public.commit_inventory_adjustment($1, $2, $3, $4::jsonb) AS r`

describe('commit_inventory_adjustment', () => {
  it('commits a draft computed from the current balance', async () => {
    const s = await setup()
    const d = await s.draft()
    await withServiceRole((c) => c.query(commitSql, [s.companyId, s.fiscalPeriodId, d, JSON.stringify({ '1460': 100000 })]))
    const { rows } = await getPool().query(`SELECT status FROM public.journal_entries WHERE id = $1`, [d])
    expect(rows[0].status).toBe('posted')
  })

  it('refuses a draft computed from a stale balance', async () => {
    const s = await setup()
    await expect(withServiceRole((c) => c.query(commitSql, [s.companyId, s.fiscalPeriodId, randomUUID(), JSON.stringify({ '1460': 100000 })])))
      .rejects.toMatchObject({ message: 'INVENTORY_DRAFT_INVALID' })
    const d = await s.draft()
    await expect(withServiceRole((c) => c.query(commitSql, [s.companyId, s.fiscalPeriodId, d, JSON.stringify({ '1460': 90000 })])))
      .rejects.toMatchObject({ message: 'INVENTORY_BALANCE_CHANGED' })
  })

  it('refuses lines outside the inventory account and its change account', async () => {
    const s = await setup()
    const d = await s.draft([['1460', 20000, 0], ['3001', 0, 20000]])
    await expect(withServiceRole((c) => c.query(commitSql, [s.companyId, s.fiscalPeriodId, d, JSON.stringify({ '1460': 100000 })])))
      .rejects.toMatchObject({ message: 'INVENTORY_DRAFT_INVALID' })
  })

  it('lets only one of two concurrent counts post', async () => {
    const s = await setup()
    const [d1, d2] = [await s.draft(), await s.draft()]
    const expected = JSON.stringify({ '1460': 100000 })
    const first = await openServiceRoleTx()
    const second = await openServiceRoleTx()
    try {
      await first.client.query(commitSql, [s.companyId, s.fiscalPeriodId, d1, expected])
      const secondPid = await backendPid(second.client)
      const pending = second.client.query(commitSql, [s.companyId, s.fiscalPeriodId, d2, expected]).then(
        () => 'ok',
        (err: { message: string }) => err.message,
      )
      expect(await waitUntilBlocked(secondPid)).toBe(true)
      await first.commit()
      expect(await pending).toBe('INVENTORY_BALANCE_CHANGED')
    } finally {
      await first.rollback()
      await second.rollback()
    }
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM public.journal_entries WHERE id = ANY($1) AND status = 'posted'`,
      [[d1, d2]],
    )
    expect(rows[0].n).toBe(1)
  })

  it('is not callable by an authenticated user', async () => {
    const s = await setup()
    await withUserContext(s.userId, async (c) => {
      await expect(c.query(commitSql, [s.companyId, s.fiscalPeriodId, randomUUID(), '{"1460":0}']))
        .rejects.toMatchObject({ code: '42501' })
    })
  })
})
