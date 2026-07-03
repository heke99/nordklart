import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
} from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * Covers 20260710120000_bankid_sessions_signed_consents:
 *   - signed_consents immutability triggers (no delete, no content mutation,
 *     revocation-only updates allowed)
 *   - RLS: company-scoped consents, user-scoped bankid_sessions
 */

async function insertConsent(params: {
  companyId: string
  userId: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.signed_consents
       (id, company_id, user_id, consent_type, title, consent_text, signed_via, status)
     VALUES ($1, $2, $3, 'agency_data_sharing', 'Byrååtkomst', 'Jag samtycker till att byrån får åtkomst.', 'bankid', 'active')`,
    [id, params.companyId, params.userId],
  )
  return id
}

describe('signed_consents immutability', () => {
  it('blocks DELETE — consents are evidence', async () => {
    const user = await insertAuthUser()
    const company = await insertCompany({ createdBy: user })
    await insertCompanyMember({ companyId: company, userId: user, role: 'owner' })
    const consentId = await insertConsent({ companyId: company, userId: user })

    await expect(
      getPool().query(`DELETE FROM public.signed_consents WHERE id = $1`, [consentId]),
    ).rejects.toThrow(/återkalla/)
  })

  it('blocks mutation of the consent text', async () => {
    const user = await insertAuthUser()
    const company = await insertCompany({ createdBy: user })
    await insertCompanyMember({ companyId: company, userId: user, role: 'owner' })
    const consentId = await insertConsent({ companyId: company, userId: user })

    await expect(
      getPool().query(
        `UPDATE public.signed_consents SET consent_text = 'ändrad' WHERE id = $1`,
        [consentId],
      ),
    ).rejects.toThrow(/oföränderliga/)
  })

  it('allows revocation (status flip only)', async () => {
    const user = await insertAuthUser()
    const company = await insertCompany({ createdBy: user })
    await insertCompanyMember({ companyId: company, userId: user, role: 'owner' })
    const consentId = await insertConsent({ companyId: company, userId: user })

    const result = await getPool().query(
      `UPDATE public.signed_consents
         SET status = 'revoked', revoked_at = now(), revoked_by = $2, updated_at = now()
       WHERE id = $1
       RETURNING status`,
      [consentId, user],
    )
    expect(result.rows[0].status).toBe('revoked')
  })
})

describe('signed_consents + bankid_sessions RLS', () => {
  it('company members see only their company consents', async () => {
    const userA = await insertAuthUser()
    const userB = await insertAuthUser()
    const companyA = await insertCompany({ createdBy: userA })
    const companyB = await insertCompany({ createdBy: userB })
    await insertCompanyMember({ companyId: companyA, userId: userA, role: 'owner' })
    await insertCompanyMember({ companyId: companyB, userId: userB, role: 'owner' })

    const consentA = await insertConsent({ companyId: companyA, userId: userA })
    await insertConsent({ companyId: companyB, userId: userB })

    await withUserContext(userA, async (client) => {
      const { rows } = await client.query(`SELECT id, company_id FROM public.signed_consents`)
      expect(rows.some((r) => r.id === consentA)).toBe(true)
      expect(rows.every((r) => r.company_id === companyA)).toBe(true)
    })
  })

  it('bankid_sessions are visible only to their owner', async () => {
    const userA = await insertAuthUser()
    const userB = await insertAuthUser()
    const company = await insertCompany({ createdBy: userA })
    await insertCompanyMember({ companyId: company, userId: userA, role: 'owner' })
    await insertCompanyMember({ companyId: company, userId: userB, role: 'admin' })

    const sessionA = randomUUID()
    await getPool().query(
      `INSERT INTO public.bankid_sessions
         (id, user_id, company_id, provider, provider_session_ref, purpose, status)
       VALUES ($1, $2, $3, 'mock', 'mock-ref-1', 'consent', 'pending')`,
      [sessionA, userA, company],
    )

    await withUserContext(userB, async (client) => {
      const { rows } = await client.query(
        `SELECT id FROM public.bankid_sessions WHERE id = $1`,
        [sessionA],
      )
      // Same company but not the session owner — invisible.
      expect(rows).toHaveLength(0)
    })

    await withUserContext(userA, async (client) => {
      const { rows } = await client.query(
        `SELECT id FROM public.bankid_sessions WHERE id = $1`,
        [sessionA],
      )
      expect(rows).toHaveLength(1)
    })
  })
})
