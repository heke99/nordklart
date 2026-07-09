/**
 * pg-real coverage for migration 20260715160000 (BankID consent hardening):
 *   - user_can_write_company(): writer true, viewer false
 *   - signed_consents UPDATE (revocation) requires write capability — viewers
 *     can no longer revoke consents over PostgREST
 *   - one consent per BankID session (unique index)
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it, beforeAll } from 'vitest'
import { insertAuthUser, insertCompany, insertCompanyMember } from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

async function insertConsent(params: { companyId: string; userId: string; sessionId?: string | null }): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.signed_consents
       (id, company_id, user_id, consent_type, title, consent_text, signed_via, status, bankid_session_id)
     VALUES ($1, $2, $3, 'skatteverket', 'Skatteverket-flöden', 'Jag samtycker.', 'bankid', 'active', $4)`,
    [id, params.companyId, params.userId, params.sessionId ?? null],
  )
  return id
}

async function insertSession(params: { companyId: string; userId: string }): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.bankid_sessions
       (id, user_id, company_id, provider, provider_mode, provider_session_ref, purpose, status)
     VALUES ($1, $2, $3, 'mock', 'test', $4, 'consent', 'pending')`,
    [id, params.userId, params.companyId, `ref-${id}`],
  )
  return id
}

describe('bankid consent hardening', () => {
  let ownerId: string
  let viewerId: string
  let companyId: string

  beforeAll(async () => {
    ownerId = await insertAuthUser()
    viewerId = await insertAuthUser()
    companyId = await insertCompany({ createdBy: ownerId })
    await insertCompanyMember({ companyId, userId: ownerId, role: 'owner' })
    await insertCompanyMember({ companyId, userId: viewerId, role: 'viewer' })
  })

  it('user_can_write_company: owner true, viewer false', async () => {
    const asOwner = await withUserContext(ownerId, async (client) => {
      const { rows } = await client.query(`SELECT public.user_can_write_company($1) AS ok`, [companyId])
      return rows[0].ok
    })
    expect(asOwner).toBe(true)

    const asViewer = await withUserContext(viewerId, async (client) => {
      const { rows } = await client.query(`SELECT public.user_can_write_company($1) AS ok`, [companyId])
      return rows[0].ok
    })
    expect(asViewer).toBe(false)
  })

  it('a viewer can READ consents but cannot revoke them', async () => {
    const consentId = await insertConsent({ companyId, userId: ownerId })

    const readable = await withUserContext(viewerId, async (client) => {
      const { rows } = await client.query(`SELECT id FROM public.signed_consents WHERE id = $1`, [consentId])
      return rows.length
    })
    expect(readable).toBe(1)

    // RLS blocks the UPDATE for viewers: zero rows affected (policy filters).
    const updatedCount = await withUserContext(viewerId, async (client) => {
      const result = await client.query(
        `UPDATE public.signed_consents
         SET status = 'revoked', revoked_at = now(), revoked_by = $2, updated_at = now()
         WHERE id = $1`,
        [consentId, viewerId],
      )
      return result.rowCount
    })
    expect(updatedCount).toBe(0)

    const { rows } = await getPool().query(`SELECT status FROM public.signed_consents WHERE id = $1`, [consentId])
    expect(rows[0].status).toBe('active')
  })

  it('an owner can revoke a consent', async () => {
    const consentId = await insertConsent({ companyId, userId: ownerId })
    const updatedCount = await withUserContext(ownerId, async (client) => {
      const result = await client.query(
        `UPDATE public.signed_consents
         SET status = 'revoked', revoked_at = now(), revoked_by = $2, updated_at = now()
         WHERE id = $1`,
        [consentId, ownerId],
      )
      return result.rowCount
    })
    expect(updatedCount).toBe(1)
  })

  it('rejects a second consent for the same BankID session (23505)', async () => {
    const sessionId = await insertSession({ companyId, userId: ownerId })
    await insertConsent({ companyId, userId: ownerId, sessionId })
    await expect(insertConsent({ companyId, userId: ownerId, sessionId })).rejects.toMatchObject({ code: '23505' })
  })

  it('sessions without a bankid_session_id are unaffected by the unique index', async () => {
    await insertConsent({ companyId, userId: ownerId, sessionId: null })
    await insertConsent({ companyId, userId: ownerId, sessionId: null })
  })
})
