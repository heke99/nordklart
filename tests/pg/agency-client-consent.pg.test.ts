import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany, insertCompanyMember } from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * Covers 20260714130000_agency_client_consent_hardening:
 *   - An agency admin cannot self-activate a client link to a company they
 *     do not administer (previously possible → cross-tenant escalation).
 *   - Pending links can be created by agency admins.
 *   - The client company's owner approves (activates) the link.
 *   - Agency admins who also administer the client company (agency-created
 *     workspaces) can self-activate.
 */

async function seedAgencyWithAdmin(): Promise<{ agencyId: string; adminId: string }> {
  const adminId = await insertAuthUser()
  const agencyId = randomUUID()
  await getPool().query(
    `INSERT INTO public.agencies (id, name, status, created_by)
     VALUES ($1, 'Konsultbyrån AB', 'active', $2)`,
    [agencyId, adminId],
  )
  await getPool().query(
    `INSERT INTO public.agency_members (agency_id, user_id, role, status)
     VALUES ($1, $2, 'agency_admin', 'active')`,
    [agencyId, adminId],
  )
  return { agencyId, adminId }
}

describe('agency_clients consent hardening', () => {
  it('blocks an agency admin from inserting an ACTIVE link to a foreign company', async () => {
    const { agencyId, adminId } = await seedAgencyWithAdmin()
    const victimOwner = await insertAuthUser()
    const victimCompany = await insertCompany({ createdBy: victimOwner, name: 'Offer AB' })
    await insertCompanyMember({ companyId: victimCompany, userId: victimOwner, role: 'owner' })

    await withUserContext(adminId, async (client) => {
      await expect(
        client.query(
          `INSERT INTO public.agency_clients (agency_id, company_id, status)
           VALUES ($1, $2, 'active')`,
          [agencyId, victimCompany],
        ),
      ).rejects.toThrow(/row-level security/i)
    })
  })

  it('allows an agency admin to create a PENDING link', async () => {
    const { agencyId, adminId } = await seedAgencyWithAdmin()
    const clientOwner = await insertAuthUser()
    const clientCompany = await insertCompany({ createdBy: clientOwner, name: 'Kund AB' })
    await insertCompanyMember({ companyId: clientCompany, userId: clientOwner, role: 'owner' })

    await withUserContext(adminId, async (client) => {
      await expect(
        client.query(
          `INSERT INTO public.agency_clients (agency_id, company_id, status)
           VALUES ($1, $2, 'pending')`,
          [agencyId, clientCompany],
        ),
      ).resolves.toBeTruthy()
    })
  })

  it('blocks the agency admin from flipping a pending link to active', async () => {
    const { agencyId, adminId } = await seedAgencyWithAdmin()
    const clientOwner = await insertAuthUser()
    const clientCompany = await insertCompany({ createdBy: clientOwner, name: 'Kund AB' })
    await insertCompanyMember({ companyId: clientCompany, userId: clientOwner, role: 'owner' })
    await getPool().query(
      `INSERT INTO public.agency_clients (agency_id, company_id, status)
       VALUES ($1, $2, 'pending')`,
      [agencyId, clientCompany],
    )

    await withUserContext(adminId, async (client) => {
      const result = await client
        .query(
          `UPDATE public.agency_clients SET status = 'active'
           WHERE agency_id = $1 AND company_id = $2`,
          [agencyId, clientCompany],
        )
        .catch((err: Error) => err)

      // Either the WITH CHECK rejects loudly or zero rows update — both mean
      // the escalation is blocked and the link stays pending.
      if (result instanceof Error) {
        expect(result.message).toMatch(/row-level security/i)
      } else {
        expect(result.rowCount).toBe(0)
      }
    })

    const { rows } = await getPool().query(
      `SELECT status FROM public.agency_clients WHERE agency_id = $1 AND company_id = $2`,
      [agencyId, clientCompany],
    )
    expect(rows[0].status).toBe('pending')
  })

  it('lets the client company owner approve a pending link', async () => {
    const { agencyId } = await seedAgencyWithAdmin()
    const clientOwner = await insertAuthUser()
    const clientCompany = await insertCompany({ createdBy: clientOwner, name: 'Kund AB' })
    await insertCompanyMember({ companyId: clientCompany, userId: clientOwner, role: 'owner' })
    await getPool().query(
      `INSERT INTO public.agency_clients (agency_id, company_id, status)
       VALUES ($1, $2, 'pending')`,
      [agencyId, clientCompany],
    )

    await withUserContext(clientOwner, async (client) => {
      const result = await client.query(
        `UPDATE public.agency_clients
         SET status = 'active', approved_by_client_user_id = auth.uid(), approved_at = now()
         WHERE agency_id = $1 AND company_id = $2`,
        [agencyId, clientCompany],
      )
      expect(result.rowCount).toBe(1)
    })
  })

  it('allows self-activation when the agency admin also administers the client company', async () => {
    const { agencyId, adminId } = await seedAgencyWithAdmin()
    const clientCompany = await insertCompany({ createdBy: adminId, name: 'Byråns kund AB' })
    await insertCompanyMember({ companyId: clientCompany, userId: adminId, role: 'owner' })

    await withUserContext(adminId, async (client) => {
      await expect(
        client.query(
          `INSERT INTO public.agency_clients (agency_id, company_id, status)
           VALUES ($1, $2, 'active')`,
          [agencyId, clientCompany],
        ),
      ).resolves.toBeTruthy()
    })
  })
})
