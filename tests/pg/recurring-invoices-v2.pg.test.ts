/** Covers 20261001130000_recurring_invoices_v2. */
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompany, insertCompanyMember } from './fixtures'

async function seed() {
  const ownerId = await insertAuthUser()
  const outsiderId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: ownerId })
  await insertCompanyMember({ companyId, userId: ownerId, role: 'owner' })
  const otherCompanyId = await insertCompany({ createdBy: outsiderId })
  await insertCompanyMember({ companyId: otherCompanyId, userId: outsiderId, role: 'owner' })

  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name) VALUES ($1, $2, $3, 'Hyresgäst AB')`,
    [customerId, ownerId, companyId],
  )
  const scheduleId = randomUUID()
  await getPool().query(
    `INSERT INTO public.recurring_invoice_schedules
       (id, company_id, user_id, customer_id, name, day_of_month, next_run_date, interval_months, billing_timing)
     VALUES ($1, $2, $3, $4, 'Hyra', 25, '2026-10-25', 1, 'next_period')`,
    [scheduleId, companyId, ownerId, customerId],
  )
  const articleId = randomUUID()
  await getPool().query(
    `INSERT INTO public.articles (id, company_id, user_id, article_number, name, price_excl_vat)
     VALUES ($1, $2, $3, 'HYRA-1', 'Lokalhyra', 10000)`,
    [articleId, companyId, ownerId],
  )
  const foreignArticleId = randomUUID()
  await getPool().query(
    `INSERT INTO public.articles (id, company_id, user_id, name) VALUES ($1, $2, $3, 'Annans artikel')`,
    [foreignArticleId, otherCompanyId, outsiderId],
  )
  return { ownerId, companyId, customerId, scheduleId, articleId, foreignArticleId }
}

const replaceAsOwner = (fx: Awaited<ReturnType<typeof seed>>, items: unknown[]) =>
  withUserContext(fx.ownerId, (client) =>
    client.query(`SELECT public.replace_recurring_schedule_items($1, $2, $3::jsonb)`, [
      fx.scheduleId,
      fx.companyId,
      JSON.stringify(items),
    ]),
  )

describe('recurring invoices v2', () => {
  let fx: Awaited<ReturnType<typeof seed>>
  beforeAll(async () => {
    fx = await seed()
  })

  it('stores article, revenue account, period limit and occurrence limit on a line', async () => {
    // withUserContext rolls back, so read inside the same transaction.
    const rows = await withUserContext(fx.ownerId, async (client) => {
      await client.query(`SELECT public.replace_recurring_schedule_items($1, $2, $3::jsonb)`, [
        fx.scheduleId,
        fx.companyId,
        JSON.stringify([
          { description: 'Hyra {period}', quantity: 1, unit: 'mån', unit_price: 10000, article_id: fx.articleId, revenue_account: '3911' },
          { description: 'Städning', quantity: 1, unit: 'st', unit_price: 500, valid_from: '2026-11-01', valid_until: '2026-11-30' },
          { description: 'Uppstartsavgift', quantity: 1, unit: 'st', unit_price: 1500, remaining_occurrences: 1 },
        ]),
      ])
      const result = await client.query(
        `SELECT description, article_id, revenue_account, valid_from::text, valid_until::text, remaining_occurrences
           FROM public.recurring_invoice_schedule_items WHERE schedule_id = $1 ORDER BY sort_order`,
        [fx.scheduleId],
      )
      return result.rows
    })
    expect(rows).toEqual([
      { description: 'Hyra {period}', article_id: fx.articleId, revenue_account: '3911', valid_from: null, valid_until: null, remaining_occurrences: null },
      { description: 'Städning', article_id: null, revenue_account: null, valid_from: '2026-11-01', valid_until: '2026-11-30', remaining_occurrences: null },
      { description: 'Uppstartsavgift', article_id: null, revenue_account: null, valid_from: null, valid_until: null, remaining_occurrences: 1 },
    ])
  })

  it('refuses an article from another company and keeps the existing lines', async () => {
    await getPool().query(
      `INSERT INTO public.recurring_invoice_schedule_items (schedule_id, sort_order, description, quantity, unit, unit_price)
       VALUES ($1, 0, 'Hyra', 1, 'mån', 10000)`,
      [fx.scheduleId],
    )
    await expect(
      replaceAsOwner(fx, [{ description: 'X', quantity: 1, unit: 'st', unit_price: 1, article_id: fx.foreignArticleId }]),
    ).rejects.toMatchObject({ code: 'P0002' })
    const { rows } = await getPool().query(
      `SELECT description FROM public.recurring_invoice_schedule_items WHERE schedule_id = $1`,
      [fx.scheduleId],
    )
    expect(rows).toEqual([{ description: 'Hyra' }])
  })

  it('rejects an inverted period range and a non-revenue account', async () => {
    await expect(
      replaceAsOwner(fx, [{ description: 'X', quantity: 1, unit: 'st', unit_price: 1, valid_from: '2026-12-01', valid_until: '2026-11-01' }]),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      replaceAsOwner(fx, [{ description: 'X', quantity: 1, unit: 'st', unit_price: 1, revenue_account: '1930' }]),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('accepts only supported cadences, timings and statuses', async () => {
    await expect(
      getPool().query(`UPDATE public.recurring_invoice_schedules SET interval_months = 5 WHERE id = $1`, [fx.scheduleId]),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      getPool().query(`UPDATE public.recurring_invoice_schedules SET billing_timing = 'sometimes' WHERE id = $1`, [fx.scheduleId]),
    ).rejects.toMatchObject({ code: '23514' })
    await getPool().query(
      `UPDATE public.recurring_invoice_schedules SET interval_months = 3, status = 'ended', ended_at = now() WHERE id = $1`,
      [fx.scheduleId],
    )
    const { rows } = await getPool().query(`SELECT status, interval_months FROM public.recurring_invoice_schedules WHERE id = $1`, [fx.scheduleId])
    expect(rows[0]).toEqual({ status: 'ended', interval_months: 3 })
  })

  it('keeps defaults for schedules created before this migration', async () => {
    const { rows } = await getPool().query(
      `SELECT column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'recurring_invoice_schedules' AND column_name IN ('interval_months', 'billing_timing')
        ORDER BY column_name`,
    )
    expect(rows.map((r) => r.column_default)).toEqual(["'current_period'::text", '1'])
  })

  it('stores a billing period on an invoice and refuses an inverted one', async () => {
    const invoiceId = randomUUID()
    await getPool().query(
      `INSERT INTO public.invoices (id, company_id, user_id, customer_id, invoice_date, due_date, subtotal, vat_amount, total, period_start, period_end)
       VALUES ($1, $2, $3, $4, '2026-10-25', '2026-11-24', 100, 25, 125, '2026-11-01', '2026-11-30')`,
      [invoiceId, fx.companyId, fx.ownerId, fx.customerId],
    )
    await expect(
      getPool().query(`UPDATE public.invoices SET period_end = '2026-10-01' WHERE id = $1`, [invoiceId]),
    ).rejects.toMatchObject({ code: '23514' })
  })
})
