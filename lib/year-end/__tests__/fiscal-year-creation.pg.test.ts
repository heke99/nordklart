import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getClient, getPool } from '@/tests/pg/setup'
import { insertAuthUser, insertCompany, insertCompanyMember } from '@/tests/pg/fixtures'

async function asService<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true)`)
    await client.query(`SELECT set_config('request.jwt.claim.role', 'service_role', true)`)
    const result = await run(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function seedOneOffCompany() {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  const { rows: products } = await getPool().query(
    `SELECT pr.id
     FROM public.platform_products pr
     JOIN public.platform_price_plans pp ON pp.product_id = pr.id
     WHERE pp.code = 'year_end_one_time'
     LIMIT 1`,
  )
  expect(products).toHaveLength(1)
  const purchaseId = randomUUID()
  await getPool().query(
    `INSERT INTO public.one_time_purchases
       (id, company_id, product_id, purchase_type, status, permanent_access,
        access_starts_at, paid_at, created_by)
     VALUES ($1,$2,$3,'year_end','paid',true,now(),now(),$4)`,
    [purchaseId, companyId, products[0].id, userId],
  )
  return { userId, companyId, purchaseId }
}

async function createYear(companyId: string, userId: string, requestId: string) {
  return asService(async (client) => {
    const { rows } = await client.query(
      `SELECT id, period_start, period_end
       FROM public.create_fiscal_year_atomic_internal(
         $1::uuid,$2::uuid,'2026','2026-01-01'::date,'2026-12-31'::date,$3
       )`,
      [companyId, userId, requestId],
    )
    return rows[0]
  })
}

describe('create_fiscal_year_atomic_internal', () => {
  it('creates and binds an unassigned one-off purchase atomically', async () => {
    const { userId, companyId, purchaseId } = await seedOneOffCompany()
    const period = await createYear(companyId, userId, 'req-create')
    expect(new Date(period.period_start).toISOString().slice(0, 10)).toBe('2026-01-01')
    expect(new Date(period.period_end).toISOString().slice(0, 10)).toBe('2026-12-31')

    const { rows: purchases } = await getPool().query(
      `SELECT fiscal_period_id,status FROM public.one_time_purchases WHERE id=$1`,
      [purchaseId],
    )
    expect(purchases[0].fiscal_period_id).toBe(period.id)
    expect(purchases[0].status).toBe('active')

    const { rows: projects } = await getPool().query(
      `SELECT fiscal_period_id,status FROM public.year_end_projects WHERE purchase_id=$1`,
      [purchaseId],
    )
    expect(projects).toHaveLength(1)
    expect(projects[0]).toMatchObject({ fiscal_period_id: period.id, status: 'awaiting_import' })
  })

  it('is idempotent and concurrency-safe for the same company and range', async () => {
    const { userId, companyId } = await seedOneOffCompany()
    const results = await Promise.all([
      createYear(companyId, userId, 'req-a'),
      createYear(companyId, userId, 'req-b'),
    ])
    expect(results[0].id).toBe(results[1].id)
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM public.fiscal_periods
       WHERE company_id=$1 AND period_start='2026-01-01' AND period_end='2026-12-31'`,
      [companyId],
    )
    expect(rows[0].n).toBe(1)
  })

  it('rejects an overlapping range without altering the existing year', async () => {
    const { userId, companyId } = await seedOneOffCompany()
    await createYear(companyId, userId, 'req-first')

    // The first year consumed (bound) the one-off purchase, so a second period
    // legitimately needs its own. Without this the call fails commercially with
    // ONE_OFF_YEAR_END_NOT_ACTIVE and never reaches the overlap validation this
    // test is about.
    const { rows: products } = await getPool().query<{ id: string }>(
      `SELECT pr.id
       FROM public.platform_products pr
       JOIN public.platform_price_plans pp ON pp.product_id = pr.id
       WHERE pp.code = 'year_end_one_time'
       LIMIT 1`,
    )
    await getPool().query(
      `INSERT INTO public.one_time_purchases
         (id, company_id, product_id, purchase_type, status, permanent_access,
          access_starts_at, paid_at, created_by)
       VALUES ($1,$2,$3,'year_end','paid',true,now(),now(),$4)`,
      [randomUUID(), companyId, products[0].id, userId],
    )

    await expect(asService((client) => client.query(
      `SELECT * FROM public.create_fiscal_year_atomic_internal(
        $1::uuid,$2::uuid,'Overlap','2026-06-01'::date,'2027-05-31'::date,'req-overlap'
      )`,
      [companyId, userId],
    ))).rejects.toThrow(/FISCAL_YEAR_OVERLAP/)
  })
})
