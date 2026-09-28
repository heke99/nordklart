import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, withServiceRole } from './setup'
import { seedCompany } from './fixtures'

/** Covers 20260927110000_billing_event_ordering. */

async function activeVersion(planCode: string): Promise<string> {
  const { rows } = await getPool().query(
    `SELECT pv.id FROM platform_plan_versions pv
       JOIN platform_price_plans pp ON pp.id = pv.plan_id
      WHERE pp.code = $1 AND pv.status = 'active'
      ORDER BY pv.version_number DESC LIMIT 1`,
    [planCode],
  )
  return rows[0].id
}

async function subscribedCompany() {
  const { companyId } = await seedCompany()
  const subscriptionId = `sub_test_${randomUUID()}`
  const customerId = `cus_test_${randomUUID()}`
  const sessionId = `cs_test_${randomUUID()}`
  await getPool().query(
    `INSERT INTO public.billing_checkout_sessions
       (company_id, plan_version_id, checkout_kind, stripe_checkout_session_id, status, amount_excl_vat)
     VALUES ($1, $2, 'subscription', $3, 'open', 199)`,
    [companyId, await activeVersion('company_start'), sessionId],
  )
  await withServiceRole((c) =>
    c.query(`SELECT public.stripe_finalize_checkout_v2($1, $2, $3, $4, 'paid', 19900, 4975, 24875, 'sek', null)`, [
      `evt_${randomUUID()}`, sessionId, customerId, subscriptionId,
    ]),
  )
  return { companyId, subscriptionId, customerId }
}

const sync = (subscriptionId: string, customerId: string, status: string, createdAt: string | null) =>
  withServiceRole(async (c) => {
    const { rows } = await c.query(
      `SELECT public.stripe_sync_subscription_v3($1, $2, $3, $4, $5, null, null, null, false) AS r`,
      [`evt_${randomUUID()}`, createdAt, subscriptionId, customerId, status],
    )
    return rows[0].r as { applied: boolean; reason?: string }
  })

const statusOf = async (subscriptionId: string) => {
  const { rows } = await getPool().query(
    `SELECT status FROM public.company_subscriptions WHERE external_subscription_id = $1`,
    [subscriptionId],
  )
  return rows[0]?.status
}

describe('stripe_sync_subscription_v3', () => {
  it('applies newer events and ignores an older one that arrives late', async () => {
    const s = await subscribedCompany()
    expect(await sync(s.subscriptionId, s.customerId, 'past_due', '2026-09-01T10:00:00Z')).toEqual({ applied: true })
    expect(await statusOf(s.subscriptionId)).toBe('past_due')

    expect(await sync(s.subscriptionId, s.customerId, 'active', '2026-09-01T10:05:00Z')).toEqual({ applied: true })
    expect(await statusOf(s.subscriptionId)).toBe('active')

    // The past_due event from 10:02 arrives after the 10:05 recovery.
    expect(await sync(s.subscriptionId, s.customerId, 'past_due', '2026-09-01T10:02:00Z'))
      .toEqual({ applied: false, reason: 'stale_event' })
    expect(await statusOf(s.subscriptionId)).toBe('active')
  })

  it('reports a subscription it does not know instead of silently succeeding', async () => {
    expect(await sync(`sub_unknown_${randomUUID()}`, 'cus_x', 'active', '2026-09-01T10:00:00Z'))
      .toEqual({ applied: false, reason: 'subscription_not_found' })
  })

  it('is service-role only', async () => {
    const { rows } = await getPool().query(
      `SELECT has_function_privilege('authenticated',
         'public.stripe_sync_subscription_v3(text,timestamptz,text,text,text,text,timestamptz,timestamptz,boolean)', 'EXECUTE') AS ok`,
    )
    expect(rows[0].ok).toBe(false)
  })
})

describe('one open base-plan checkout per company', () => {
  it('refuses a second open subscription checkout, allows add-ons and one-time purchases', async () => {
    const { companyId, fiscalPeriodId } = await seedCompany()
    const base = await activeVersion('company_start')
    await getPool().query(
      `INSERT INTO public.billing_checkout_sessions (company_id, plan_version_id, checkout_kind, status, amount_excl_vat)
       VALUES ($1, $2, 'subscription', 'open', 199)`,
      [companyId, base],
    )
    await expect(
      getPool().query(
        `INSERT INTO public.billing_checkout_sessions (company_id, plan_version_id, checkout_kind, status, amount_excl_vat)
         VALUES ($1, $2, 'subscription', 'created', 299)`,
        [companyId, base],
      ),
    ).rejects.toMatchObject({ code: '23505' })

    await expect(
      getPool().query(
        `INSERT INTO public.billing_checkout_sessions (company_id, plan_version_id, checkout_kind, fiscal_period_id, status, amount_excl_vat)
         VALUES ($1, $2, 'one_time', $3, 'open', 990)`,
        [companyId, await activeVersion('year_end_one_time'), fiscalPeriodId],
      ),
    ).resolves.toBeDefined()
  })
})

describe('stripe_invoice_records status', () => {
  it('a paid invoice does not go back to open', async () => {
    const { companyId } = await seedCompany()
    const invoiceId = `in_test_${randomUUID()}`
    await getPool().query(
      `INSERT INTO public.stripe_invoice_records (company_id, stripe_invoice_id, status, currency) VALUES ($1, $2, 'paid', 'SEK')`,
      [companyId, invoiceId],
    )
    await getPool().query(`UPDATE public.stripe_invoice_records SET status = 'open' WHERE stripe_invoice_id = $1`, [invoiceId])
    const { rows } = await getPool().query(`SELECT status FROM public.stripe_invoice_records WHERE stripe_invoice_id = $1`, [invoiceId])
    expect(rows[0].status).toBe('paid')
  })
})
