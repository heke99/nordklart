/**
 * Batch 8 pg-real coverage — commercial access correctness:
 *
 *  - Complimentary Full Access grants everything EXCEPT Bankgiro; a separate
 *    Bankgiro grant exists but stays blocked until provider provisioning.
 *  - Grant expiry removes access (reason: expired).
 *  - Add-on purchases grant only the add-on's features.
 *  - Published plan versions and their feature sets are immutable outside
 *    the migration bypass.
 *  - stripe_webhook_events is unique per Stripe event id.
 */
import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll } from 'vitest'
import type { PoolClient } from 'pg'
import { getPool, getClient } from './setup'
import { insertAuthUser, insertCompany, insertCompanyMember, seedCompany } from './fixtures'

async function withRole<T>(
  claims: Record<string, string>,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)])
    if (claims.sub) await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [claims.sub])
    if (claims.role) await client.query(`SELECT set_config('request.jwt.claim.role', $1, true)`, [claims.role])
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

async function featureAccess(companyId: string, feature: string): Promise<{ allowed: boolean; reason: string | null }> {
  return withRole({ role: 'service_role' }, async (client) => {
    const { rows } = await client.query(
      `SELECT allowed, reason FROM public.company_feature_access($1, $2)`,
      [companyId, feature],
    )
    return rows[0]
  })
}

async function makePlatformAdmin(): Promise<string> {
  const adminId = await insertAuthUser()
  await getPool().query(
    `INSERT INTO public.platform_roles (user_id, role) VALUES ($1, 'platform_admin')`,
    [adminId],
  )
  return adminId
}

describe('complimentary access grants', () => {
  let adminId: string
  let companyId: string

  beforeAll(async () => {
    adminId = await makePlatformAdmin()
    const owner = await insertAuthUser()
    companyId = await insertCompany({ createdBy: owner })
    await insertCompanyMember({ companyId, userId: owner, role: 'owner' })
  })

  it('Full Access grants core features but NEVER Bankgiro', async () => {
    await withRole({ sub: adminId, role: 'authenticated' }, (client) =>
      client.query(`SELECT public.platform_grant_complimentary_full_access($1)`, [companyId]),
    )

    expect((await featureAccess(companyId, 'bookkeeping.core')).allowed).toBe(true)
    expect((await featureAccess(companyId, 'invoicing.core')).allowed).toBe(true)
    expect((await featureAccess(companyId, 'skatteverket.submissions')).allowed).toBe(true)

    const bankgiro = await featureAccess(companyId, 'bankgiro.operations')
    expect(bankgiro.allowed).toBe(false)
    expect(bankgiro.reason).toBe('missing_entitlement')
  })

  it('a Bankgiro grant stays blocked until provider provisioning is complete', async () => {
    await withRole({ sub: adminId, role: 'authenticated' }, (client) =>
      client.query(`SELECT public.platform_grant_complimentary_bankgiro($1)`, [companyId]),
    )
    const bankgiro = await featureAccess(companyId, 'bankgiro.operations')
    // The entitlement exists, but bankgiro.operations additionally requires an
    // active provider setup — no silent go-live on a paper grant.
    expect(bankgiro.allowed).toBe(false)
    expect(bankgiro.reason).toBe('provisioning_pending')
  })

  it('an expired grant yields reason=expired, not access', async () => {
    const owner = await insertAuthUser()
    const expiredCompany = await insertCompany({ createdBy: owner })
    await insertCompanyMember({ companyId: expiredCompany, userId: owner, role: 'owner' })

    await withRole({ sub: adminId, role: 'authenticated' }, (client) =>
      client.query(
        `SELECT public.platform_grant_complimentary_full_access($1, now() - interval '30 days', now() - interval '1 day')`,
        [expiredCompany],
      ),
    )

    const access = await featureAccess(expiredCompany, 'bookkeeping.core')
    expect(access.allowed).toBe(false)
    expect(access.reason).toBe('expired')
  })

  it('repairs a stale Full Access feature snapshot', async () => {
    const owner = await insertAuthUser()
    const staleCompany = await insertCompany({ createdBy: owner })
    await insertCompanyMember({ companyId: staleCompany, userId: owner, role: 'owner' })

    const { rows } = await withRole({ sub: adminId, role: 'authenticated' }, (client) =>
      client.query<{ grant_id: string }>(
        `SELECT public.platform_grant_complimentary_full_access($1) AS grant_id`,
        [staleCompany],
      ),
    )
    const grantId = rows[0].grant_id

    await getPool().query(
      `DELETE FROM public.commercial_access_grant_features
       WHERE grant_id = $1
         AND feature_id = (SELECT id FROM public.platform_features WHERE code = 'salary.runs')`,
      [grantId],
    )

    expect((await featureAccess(staleCompany, 'salary.runs')).allowed).toBe(false)

    const repair = await withRole({ sub: adminId, role: 'authenticated' }, async (client) => {
      const result = await client.query<{
        grants_scanned: number
        missing_rows_before: number
        disabled_rows_before: number
        rows_repaired: number
      }>(`SELECT * FROM public.platform_repair_complimentary_access_grants($1)`, [staleCompany])
      return result.rows[0]
    })

    expect(repair.grants_scanned).toBe(1)
    expect(repair.missing_rows_before).toBeGreaterThanOrEqual(1)
    expect(repair.disabled_rows_before).toBe(0)
    expect(repair.rows_repaired).toBeGreaterThanOrEqual(1)
    expect((await featureAccess(staleCompany, 'salary.runs')).allowed).toBe(true)
  })

  it('propagates future catalog features to existing Full Access grants', async () => {
    const owner = await insertAuthUser()
    const futureCompany = await insertCompany({ createdBy: owner })
    await insertCompanyMember({ companyId: futureCompany, userId: owner, role: 'owner' })
    await withRole({ sub: adminId, role: 'authenticated' }, (client) =>
      client.query(`SELECT public.platform_grant_complimentary_full_access($1)`, [futureCompany]),
    )

    const featureCode = `test.full_access.${randomUUID().replaceAll('-', '')}`
    let featureId: string | null = null
    try {
      const { rows } = await getPool().query<{ id: string }>(
        `INSERT INTO public.platform_features (code, name, category, description)
         VALUES ($1, 'Full access propagation test', 'test', 'Temporary pg-real feature')
         RETURNING id`,
        [featureCode],
      )
      featureId = rows[0].id

      const access = await featureAccess(futureCompany, featureCode)
      expect(access.allowed).toBe(true)

      const { rows: coverageRows } = await withRole({ sub: adminId, role: 'authenticated' }, (client) =>
        client.query<{ missing_feature_count: number }>(
          `SELECT missing_feature_count
           FROM public.commercial_access_grant_coverage_v
           WHERE company_id = $1 AND grant_type = 'complimentary_full_access'
           ORDER BY starts_at DESC
           LIMIT 1`,
          [futureCompany],
        ),
      )
      expect(coverageRows[0]?.missing_feature_count).toBe(0)
    } finally {
      if (featureId) {
        await getPool().query(`DELETE FROM public.commercial_access_grant_features WHERE feature_id = $1`, [featureId])
        await getPool().query(`DELETE FROM public.platform_features WHERE id = $1`, [featureId])
      }
    }
  })
})

describe('add-on purchases grant only their features', () => {
  let companyId: string

  beforeAll(async () => {
    const seeded = await seedCompany()
    companyId = seeded.companyId

    const { rows: baseRows } = await getPool().query(
      `SELECT pv.id FROM platform_plan_versions pv
       JOIN platform_price_plans pp ON pp.id = pv.plan_id
       WHERE pp.code = 'company_start' AND pv.status = 'active'
       ORDER BY pv.version_number DESC LIMIT 1`,
    )
    const baseVersionId = baseRows[0].id
    const baseSession = `cs_test_${randomUUID()}`
    await getPool().query(
      `INSERT INTO public.billing_checkout_sessions
         (company_id, plan_version_id, checkout_kind, stripe_checkout_session_id, status, amount_excl_vat)
       VALUES ($1, $2, 'subscription', $3, 'open', 199)`,
      [companyId, baseVersionId, baseSession],
    )
    await withRole({ role: 'service_role' }, (client) =>
      client.query(`SELECT public.stripe_finalize_checkout_v2($1, $2, $3, $4, 'paid', 19900, null, null, 'sek', null)`, [
        `evt_${randomUUID()}`, baseSession, `cus_${randomUUID()}`, `sub_${randomUUID()}`,
      ]),
    )

    const { rows: subscriptionRows } = await getPool().query(
      `SELECT id FROM public.company_subscriptions WHERE company_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [companyId],
    )
    const parentSubscriptionId = subscriptionRows[0].id

    const { rows: addonRows } = await getPool().query(
      `SELECT pv.id FROM platform_plan_versions pv
       JOIN platform_price_plans pp ON pp.id = pv.plan_id
       WHERE pp.code = 'addon_api_webhooks' AND pv.status = 'active'
       ORDER BY pv.version_number DESC LIMIT 1`,
    )
    const addonVersionId = addonRows[0].id
    const addonSession = `cs_test_${randomUUID()}`
    await getPool().query(
      `INSERT INTO public.billing_checkout_sessions
         (company_id, plan_version_id, checkout_kind, parent_subscription_id, stripe_checkout_session_id, status, amount_excl_vat)
       VALUES ($1, $2, 'addon', $3, $4, 'open', 299)`,
      [companyId, addonVersionId, parentSubscriptionId, addonSession],
    )
    await withRole({ role: 'service_role' }, (client) =>
      client.query(`SELECT public.stripe_finalize_checkout_v2($1, $2, $3, $4, 'paid', 29900, null, null, 'sek', null)`, [
        `evt_${randomUUID()}`, addonSession, `cus_${randomUUID()}`, `sub_${randomUUID()}`,
      ]),
    )
  })

  it('grants the add-on features', async () => {
    expect((await featureAccess(companyId, 'api.webhooks')).allowed).toBe(true)
    expect((await featureAccess(companyId, 'api.access')).allowed).toBe(true)
  })

  it('does not grant unrelated paid features', async () => {
    // salary.runs is Plus/Pro-only and not part of the API add-on.
    expect((await featureAccess(companyId, 'salary.runs')).allowed).toBe(false)
    expect((await featureAccess(companyId, 'ai.assistant')).allowed).toBe(false)
  })
})

describe('published plan versions are immutable', () => {
  it('blocks price changes on an active plan version', async () => {
    const { rows } = await getPool().query(
      `SELECT pv.id FROM platform_plan_versions pv WHERE pv.status = 'active' LIMIT 1`,
    )
    await expect(
      getPool().query(`UPDATE public.platform_plan_versions SET price_excl_vat = price_excl_vat + 100 WHERE id = $1`, [rows[0].id]),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('blocks feature-set changes on an active plan version', async () => {
    const { rows } = await getPool().query(
      `SELECT pvf.plan_version_id, pvf.feature_id
       FROM platform_plan_version_features pvf
       JOIN platform_plan_versions pv ON pv.id = pvf.plan_version_id
       WHERE pv.status = 'active' LIMIT 1`,
    )
    await expect(
      getPool().query(
        `UPDATE public.platform_plan_version_features SET enabled = false
         WHERE plan_version_id = $1 AND feature_id = $2`,
        [rows[0].plan_version_id, rows[0].feature_id],
      ),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      getPool().query(
        `DELETE FROM public.platform_plan_version_features
         WHERE plan_version_id = $1 AND feature_id = $2`,
        [rows[0].plan_version_id, rows[0].feature_id],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })
})

describe('stripe_webhook_events uniqueness', () => {
  it('rejects a duplicate Stripe event id (23505)', async () => {
    const eventId = `evt_${randomUUID()}`
    await getPool().query(
      `INSERT INTO public.stripe_webhook_events (stripe_event_id, event_type, payload) VALUES ($1, 'checkout.session.completed', '{}'::jsonb)`,
      [eventId],
    )
    await expect(
      getPool().query(
        `INSERT INTO public.stripe_webhook_events (stripe_event_id, event_type, payload) VALUES ($1, 'checkout.session.completed', '{}'::jsonb)`,
        [eventId],
      ),
    ).rejects.toMatchObject({ code: '23505' })
  })
})
