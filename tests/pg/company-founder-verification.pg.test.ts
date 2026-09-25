import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany } from '@/tests/pg/fixtures'
import { getPool, withServiceRole, withUserContext } from '@/tests/pg/setup'

/** Covers 20260925112000_company_founder_verification. */

function uniqueOrg(): string {
  return String(Math.floor(1e9 + Math.random() * 8.9e9)).padStart(10, '5')
}

async function createForFounder(userId: string, status: string, orgNumber: string | null = uniqueOrg(), settings: Record<string, unknown> = {}) {
  return withServiceRole(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT public.create_company_for_founder($1, 'Grundare AB', 'aktiebolag', NULL, $2, $3::jsonb,
         '2026-01-01', '2026-12-31', '2026', $4, 'test', '{}'::jsonb) AS id`,
      [userId, orgNumber, JSON.stringify(settings), status],
    )
    return rows[0].id
  })
}

async function owner(companyId: string, userId: string) {
  const { rows } = await getPool().query(
    `SELECT status, verification_status, role FROM public.company_members WHERE company_id = $1 AND user_id = $2`,
    [companyId, userId],
  )
  return rows[0]
}

describe('create_company_for_founder', () => {
  it('a verified founder becomes an active owner, with everything created in one go', async () => {
    const user = await insertAuthUser()
    const companyId = await createForFounder(user, 'verified', uniqueOrg(), { company_name: 'Grundare AB', vat_registered: true })
    expect(await owner(companyId, user)).toMatchObject({ role: 'owner', status: 'active', verification_status: 'verified' })

    const counts = await getPool().query(
      `SELECT
         (SELECT count(*) FROM public.chart_of_accounts WHERE company_id = $1)::int AS accounts,
         (SELECT count(*) FROM public.fiscal_periods WHERE company_id = $1)::int AS periods,
         (SELECT count(*) FROM public.cash_accounts WHERE company_id = $1)::int AS cash,
         (SELECT onboarding_complete FROM public.company_settings WHERE company_id = $1) AS onboarded,
         (SELECT vat_registered FROM public.company_settings WHERE company_id = $1) AS vat,
         (SELECT active_company_id FROM public.user_preferences WHERE user_id = $2) AS active`,
      [companyId, user],
    )
    expect(counts.rows[0].accounts).toBeGreaterThan(30)
    expect(counts.rows[0]).toMatchObject({ periods: 1, cash: 1, onboarded: true, vat: true, active: companyId })
  })

  it('an unmatched founder is read-only (active_limited) pending manual review', async () => {
    const user = await insertAuthUser()
    const companyId = await createForFounder(user, 'manual_review')
    expect(await owner(companyId, user)).toMatchObject({ status: 'active_limited', verification_status: 'manual_review' })
    const { rows } = await getPool().query(`SELECT can_write, can_manage_company FROM public.resolve_company_access_for_user($1, $2)`, [user, companyId])
    expect(rows[0]).toMatchObject({ can_write: false, can_manage_company: false })
  })

  it('rolls back entirely when a step fails (no orphan company)', async () => {
    const user = await insertAuthUser()
    const org = uniqueOrg()
    await expect(
      withServiceRole((client) => client.query(
        `SELECT public.create_company_for_founder($1, 'X AB', 'aktiebolag', NULL, $2, '{}'::jsonb,
           '2026-01-01', '2025-12-31', '2026', 'verified', 't', '{}'::jsonb)`,
        [user, org],
      )),
    ).rejects.toMatchObject({ code: '22023' })
    const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM public.companies WHERE org_number = $1`, [org])
    expect(rows[0].n).toBe(0)
  })

  it('refuses a registered org.nr', async () => {
    const user = await insertAuthUser()
    const org = uniqueOrg()
    await insertCompany({ createdBy: user, orgNumber: org })
    await expect(createForFounder(user, 'verified', org)).rejects.toMatchObject({ code: '23505' })
  })

  it('ignores managed settings keys supplied by the client', async () => {
    const user = await insertAuthUser()
    const companyId = await createForFounder(user, 'verified', uniqueOrg(), { company_id: randomUUID(), onboarding_complete: false, not_a_column: 1 })
    const { rows } = await getPool().query(`SELECT onboarding_complete FROM public.company_settings WHERE company_id = $1`, [companyId])
    expect(rows[0].onboarding_complete).toBe(true)
  })

  it('is not callable by authenticated users', async () => {
    const user = await insertAuthUser()
    await expect(withUserContext(user, (c) => c.query(
      `SELECT public.create_company_for_founder($1, 'X', 'aktiebolag', NULL, NULL, '{}'::jsonb, '2026-01-01', '2026-12-31', '2026', 'verified', 't', '{}'::jsonb)`,
      [user],
    ))).rejects.toMatchObject({ code: '42501' })
  })
})

describe('apply_founder_verification', () => {
  it('never overwrites a decided verification', async () => {
    const user = await insertAuthUser()
    const companyId = await createForFounder(user, 'manual_review')
    await getPool().query(`UPDATE public.company_members SET verification_status = 'rejected' WHERE company_id = $1`, [companyId])
    const { rows } = await withServiceRole((c) => c.query(
      `SELECT public.apply_founder_verification($1, $2, 'verified', 'retry', '{}'::jsonb) AS applied`, [companyId, user],
    ))
    expect(rows[0].applied).toBe(false)
  })
})

describe('bankid_identities', () => {
  it('users cannot insert their own identity row', async () => {
    const user = await insertAuthUser()
    await expect(withUserContext(user, (c) => c.query(
      `INSERT INTO public.bankid_identities (user_id, personal_number_hash) VALUES ($1, 'forged')`, [user],
    ))).rejects.toMatchObject({ code: '42501' })
  })
})

describe('flag_access_request_for_verified_founder', () => {
  it('flags a request against a company without a verified owner', async () => {
    const squatter = await insertAuthUser()
    const founder = await insertAuthUser()
    const companyId = await createForFounder(squatter, 'manual_review')
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.company_access_requests (company_id, requester_user_id, requester_email) VALUES ($1, $2, 'f@x.se') RETURNING id`,
      [companyId, founder],
    )
    await withServiceRole((c) => c.query(`SELECT public.flag_access_request_for_verified_founder($1, 'verified')`, [rows[0].id]))
    const r = await getPool().query(`SELECT requires_platform_review FROM public.company_access_requests WHERE id = $1`, [rows[0].id])
    expect(r.rows[0].requires_platform_review).toBe(true)
  })
})

describe('platform_decide_founder_verification', () => {
  async function platformAdmin() {
    const id = await insertAuthUser()
    await getPool().query(`INSERT INTO public.platform_roles (user_id, role) VALUES ($1, 'platform_admin')`, [id])
    return id
  }

  it('a platform admin verifies a founder in review', async () => {
    const founder = await insertAuthUser()
    const companyId = await createForFounder(founder, 'manual_review')
    const admin = await platformAdmin()
    await withServiceRole((c) => c.query(
      `SELECT public.platform_decide_founder_verification($1, $2, 'verified', $3, 'ok')`, [companyId, founder, admin],
    ))
    expect(await owner(companyId, founder)).toMatchObject({ status: 'active', verification_status: 'verified' })
  })

  it('refuses a non-admin actor', async () => {
    const founder = await insertAuthUser()
    const companyId = await createForFounder(founder, 'manual_review')
    await expect(withServiceRole((c) => c.query(
      `SELECT public.platform_decide_founder_verification($1, $2, 'verified', $2, 'self')`, [companyId, founder],
    ))).rejects.toMatchObject({ code: '42501' })
  })
})
