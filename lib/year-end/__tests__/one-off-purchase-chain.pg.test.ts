/**
 * The one-off year-end purchase, end to end.
 *
 * A customer who never subscribes can buy a single year-end. That purchase is
 * the *only* thing standing between them and a statutory close, so the exact
 * shape of what it grants matters: it is bound to one fiscal period, it can
 * expire, it can be revoked, and — the part that is easy to get wrong — it is
 * a commercial entitlement, not an authorization. It decides *whether the
 * feature is available*, never *who may write*.
 *
 * Everything below goes through the canonical resolver
 * `resolve_year_end_period_capability_for_user`, because that is what the API
 * layer calls. Testing anything else would prove nothing about production.
 *
 * Finding #20 on this branch was exactly this confusion in the SIE import path
 * (`access.can_write || roleCanOperateOneOff`), which promoted an
 * `active_limited` member to write. The "who may write" cases here pin the
 * database side of the same boundary.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { getPool, getClient } from '@/tests/pg/setup'
import {
  seedCompany,
  insertAuthUser,
  insertCompanyMember,
  insertFiscalPeriod,
} from '@/tests/pg/fixtures'

type Capability = {
  allowed: boolean
  code: string
  access_source: string | null
  access_source_id: string | null
  effective_role: string | null
  purchase_id: string | null
  feature_access: boolean
  one_time_access: boolean
}

/** The resolver is service-role-only; production reaches it the same way. */
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

async function capability(
  userId: string,
  companyId: string,
  fiscalPeriodId: string,
  requireWrite = false,
): Promise<Capability> {
  return withServiceRole(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM public.resolve_year_end_period_capability_for_user($1, $2, $3, $4)`,
      [userId, companyId, fiscalPeriodId, requireWrite],
    )
    expect(rows).toHaveLength(1)
    return rows[0] as Capability
  })
}

type PurchaseOverrides = {
  status?: string
  paidAt?: Date | null
  accessStartsAt?: Date | null
  accessExpiresAt?: Date | null
  accessRevokedAt?: Date | null
  permanentAccess?: boolean
  purchaseType?: string
}

/** The catalogue product a real year-end checkout points at. */
async function yearEndProductId(): Promise<string> {
  const { rows } = await getPool().query(
    `SELECT id FROM public.platform_products WHERE code = 'year_end' LIMIT 1`,
  )
  expect(rows).toHaveLength(1)
  return rows[0].id as string
}

async function insertPurchase(
  companyId: string,
  fiscalPeriodId: string | null,
  overrides: PurchaseOverrides = {},
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.one_time_purchases
       (id, company_id, product_id, fiscal_period_id, purchase_type, status, paid_at,
        access_starts_at, access_expires_at, access_revoked_at, permanent_access,
        price_excl_vat, currency)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 2495, 'SEK')`,
    [
      id,
      companyId,
      await yearEndProductId(),
      fiscalPeriodId,
      overrides.purchaseType ?? 'year_end',
      overrides.status ?? 'paid',
      overrides.paidAt === undefined ? new Date() : overrides.paidAt,
      overrides.accessStartsAt ?? null,
      overrides.accessExpiresAt ?? null,
      overrides.accessRevokedAt ?? null,
      overrides.permanentAccess ?? false,
    ],
  )
  return id
}

const DAY = 24 * 60 * 60 * 1000

describe('one-off year-end purchase — what it grants', () => {
  let userId: string
  let companyId: string
  let periodId: string

  beforeAll(async () => {
    const seeded = await seedCompany()
    userId = seeded.userId
    companyId = seeded.companyId
    periodId = seeded.fiscalPeriodId
  })

  it('refuses the close before anything is bought', async () => {
    const result = await capability(userId, companyId, periodId)

    expect(result.allowed).toBe(false)
    expect(result.code).toBe('YEAR_END_PERIOD_PURCHASE_REQUIRED')
    // No entitlement of either kind — this company has bought nothing.
    expect(result.feature_access).toBe(false)
    expect(result.one_time_access).toBe(false)
  })

  it('opens exactly the purchased period once the purchase is paid', async () => {
    const purchaseId = await insertPurchase(companyId, periodId)

    const result = await capability(userId, companyId, periodId, true)

    expect(result.allowed).toBe(true)
    expect(result.code).toBe('YEAR_END_PERIOD_OPERATE_ALLOWED')
    expect(result.access_source).toBe('one_time_purchase')
    expect(result.access_source_id).toBe(purchaseId)
    expect(result.purchase_id).toBe(purchaseId)
    // Sold as a one-off, not as a subscription: the feature gate is still shut.
    expect(result.feature_access).toBe(false)
    expect(result.one_time_access).toBe(true)
  })

  it('does not leak to another fiscal year of the same company', async () => {
    const nextYear = await insertFiscalPeriod({
      userId,
      companyId,
      name: '2027',
      periodStart: '2027-01-01',
      periodEnd: '2027-12-31',
    })

    const result = await capability(userId, companyId, nextYear)

    expect(result.allowed).toBe(false)
    expect(result.code).toBe('YEAR_END_PERIOD_PURCHASE_REQUIRED')
    expect(result.one_time_access).toBe(false)
  })

  it('does not leak to another company', async () => {
    const other = await seedCompany()

    // The buyer is not a member of the other company at all.
    const asStranger = await capability(userId, other.companyId, other.fiscalPeriodId)
    expect(asStranger.allowed).toBe(false)
    expect(asStranger.code).toBe('YEAR_END_COMPANY_ACCESS_FORBIDDEN')

    // And the other company's own owner still has to buy their own.
    const asOwner = await capability(other.userId, other.companyId, other.fiscalPeriodId)
    expect(asOwner.allowed).toBe(false)
    expect(asOwner.code).toBe('YEAR_END_PERIOD_PURCHASE_REQUIRED')
  })

  it('refuses a period that belongs to a different company', async () => {
    const other = await seedCompany()

    // Company mine, period theirs — the mismatch must be caught before any
    // entitlement lookup, or a purchase would unlock a foreign year.
    const result = await capability(userId, companyId, other.fiscalPeriodId)

    expect(result.allowed).toBe(false)
    expect(result.code).toBe('YEAR_END_PERIOD_FORBIDDEN')
  })
})

describe('one-off year-end purchase — when it does not count', () => {
  let userId: string
  let companyId: string
  let nextYear = 2030

  beforeAll(async () => {
    const seeded = await seedCompany()
    userId = seeded.userId
    companyId = seeded.companyId
  })

  /**
   * Each case gets its own fiscal year. That is not test hygiene for its own
   * sake: a partial unique index forbids two live year-end purchases for the
   * same (company, period), so reusing one period would collide rather than
   * test the resolver.
   */
  async function freshPeriod(): Promise<string> {
    const year = nextYear++
    return insertFiscalPeriod({
      userId,
      companyId,
      name: String(year),
      periodStart: `${year}-01-01`,
      periodEnd: `${year}-12-31`,
    })
  }

  async function expectDenied(overrides: PurchaseOverrides): Promise<void> {
    const periodId = await freshPeriod()
    await insertPurchase(companyId, periodId, overrides)

    const result = await capability(userId, companyId, periodId)

    expect(result.allowed).toBe(false)
    expect(result.code).toBe('YEAR_END_PERIOD_PURCHASE_REQUIRED')
    expect(result.one_time_access).toBe(false)
  }

  it('an unpaid checkout grants nothing', async () => {
    await expectDenied({ status: 'pending_payment', paidAt: null })
  })

  it('a paid row with no paid_at grants nothing', async () => {
    // Defensive: status and timestamp must agree. A row claiming 'paid' with
    // no payment timestamp is not evidence of a payment.
    await expectDenied({ status: 'paid', paidAt: null })
  })

  it('a refunded purchase grants nothing', async () => {
    await expectDenied({ status: 'refunded' })
  })

  it('access scheduled to start in the future grants nothing yet', async () => {
    await expectDenied({ accessStartsAt: new Date(Date.now() + 7 * DAY) })
  })

  it('an expired purchase grants nothing', async () => {
    await expectDenied({
      accessStartsAt: new Date(Date.now() - 400 * DAY),
      accessExpiresAt: new Date(Date.now() - DAY),
    })
  })

  it('a revoked purchase grants nothing even while unexpired', async () => {
    await expectDenied({
      accessExpiresAt: new Date(Date.now() + 90 * DAY),
      accessRevokedAt: new Date(),
    })
  })

  it('a purchase of a different product grants nothing', async () => {
    await expectDenied({ purchaseType: 'bankgiro_setup' })
  })

  it('permanent access outlives an expiry date in the past', async () => {
    // permanent_access is how a delivered bokslut stays readable through the
    // 7-year retention period; it must win over access_expires_at.
    const periodId = await freshPeriod()
    const purchaseId = await insertPurchase(companyId, periodId, {
      permanentAccess: true,
      accessExpiresAt: new Date(Date.now() - 30 * DAY),
    })

    const result = await capability(userId, companyId, periodId)

    expect(result.allowed).toBe(true)
    expect(result.access_source).toBe('one_time_purchase')
    expect(result.purchase_id).toBe(purchaseId)
  })

  it('refuses a second live year-end purchase for the same period', async () => {
    const periodId = await freshPeriod()
    await insertPurchase(companyId, periodId)

    // Double-charging a customer for one bokslut is a billing incident, so the
    // database refuses it rather than leaving it to application code.
    await expect(insertPurchase(companyId, periodId)).rejects.toThrow(
      /one_time_purchases_year_end_active_period_unique_idx/,
    )
  })
})

describe('one-off year-end purchase — entitlement is not authorization', () => {
  let ownerId: string
  let companyId: string
  let periodId: string

  beforeAll(async () => {
    const seeded = await seedCompany()
    ownerId = seeded.userId
    companyId = seeded.companyId
    periodId = seeded.fiscalPeriodId
    await insertPurchase(companyId, periodId)
  })

  it('lets a viewer read the purchased year', async () => {
    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewerId, role: 'viewer' })

    const result = await capability(viewerId, companyId, periodId, false)

    expect(result.allowed).toBe(true)
    expect(result.effective_role).toBe('read_only')
  })

  it('refuses the same viewer when write is required', async () => {
    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewerId, role: 'viewer' })

    const result = await capability(viewerId, companyId, periodId, true)

    // The company bought the year-end. That buys the feature, not the role.
    expect(result.allowed).toBe(false)
    expect(result.code).toBe('YEAR_END_COMPANY_WRITE_FORBIDDEN')
    expect(result.purchase_id).toBeNull()
  })

  it('refuses a limited-status owner when write is required', async () => {
    // `active_limited` reads (company_member_is_active accepts it) but does not
    // write (can_write requires status = 'active'). The role list alone would
    // promote this member — that was finding #20 in the SIE path.
    const limitedId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: limitedId, role: 'owner' })
    await getPool().query(
      `UPDATE public.company_members SET status = 'active_limited'
       WHERE company_id = $1 AND user_id = $2`,
      [companyId, limitedId],
    )

    const read = await capability(limitedId, companyId, periodId, false)
    expect(read.allowed).toBe(true)
    expect(read.effective_role).toBe('company_owner')

    const write = await capability(limitedId, companyId, periodId, true)
    expect(write.allowed).toBe(false)
    expect(write.code).toBe('YEAR_END_COMPANY_WRITE_FORBIDDEN')
  })

  it('still lets the owner write', async () => {
    const result = await capability(ownerId, companyId, periodId, true)

    expect(result.allowed).toBe(true)
    expect(result.access_source).toBe('one_time_purchase')
  })

  it('refuses a user with no membership regardless of the purchase', async () => {
    const strangerId = await insertAuthUser()

    const result = await capability(strangerId, companyId, periodId, false)

    expect(result.allowed).toBe(false)
    expect(result.code).toBe('YEAR_END_COMPANY_ACCESS_FORBIDDEN')
  })
})

describe('one-off year-end purchase — the resolver is not reachable by tenants', () => {
  it('refuses to run without service-role claims', async () => {
    const seeded = await seedCompany()

    await expect(
      getPool().query(
        `SELECT * FROM public.resolve_year_end_period_capability_for_user($1, $2, $3, false)`,
        [seeded.userId, seeded.companyId, seeded.fiscalPeriodId],
      ),
    ).rejects.toThrow()
  })
})
