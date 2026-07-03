import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany } from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * Covers 20260713120000_agency_payroll_role:
 *   - agency_members role CHECK accepts 'payroll' and still rejects unknowns.
 *   - agency_invitations role CHECK accepts 'payroll'.
 *   - resolve_company_access maps an active payroll member of an agency with
 *     an active client link to effective_role 'accountant' with can_write.
 */

async function seedAgencyWithClient(params: {
  ownerId: string
  companyId: string
}): Promise<string> {
  const agencyId = randomUUID()
  await getPool().query(
    `INSERT INTO public.agencies (id, name, status, created_by)
     VALUES ($1, 'Testbyrån AB', 'active', $2)`,
    [agencyId, params.ownerId],
  )
  await getPool().query(
    `INSERT INTO public.agency_clients (agency_id, company_id, status)
     VALUES ($1, $2, 'active')`,
    [agencyId, params.companyId],
  )
  return agencyId
}

describe('agency payroll role', () => {
  it('agency_members accepts payroll and rejects unknown roles', async () => {
    const owner = await insertAuthUser()
    const payrollUser = await insertAuthUser()
    const company = await insertCompany({ createdBy: owner })
    const agencyId = await seedAgencyWithClient({ ownerId: owner, companyId: company })

    await expect(
      getPool().query(
        `INSERT INTO public.agency_members (agency_id, user_id, role, status)
         VALUES ($1, $2, 'payroll', 'active')`,
        [agencyId, payrollUser],
      ),
    ).resolves.toBeTruthy()

    const bogusUser = await insertAuthUser()
    await expect(
      getPool().query(
        `INSERT INTO public.agency_members (agency_id, user_id, role, status)
         VALUES ($1, $2, 'janitor', 'active')`,
        [agencyId, bogusUser],
      ),
    ).rejects.toThrow(/check/i)
  })

  it('agency_invitations accepts payroll', async () => {
    const owner = await insertAuthUser()
    const company = await insertCompany({ createdBy: owner })
    const agencyId = await seedAgencyWithClient({ ownerId: owner, companyId: company })

    await expect(
      getPool().query(
        `INSERT INTO public.agency_invitations (agency_id, email, role, token_hash, expires_at)
         VALUES ($1, 'lon@byran.se', 'payroll', $2, now() + interval '7 days')`,
        [agencyId, `hash-${randomUUID()}`],
      ),
    ).resolves.toBeTruthy()
  })

  it('resolve_company_access maps payroll → accountant with write access', async () => {
    const owner = await insertAuthUser()
    const payrollUser = await insertAuthUser()
    const company = await insertCompany({ createdBy: owner })
    const agencyId = await seedAgencyWithClient({ ownerId: owner, companyId: company })

    await getPool().query(
      `INSERT INTO public.agency_members (agency_id, user_id, role, status)
       VALUES ($1, $2, 'payroll', 'active')`,
      [agencyId, payrollUser],
    )

    await withUserContext(payrollUser, async (client) => {
      const { rows } = await client.query(
        `SELECT effective_role, access_source, can_write, can_review, can_manage_company
         FROM public.resolve_company_access($1)`,
        [company],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].effective_role).toBe('accountant')
      expect(rows[0].access_source).toBe('agency')
      expect(rows[0].can_write).toBe(true)
      expect(rows[0].can_review).toBe(true)
      expect(rows[0].can_manage_company).toBe(false)
    })
  })
})
