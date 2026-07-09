/**
 * pg-real coverage for the billing/access chain:
 *
 *  - stripe_finalize_checkout_v2: a paid year-end checkout creates exactly
 *    one one_time_purchases row; replaying the webhook is a no-op; non-paid
 *    payment statuses create nothing.
 *  - one_time_purchases unique partial index: no second active year-end
 *    purchase for the same (company, fiscal_period).
 *  - stripe_sync_subscription_v2 (20260715140000): Stripe `incomplete` maps
 *    to `paused` — no feature access before the first payment succeeds;
 *    `active` opens access; `past_due` keeps grace access.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { getPool, getClient } from './setup'
import { seedCompany } from './fixtures'

// Run a callback with service-role JWT claims so require_service_role()
// passes — mirrors how the webhook route calls these RPCs in production.
async function withServiceRole<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true)`)
    await client.query(`SELECT set_config('request.jwt.claim.role', 'service_role', true)`)
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function activePlanVersion(planCode: string): Promise<{ versionId: string; productId: string }> {
  const { rows } = await getPool().query(
    `SELECT pv.id AS version_id, pr.id AS product_id
     FROM platform_plan_versions pv
     JOIN platform_price_plans pp ON pp.id = pv.plan_id
     JOIN platform_products pr ON pr.id = pp.product_id
     WHERE pp.code = $1 AND pv.status = 'active'
     ORDER BY pv.version_number DESC LIMIT 1`,
    [planCode],
  )
  expect(rows).toHaveLength(1)
  return { versionId: rows[0].version_id, productId: rows[0].product_id }
}

async function featureAccess(companyId: string, feature: string): Promise<boolean> {
  return withServiceRole(async (client) => {
    const { rows } = await client.query(
      `SELECT allowed FROM public.company_feature_access($1, $2)`,
      [companyId, feature],
    )
    return rows[0]?.allowed === true
  })
}

describe('stripe_finalize_checkout_v2 — year-end one-time purchase', () => {
  let companyId: string
  let fiscalPeriodId: string
  let versionId: string

  beforeAll(async () => {
    const seeded = await seedCompany()
    companyId = seeded.companyId
    fiscalPeriodId = seeded.fiscalPeriodId
    const catalog = await activePlanVersion('year_end_one_time')
    versionId = catalog.versionId
  })

  it('creates exactly one purchase for a paid checkout, replay is a no-op', async () => {
    const stripeSessionId = `cs_test_${randomUUID()}`
    await getPool().query(
      `INSERT INTO public.billing_checkout_sessions
         (company_id, plan_version_id, checkout_kind, fiscal_period_id, stripe_checkout_session_id, status, amount_excl_vat)
       VALUES ($1, $2, 'one_time', $3, $4, 'open', 990)`,
      [companyId, versionId, fiscalPeriodId, stripeSessionId],
    )

    const finalize = () => withServiceRole((client) =>
      client.query(`SELECT public.stripe_finalize_checkout_v2($1, $2, $3, null, 'paid', 99000, 24750, 123750, 'sek', null)`, [
        `evt_${randomUUID()}`,
        stripeSessionId,
        `cus_test_${randomUUID()}`,
      ]),
    )

    await finalize()
    await finalize() // webhook replay

    const { rows: purchases } = await getPool().query(
      `SELECT status, fiscal_period_id FROM public.one_time_purchases
       WHERE company_id = $1 AND purchase_type = 'year_end' AND fiscal_period_id = $2`,
      [companyId, fiscalPeriodId],
    )
    expect(purchases).toHaveLength(1)
    expect(purchases[0].status).toBe('paid')

    const { rows: sessions } = await getPool().query(
      `SELECT status FROM public.billing_checkout_sessions WHERE stripe_checkout_session_id = $1`,
      [stripeSessionId],
    )
    expect(sessions[0].status).toBe('completed')
  })

  it('does not create a purchase for an unpaid checkout', async () => {
    const seeded = await seedCompany()
    const stripeSessionId = `cs_test_${randomUUID()}`
    await getPool().query(
      `INSERT INTO public.billing_checkout_sessions
         (company_id, plan_version_id, checkout_kind, fiscal_period_id, stripe_checkout_session_id, status, amount_excl_vat)
       VALUES ($1, $2, 'one_time', $3, $4, 'open', 990)`,
      [seeded.companyId, versionId, seeded.fiscalPeriodId, stripeSessionId],
    )

    await withServiceRole((client) =>
      client.query(`SELECT public.stripe_finalize_checkout_v2($1, $2, $3, null, 'unpaid', null, null, null, 'sek', null)`, [
        `evt_${randomUUID()}`,
        stripeSessionId,
        `cus_test_${randomUUID()}`,
      ]),
    )

    const { rows } = await getPool().query(
      `SELECT id FROM public.one_time_purchases WHERE company_id = $1`,
      [seeded.companyId],
    )
    expect(rows).toHaveLength(0)
  })

  it('blocks a second active purchase for the same fiscal period (unique index)', async () => {
    const { productId } = await activePlanVersion('year_end_one_time')
    await expect(
      getPool().query(
        `INSERT INTO public.one_time_purchases (company_id, product_id, purchase_type, status, fiscal_period_id)
         VALUES ($1, $2, 'year_end', 'active', $3)`,
        [companyId, productId, fiscalPeriodId],
      ),
    ).rejects.toMatchObject({ code: '23505' })
  })
})

describe('stripe_sync_subscription_v2 — incomplete grants no access', () => {
  let companyId: string
  let stripeSubscriptionId: string
  const stripeCustomerId = `cus_test_${randomUUID()}`

  beforeAll(async () => {
    const seeded = await seedCompany()
    companyId = seeded.companyId
    stripeSubscriptionId = `sub_test_${randomUUID()}`

    // Buy company_start via a paid subscription checkout — finalize creates
    // the subscription + base item exactly like production.
    const { versionId } = await activePlanVersion('company_start')
    const stripeSessionId = `cs_test_${randomUUID()}`
    await getPool().query(
      `INSERT INTO public.billing_checkout_sessions
         (company_id, plan_version_id, checkout_kind, stripe_checkout_session_id, status, amount_excl_vat)
       VALUES ($1, $2, 'subscription', $3, 'open', 199)`,
      [companyId, versionId, stripeSessionId],
    )
    await withServiceRole((client) =>
      client.query(`SELECT public.stripe_finalize_checkout_v2($1, $2, $3, $4, 'paid', 19900, 4975, 24875, 'sek', null)`, [
        `evt_${randomUUID()}`,
        stripeSessionId,
        stripeCustomerId,
        stripeSubscriptionId,
      ]),
    )
  })

  const sync = (stripeStatus: string) => withServiceRole((client) =>
    client.query(`SELECT public.stripe_sync_subscription_v2($1, $2, $3, $4, null, null, null, false)`, [
      `evt_${randomUUID()}`,
      stripeSubscriptionId,
      stripeCustomerId,
      stripeStatus,
    ]),
  )

  it('grants access while the subscription is active', async () => {
    expect(await featureAccess(companyId, 'bookkeeping.core')).toBe(true)
    // Base-plan catalog repair (20260715120000): invoicing must be included.
    expect(await featureAccess(companyId, 'invoicing.core')).toBe(true)
  })

  it('incomplete (first payment not made) removes access instead of granting grace', async () => {
    await sync('incomplete')
    const { rows } = await getPool().query(
      `SELECT status, grace_ends_at FROM public.company_subscriptions WHERE company_id = $1 AND external_subscription_id = $2`,
      [companyId, stripeSubscriptionId],
    )
    expect(rows[0].status).toBe('paused')
    expect(rows[0].grace_ends_at).toBeNull()
    expect(await featureAccess(companyId, 'bookkeeping.core')).toBe(false)
  })

  it('past_due keeps access during the grace window', async () => {
    await sync('past_due')
    const { rows } = await getPool().query(
      `SELECT status, grace_ends_at FROM public.company_subscriptions WHERE company_id = $1 AND external_subscription_id = $2`,
      [companyId, stripeSubscriptionId],
    )
    expect(rows[0].status).toBe('past_due')
    expect(rows[0].grace_ends_at).not.toBeNull()
    expect(await featureAccess(companyId, 'bookkeeping.core')).toBe(true)
  })

  it('cancelled removes access', async () => {
    await sync('canceled')
    expect(await featureAccess(companyId, 'bookkeeping.core')).toBe(false)
    // Recovery: back to active restores access.
    await sync('active')
    expect(await featureAccess(companyId, 'bookkeeping.core')).toBe(true)
  })
})
