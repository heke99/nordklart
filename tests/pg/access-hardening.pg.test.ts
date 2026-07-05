import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany, insertCompanyMember } from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * Covers 20260714120000_access_hardening_agency_status_service_resolver:
 *   - user_is_agency_member / user_is_agency_admin require status = 'active'.
 *   - resolve_company_access_for_user resolves direct, agency and platform
 *     access for an explicit user id (service-role callers).
 *   - resolve_company_access (auth.uid() variant) still delegates correctly.
 */

async function seedAgency(params: { ownerId: string; clientCompanyId?: string }): Promise<string> {
  const agencyId = randomUUID()
  await getPool().query(
    `INSERT INTO public.agencies (id, name, status, created_by)
     VALUES ($1, 'Statusbyrån AB', 'active', $2)`,
    [agencyId, params.ownerId],
  )
  if (params.clientCompanyId) {
    await getPool().query(
      `INSERT INTO public.agency_clients (agency_id, company_id, status)
       VALUES ($1, $2, 'active')`,
      [agencyId, params.clientCompanyId],
    )
  }
  return agencyId
}

async function insertAgencyMember(params: {
  agencyId: string
  userId: string
  role: string
  status: string
}): Promise<void> {
  await getPool().query(
    `INSERT INTO public.agency_members (agency_id, user_id, role, status)
     VALUES ($1, $2, $3, $4)`,
    [params.agencyId, params.userId, params.role, params.status],
  )
}

describe('agency membership status in RLS helpers', () => {
  it('user_is_agency_member is false for suspended members, true for active', async () => {
    const owner = await insertAuthUser()
    const activeUser = await insertAuthUser()
    const suspendedUser = await insertAuthUser()
    const agencyId = await seedAgency({ ownerId: owner })

    await insertAgencyMember({ agencyId, userId: activeUser, role: 'accountant', status: 'active' })
    await insertAgencyMember({ agencyId, userId: suspendedUser, role: 'accountant', status: 'suspended' })

    await withUserContext(activeUser, async (client) => {
      const { rows } = await client.query(
        `SELECT public.user_is_agency_member($1) AS ok`,
        [agencyId],
      )
      expect(rows[0].ok).toBe(true)
    })

    await withUserContext(suspendedUser, async (client) => {
      const { rows } = await client.query(
        `SELECT public.user_is_agency_member($1) AS ok`,
        [agencyId],
      )
      expect(rows[0].ok).toBe(false)
    })
  })

  it('user_is_agency_admin is false for suspended admins', async () => {
    const owner = await insertAuthUser()
    const suspendedAdmin = await insertAuthUser()
    const agencyId = await seedAgency({ ownerId: owner })

    await insertAgencyMember({ agencyId, userId: suspendedAdmin, role: 'agency_admin', status: 'suspended' })

    await withUserContext(suspendedAdmin, async (client) => {
      const { rows } = await client.query(
        `SELECT public.user_is_agency_admin($1) AS ok`,
        [agencyId],
      )
      expect(rows[0].ok).toBe(false)
    })
  })
})

describe('resolve_company_access_for_user', () => {
  it('resolves direct owner membership for an explicit user id', async () => {
    const owner = await insertAuthUser()
    const company = await insertCompany({ createdBy: owner })
    await insertCompanyMember({ companyId: company, userId: owner, role: 'owner' })

    const { rows } = await getPool().query(
      `SELECT effective_role, access_source, can_read, can_write, can_manage_company
       FROM public.resolve_company_access_for_user($1, $2)`,
      [owner, company],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].effective_role).toBe('company_owner')
    expect(rows[0].access_source).toBe('direct')
    expect(rows[0].can_read).toBe(true)
    expect(rows[0].can_write).toBe(true)
    expect(rows[0].can_manage_company).toBe(true)
  })

  it('resolves active agency accountant access to a client company', async () => {
    const owner = await insertAuthUser()
    const staff = await insertAuthUser()
    const clientCompany = await insertCompany({ createdBy: owner })
    const agencyId = await seedAgency({ ownerId: owner, clientCompanyId: clientCompany })
    await insertAgencyMember({ agencyId, userId: staff, role: 'accountant', status: 'active' })

    const { rows } = await getPool().query(
      `SELECT effective_role, access_source, agency_id, can_write
       FROM public.resolve_company_access_for_user($1, $2)`,
      [staff, clientCompany],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].effective_role).toBe('accountant')
    expect(rows[0].access_source).toBe('agency')
    expect(rows[0].agency_id).toBe(agencyId)
    expect(rows[0].can_write).toBe(true)
  })

  it('returns no rows for suspended agency staff and unrelated users', async () => {
    const owner = await insertAuthUser()
    const suspended = await insertAuthUser()
    const stranger = await insertAuthUser()
    const clientCompany = await insertCompany({ createdBy: owner })
    const agencyId = await seedAgency({ ownerId: owner, clientCompanyId: clientCompany })
    await insertAgencyMember({ agencyId, userId: suspended, role: 'accountant', status: 'suspended' })

    const suspendedResult = await getPool().query(
      `SELECT 1 FROM public.resolve_company_access_for_user($1, $2)`,
      [suspended, clientCompany],
    )
    expect(suspendedResult.rows).toHaveLength(0)

    const strangerResult = await getPool().query(
      `SELECT 1 FROM public.resolve_company_access_for_user($1, $2)`,
      [stranger, clientCompany],
    )
    expect(strangerResult.rows).toHaveLength(0)
  })

  it('resolves platform_admin access without membership', async () => {
    const owner = await insertAuthUser()
    const admin = await insertAuthUser()
    const company = await insertCompany({ createdBy: owner })
    await getPool().query(
      `INSERT INTO public.platform_roles (user_id, role) VALUES ($1, 'platform_admin')`,
      [admin],
    )

    const { rows } = await getPool().query(
      `SELECT effective_role, access_source, can_manage_platform
       FROM public.resolve_company_access_for_user($1, $2)`,
      [admin, company],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].effective_role).toBe('platform_admin')
    expect(rows[0].access_source).toBe('platform')
    expect(rows[0].can_manage_platform).toBe(true)
  })

  it('resolve_company_access (auth.uid variant) still delegates', async () => {
    const owner = await insertAuthUser()
    const company = await insertCompany({ createdBy: owner })
    await insertCompanyMember({ companyId: company, userId: owner, role: 'owner' })

    await withUserContext(owner, async (client) => {
      const { rows } = await client.query(
        `SELECT effective_role, can_write FROM public.resolve_company_access($1)`,
        [company],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].effective_role).toBe('company_owner')
      expect(rows[0].can_write).toBe(true)
    })
  })
})
