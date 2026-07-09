/**
 * pg-real coverage for migration 20260715130000:
 *
 *  - recurring_invoice_runs: unique (schedule_id, run_date) claim guard,
 *    company-scoped SELECT RLS, service-role-only writes.
 *  - replace_recurring_schedule_items RPC: atomic replace, tenant guard,
 *    viewer write denial, rollback on invalid payload.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompany, insertCompanyMember } from './fixtures'

async function seedScheduleFixture() {
  const ownerId = await insertAuthUser()
  const viewerId = await insertAuthUser()
  const outsiderId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: ownerId })
  await insertCompanyMember({ companyId, userId: ownerId, role: 'owner' })
  await insertCompanyMember({ companyId, userId: viewerId, role: 'viewer' })
  const otherCompanyId = await insertCompany({ createdBy: outsiderId })
  await insertCompanyMember({ companyId: otherCompanyId, userId: outsiderId, role: 'owner' })

  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, email)
     VALUES ($1, $2, $3, 'Kund AB', 'kund@test.invalid')`,
    [customerId, ownerId, companyId],
  )

  const scheduleId = randomUUID()
  await getPool().query(
    `INSERT INTO public.recurring_invoice_schedules
       (id, company_id, user_id, customer_id, name, day_of_month, next_run_date)
     VALUES ($1, $2, $3, $4, 'Retainer', 15, '2026-08-15')`,
    [scheduleId, companyId, ownerId, customerId],
  )
  await getPool().query(
    `INSERT INTO public.recurring_invoice_schedule_items
       (schedule_id, sort_order, description, quantity, unit, unit_price, vat_rate)
     VALUES ($1, 0, 'Konsultarvode', 10, 'tim', 1200, 25)`,
    [scheduleId],
  )

  return { ownerId, viewerId, outsiderId, companyId, otherCompanyId, customerId, scheduleId }
}

describe('recurring_invoice_runs', () => {
  let fx: Awaited<ReturnType<typeof seedScheduleFixture>>

  beforeAll(async () => {
    fx = await seedScheduleFixture()
  })

  it('rejects a duplicate claim for the same schedule + run_date (23505)', async () => {
    await getPool().query(
      `INSERT INTO public.recurring_invoice_runs (schedule_id, company_id, run_date, status)
       VALUES ($1, $2, '2026-08-15', 'running')`,
      [fx.scheduleId, fx.companyId],
    )

    await expect(
      getPool().query(
        `INSERT INTO public.recurring_invoice_runs (schedule_id, company_id, run_date, status)
         VALUES ($1, $2, '2026-08-15', 'running')`,
        [fx.scheduleId, fx.companyId],
      ),
    ).rejects.toMatchObject({ code: '23505' })

    // A different run date is a new claim and must succeed.
    await getPool().query(
      `INSERT INTO public.recurring_invoice_runs (schedule_id, company_id, run_date, status)
       VALUES ($1, $2, '2026-09-15', 'succeeded')`,
      [fx.scheduleId, fx.companyId],
    )
  })

  it('company members can read run history; outsiders cannot', async () => {
    const asOwner = await withUserContext(fx.ownerId, async (client) => {
      const { rows } = await client.query(
        `SELECT id FROM public.recurring_invoice_runs WHERE schedule_id = $1`,
        [fx.scheduleId],
      )
      return rows.length
    })
    expect(asOwner).toBeGreaterThan(0)

    const asOutsider = await withUserContext(fx.outsiderId, async (client) => {
      const { rows } = await client.query(
        `SELECT id FROM public.recurring_invoice_runs WHERE schedule_id = $1`,
        [fx.scheduleId],
      )
      return rows.length
    })
    expect(asOutsider).toBe(0)
  })

  it('authenticated members cannot insert run rows (service-role only)', async () => {
    await withUserContext(fx.ownerId, async (client) => {
      await expect(
        client.query(
          `INSERT INTO public.recurring_invoice_runs (schedule_id, company_id, run_date, status)
           VALUES ($1, $2, '2026-10-15', 'running')`,
          [fx.scheduleId, fx.companyId],
        ),
      ).rejects.toMatchObject({ code: '42501' })
    })
  })
})

describe('replace_recurring_schedule_items', () => {
  let fx: Awaited<ReturnType<typeof seedScheduleFixture>>

  beforeAll(async () => {
    fx = await seedScheduleFixture()
  })

  it('replaces items atomically for a writer', async () => {
    await withUserContext(fx.ownerId, async (client) => {
      await client.query(
        `SELECT public.replace_recurring_schedule_items($1, $2, $3::jsonb)`,
        [
          fx.scheduleId,
          fx.companyId,
          JSON.stringify([
            { description: 'Ny rad 1', quantity: 2, unit: 'st', unit_price: 500, vat_rate: 25 },
            { description: 'Ny rad 2', quantity: 1, unit: 'tim', unit_price: 900, vat_rate: null },
          ]),
        ],
      )
      const { rows } = await client.query(
        `SELECT description, sort_order, vat_rate
         FROM public.recurring_invoice_schedule_items
         WHERE schedule_id = $1 ORDER BY sort_order`,
        [fx.scheduleId],
      )
      expect(rows).toHaveLength(2)
      expect(rows[0].description).toBe('Ny rad 1')
      expect(rows[0].sort_order).toBe(0)
      expect(rows[1].vat_rate).toBeNull()
    })
  })

  it('rejects an empty item list and keeps the previous rows (atomic)', async () => {
    await withUserContext(fx.ownerId, async (client) => {
      await expect(
        client.query(`SELECT public.replace_recurring_schedule_items($1, $2, '[]'::jsonb)`, [
          fx.scheduleId,
          fx.companyId,
        ]),
      ).rejects.toMatchObject({ code: '22023' })
    })
    // Original seeded row still present (statement rolled back atomically).
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM public.recurring_invoice_schedule_items WHERE schedule_id = $1`,
      [fx.scheduleId],
    )
    expect(rows[0].n).toBeGreaterThan(0)
  })

  it('rolls back the delete when an item row is invalid (atomicity)', async () => {
    const before = await getPool().query(
      `SELECT count(*)::int AS n FROM public.recurring_invoice_schedule_items WHERE schedule_id = $1`,
      [fx.scheduleId],
    )
    await withUserContext(fx.ownerId, async (client) => {
      await expect(
        client.query(
          `SELECT public.replace_recurring_schedule_items($1, $2, $3::jsonb)`,
          [
            fx.scheduleId,
            fx.companyId,
            // quantity 0 violates the CHECK (quantity > 0) constraint — the
            // whole replace must roll back, leaving the old items intact.
            JSON.stringify([{ description: 'Trasig', quantity: 0, unit: 'st', unit_price: 100 }]),
          ],
        ),
      ).rejects.toThrow()
    })
    const after = await getPool().query(
      `SELECT count(*)::int AS n FROM public.recurring_invoice_schedule_items WHERE schedule_id = $1`,
      [fx.scheduleId],
    )
    expect(after.rows[0].n).toBe(before.rows[0].n)
  })

  it('rejects a viewer (read-only role) with 42501', async () => {
    await withUserContext(fx.viewerId, async (client) => {
      await expect(
        client.query(
          `SELECT public.replace_recurring_schedule_items($1, $2, $3::jsonb)`,
          [
            fx.scheduleId,
            fx.companyId,
            JSON.stringify([{ description: 'Viewer', quantity: 1, unit: 'st', unit_price: 1 }]),
          ],
        ),
      ).rejects.toMatchObject({ code: '42501' })
    })
  })

  it('rejects a schedule/company mismatch with P0002 (tenant guard)', async () => {
    await withUserContext(fx.outsiderId, async (client) => {
      await expect(
        client.query(
          `SELECT public.replace_recurring_schedule_items($1, $2, $3::jsonb)`,
          [
            fx.scheduleId,
            fx.otherCompanyId,
            JSON.stringify([{ description: 'X', quantity: 1, unit: 'st', unit_price: 1 }]),
          ],
        ),
      ).rejects.toMatchObject({ code: 'P0002' })
    })
  })
})
