import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withServiceRole } from '@/tests/pg/setup'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertCompanySettings,
  insertFiscalPeriod,
} from '@/tests/pg/fixtures'

/**
 * record_bankid_consent_v1 — the consent and the signature it completes are
 * one transaction.
 *
 * Before this, three separate writes: signed_consents, audit_log, and the
 * årsredovisning signature request — the last wrapped in a try/catch that only
 * logged. A failure there recorded the consent, flipped the session to
 * 'complete', showed the user a successful BankID signature, and left the
 * signature request 'pending'. These tests pin the two properties that fixes:
 * both rows move together, and the evidence columns are actually written.
 */

async function seed() {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  await insertCompanySettings({ companyId })
  const fiscalPeriodId = await insertFiscalPeriod({
    userId, companyId, periodStart: '2026-01-01', periodEnd: '2026-12-31', name: '2026',
  })
  return { userId, companyId, fiscalPeriodId }
}

async function insertSession(params: { userId: string; companyId: string }): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.bankid_sessions
       (id, user_id, company_id, provider, provider_mode, provider_session_ref,
        purpose, sign_text, context, status)
     VALUES ($1, $2, $3, 'mock', 'test', $4, 'sign', 'Jag godkänner…', '{}'::jsonb, 'pending')`,
    [id, params.userId, params.companyId, randomUUID()],
  )
  return id
}

async function insertSignatureRequest(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.arsredovisning_signature_requests
       (id, user_id, company_id, fiscal_period_id, role, signer_name, status)
     VALUES ($1, $2, $3, $4, 'styrelseledamot', 'Test Testsson', 'pending')`,
    [id, params.userId, params.companyId, params.fiscalPeriodId],
  )
  return id
}

function callArgs(sessionId: string, userId: string, signatureRequestId: string | null) {
  return [
    sessionId, userId, 'arsredovisning_signature', 'Fastställelseintyg',
    'Jag godkänner…', 'hmac-hash', 'XXXXXXXX-9802', 'Test Testsson',
    JSON.stringify({ kind: 'arsredovisning_signature' }), '2026-07-01T10:00:00Z',
    signatureRequestId, null,
  ]
}

const SQL = `SELECT public.record_bankid_consent_v1(
  $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text,
  $9::jsonb, $10::timestamptz, $11::uuid, $12::bytea) AS consent_id`

describe('record_bankid_consent_v1 (pg-real)', () => {
  it('writes the consent, the audit row and the signature evidence together', async () => {
    const { userId, companyId, fiscalPeriodId } = await seed()
    const sessionId = await insertSession({ userId, companyId })
    const signatureId = await insertSignatureRequest({ userId, companyId, fiscalPeriodId })

    const consentId = await withServiceRole(async (client) => {
      const { rows } = await client.query<{ consent_id: string }>(SQL, callArgs(sessionId, userId, signatureId))
      return rows[0]!.consent_id
    })

    const { rows: consents } = await getPool().query(
      `SELECT id, signed_via, personal_number_hash, personal_number_masked, status
         FROM public.signed_consents WHERE id = $1`, [consentId])
    expect(consents[0]).toMatchObject({
      signed_via: 'bankid', personal_number_hash: 'hmac-hash', status: 'active',
    })

    const { rows: sigs } = await getPool().query(
      `SELECT status, signed_at, signer_personnummer_hash, bankid_signature_data
         FROM public.arsredovisning_signature_requests WHERE id = $1`, [signatureId])
    expect(sigs[0]!.status).toBe('signed')
    expect(sigs[0]!.signed_at).not.toBeNull()
    // The whole point: the evidence column is populated, not just the blob.
    expect(sigs[0]!.signer_personnummer_hash).toBe('hmac-hash')
    expect(sigs[0]!.bankid_signature_data.bankid_session_id).toBe(sessionId)

    const { rows: audits } = await getPool().query<{ n: string }>(
      `SELECT count(*) AS n FROM public.audit_log
        WHERE table_name = 'signed_consents' AND record_id = $1`, [consentId])
    expect(Number(audits[0]!.n)).toBe(1)
  })

  it('records no consent at all when the signature request does not exist', async () => {
    const { userId, companyId } = await seed()
    const sessionId = await insertSession({ userId, companyId })

    await expect(
      withServiceRole((client) => client.query(SQL, callArgs(sessionId, userId, randomUUID()))),
    ).rejects.toThrow(/Signature request not found/i)

    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*) AS n FROM public.signed_consents WHERE bankid_session_id = $1`, [sessionId])
    expect(Number(rows[0]!.n)).toBe(0)
  })

  it('refuses to overwrite a signature another session already made', async () => {
    const { userId, companyId, fiscalPeriodId } = await seed()
    const firstSession = await insertSession({ userId, companyId })
    const secondSession = await insertSession({ userId, companyId })
    const signatureId = await insertSignatureRequest({ userId, companyId, fiscalPeriodId })

    await withServiceRole((client) => client.query(SQL, callArgs(firstSession, userId, signatureId)))

    await expect(
      withServiceRole((client) => client.query(SQL, callArgs(secondSession, userId, signatureId))),
    ).rejects.toThrow(/already signed by another session/i)

    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*) AS n FROM public.signed_consents WHERE bankid_session_id = $1`, [secondSession])
    expect(Number(rows[0]!.n)).toBe(0)
  })

  it('is idempotent for a replayed poll of the same session', async () => {
    const { userId, companyId, fiscalPeriodId } = await seed()
    const sessionId = await insertSession({ userId, companyId })
    const signatureId = await insertSignatureRequest({ userId, companyId, fiscalPeriodId })

    const first = await withServiceRole(async (client) => {
      const { rows } = await client.query<{ consent_id: string }>(SQL, callArgs(sessionId, userId, signatureId))
      return rows[0]!.consent_id
    })
    const second = await withServiceRole(async (client) => {
      const { rows } = await client.query<{ consent_id: string }>(SQL, callArgs(sessionId, userId, signatureId))
      return rows[0]!.consent_id
    })

    expect(second).toBe(first)
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*) AS n FROM public.signed_consents WHERE bankid_session_id = $1`, [sessionId])
    expect(Number(rows[0]!.n)).toBe(1)
  })

  it('rejects a session that belongs to another user', async () => {
    const { userId, companyId } = await seed()
    const sessionId = await insertSession({ userId, companyId })
    const outsiderId = await insertAuthUser()

    await expect(
      withServiceRole((client) => client.query(SQL, callArgs(sessionId, outsiderId, null))),
    ).rejects.toThrow(/session not found/i)
  })

  it('is unreachable without service_role', async () => {
    const { userId, companyId } = await seed()
    const sessionId = await insertSession({ userId, companyId })
    await expect(getPool().query(SQL, callArgs(sessionId, userId, null))).rejects.toThrow()
  })
})
