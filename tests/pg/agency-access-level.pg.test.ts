import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * Covers 20260925110000_agency_access_level_enforced: the client's chosen
 * engagement scope caps agency staff, and agency access never manages the
 * client company.
 */
async function seedEngagement(accessLevel: string, agencyRole: string) {
  const owner = await insertAuthUser()
  const staff = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: owner })
  const agencyId = randomUUID()
  await getPool().query(
    `INSERT INTO public.agencies (id, name, status, created_by) VALUES ($1, 'Byrån AB', 'active', $2)`,
    [agencyId, owner],
  )
  await getPool().query(
    `INSERT INTO public.agency_clients (agency_id, company_id, status, access_level) VALUES ($1, $2, 'active', $3)`,
    [agencyId, companyId, accessLevel],
  )
  await getPool().query(
    `INSERT INTO public.agency_members (agency_id, user_id, role, status) VALUES ($1, $2, $3, 'active')`,
    [agencyId, staff, agencyRole],
  )
  const { rows } = await getPool().query(
    `SELECT effective_role, can_write, can_review, can_manage_company, can_manage_agency
       FROM public.resolve_company_access_for_user($1, $2)`,
    [staff, companyId],
  )
  return rows[0]
}

describe('agency_clients.access_level', () => {
  it.each([
    ['review', 'agency_admin', 'reviewer'],
    ['review', 'accountant', 'reviewer'],
    ['audit', 'agency_owner', 'auditor'],
  ])('%s engagement caps %s at %s without write', async (level, role, expected) => {
    const access = await seedEngagement(level, role)
    expect(access.effective_role).toBe(expected)
    expect(access.can_write).toBe(false)
    expect(access.can_review).toBe(true)
    expect(access.can_manage_company).toBe(false)
  })

  it('bookkeeping engagement keeps accountant write access', async () => {
    const access = await seedEngagement('bookkeeping', 'accountant')
    expect(access.effective_role).toBe('accountant')
    expect(access.can_write).toBe(true)
  })

  it('agency admin on full_service writes but cannot manage the client company', async () => {
    const access = await seedEngagement('full_service', 'agency_admin')
    expect(access.effective_role).toBe('company_admin')
    expect(access.can_write).toBe(true)
    expect(access.can_manage_company).toBe(false)
    expect(access.can_manage_agency).toBe(true)
  })
})
