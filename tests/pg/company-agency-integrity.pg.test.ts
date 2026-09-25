/**
 * pg-real test for 20260924101000_company_and_agency_membership_integrity.sql.
 *
 *   - companies.org_number is immutable for session callers once set, and a
 *     session cannot set a number another active company already carries.
 *   - Sessions cannot INSERT into companies directly.
 *   - agency_admin cannot promote themselves to agency_owner, cannot touch the
 *     owner row, and cannot INSERT members directly; an owner can hand over
 *     ownership but the agency always keeps one active owner.
 *   - Service-role / no-claims paths are unaffected.
 */
import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from './setup'
import { insertAuthUser, insertCompany, insertCompanyMember } from './fixtures'

interface PgError extends Error {
  code?: string
}

async function asUser(userId: string, sql: string, params: unknown[]): Promise<PgError | null> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ])
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
    await client.query('SET LOCAL ROLE authenticated')
    await client.query(sql, params)
    await client.query('COMMIT')
    return null
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    return err as PgError
  } finally {
    client.release()
  }
}

function uniqueOrgNumber(): string {
  return `55${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}`
}

async function seedAgency(): Promise<{ agencyId: string; ownerId: string; adminId: string }> {
  const ownerId = await insertAuthUser()
  const adminId = await insertAuthUser()
  const agencyId = randomUUID()
  await getPool().query(
    `INSERT INTO public.agencies (id, name, status, created_by) VALUES ($1, 'Byrå AB', 'active', $2)`,
    [agencyId, ownerId],
  )
  await getPool().query(
    `INSERT INTO public.agency_members (agency_id, user_id, role, status)
     VALUES ($1, $2, 'agency_owner', 'active'), ($1, $3, 'agency_admin', 'active')`,
    [agencyId, ownerId, adminId],
  )
  return { agencyId, ownerId, adminId }
}

describe('company identity integrity', () => {
  it('an admin cannot change an org_number once set', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId, orgNumber: uniqueOrgNumber() })
    await insertCompanyMember({ companyId, userId, role: 'owner' })

    const err = await asUser(userId, `UPDATE public.companies SET org_number = $2 WHERE id = $1`, [
      companyId,
      uniqueOrgNumber(),
    ])
    expect(err?.code).toBe('42501')
  })

  it('first-time set is allowed, but not to a number another company carries', async () => {
    const taken = uniqueOrgNumber()
    const other = await insertAuthUser()
    await insertCompany({ createdBy: other, orgNumber: taken })

    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId, orgNumber: null })
    await insertCompanyMember({ companyId, userId, role: 'owner' })

    const squat = await asUser(userId, `UPDATE public.companies SET org_number = $2 WHERE id = $1`, [
      companyId,
      taken,
    ])
    expect(squat?.code).toBe('23505')

    const own = await asUser(userId, `UPDATE public.companies SET org_number = $2 WHERE id = $1`, [
      companyId,
      uniqueOrgNumber(),
    ])
    expect(own).toBeNull()
  })

  it('service role / no-claims can still correct an org_number', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId, orgNumber: uniqueOrgNumber() })
    await expect(
      getPool().query(`UPDATE public.companies SET org_number = $2 WHERE id = $1`, [companyId, uniqueOrgNumber()]),
    ).resolves.toBeDefined()
  })

  it('sessions cannot insert a company directly', async () => {
    const userId = await insertAuthUser()
    const err = await asUser(
      userId,
      `INSERT INTO public.companies (name, entity_type, created_by) VALUES ('Direkt AB', 'aktiebolag', $1)`,
      [userId],
    )
    expect(err?.code).toBe('42501')
  })
})

describe('agency owner protection', () => {
  it('agency_admin cannot promote themselves to owner', async () => {
    const { agencyId, adminId } = await seedAgency()
    const err = await asUser(
      adminId,
      `UPDATE public.agency_members SET role = 'agency_owner' WHERE agency_id = $1 AND user_id = $2`,
      [agencyId, adminId],
    )
    expect(err?.code).toBe('42501')
  })

  it('agency_admin cannot demote or remove the owner', async () => {
    const { agencyId, ownerId, adminId } = await seedAgency()
    const demote = await asUser(
      adminId,
      `UPDATE public.agency_members SET role = 'read_only' WHERE agency_id = $1 AND user_id = $2`,
      [agencyId, ownerId],
    )
    expect(demote?.code).toBe('42501')
    const remove = await asUser(
      adminId,
      `DELETE FROM public.agency_members WHERE agency_id = $1 AND user_id = $2`,
      [agencyId, ownerId],
    )
    expect(remove?.code).toBe('42501')
  })

  it('agency_admin cannot insert arbitrary users', async () => {
    const { agencyId, adminId } = await seedAgency()
    const stranger = await insertAuthUser()
    const err = await asUser(
      adminId,
      `INSERT INTO public.agency_members (agency_id, user_id, role, status) VALUES ($1, $2, 'accountant', 'active')`,
      [agencyId, stranger],
    )
    expect(err?.code).toBe('42501')
  })

  it('agency_admin can still change non-owner staff roles', async () => {
    const { agencyId, adminId } = await seedAgency()
    const staff = await insertAuthUser()
    await getPool().query(
      `INSERT INTO public.agency_members (agency_id, user_id, role, status) VALUES ($1, $2, 'accountant', 'active')`,
      [agencyId, staff],
    )
    const err = await asUser(
      adminId,
      `UPDATE public.agency_members SET role = 'reviewer' WHERE agency_id = $1 AND user_id = $2`,
      [agencyId, staff],
    )
    expect(err).toBeNull()
  })

  it('an owner can hand over ownership but cannot leave the agency ownerless', async () => {
    const { agencyId, ownerId, adminId } = await seedAgency()

    const lastOwner = await asUser(
      ownerId,
      `UPDATE public.agency_members SET role = 'agency_admin' WHERE agency_id = $1 AND user_id = $2`,
      [agencyId, ownerId],
    )
    expect(lastOwner?.code).toBe('42501')

    const promote = await asUser(
      ownerId,
      `UPDATE public.agency_members SET role = 'agency_owner' WHERE agency_id = $1 AND user_id = $2`,
      [agencyId, adminId],
    )
    expect(promote).toBeNull()

    const stepDown = await asUser(
      ownerId,
      `UPDATE public.agency_members SET role = 'agency_admin' WHERE agency_id = $1 AND user_id = $2`,
      [agencyId, ownerId],
    )
    expect(stepDown).toBeNull()
  })
})
