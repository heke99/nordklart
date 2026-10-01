import { describe, expect, it } from 'vitest'
import { insertAuthUser } from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/** Covers 20261001100000_legal_reacceptance_trafexa. */

type Pending = { legal_text_version_id: string; document_type: string; version: string; public_path: string }

const pendingFor = (userId: string) =>
  withUserContext(userId, async (client) => {
    const { rows } = await client.query<Pending>(`SELECT * FROM public.pending_legal_documents()`)
    return rows
  })

const accept = async (userId: string, versionIds: string[]) => {
  const { rows } = await getPool().query<{ r: Record<string, unknown> }>(
    `SELECT public.accept_legal_documents($1, $2::uuid[], 'reacceptance', '192.0.2.1'::inet, 'vitest') AS r`,
    [userId, versionIds],
  )
  return rows[0].r
}

describe('legal text versions after the supplier change', () => {
  it('has exactly one active 2026-10-01 version of terms, privacy policy and DPA', async () => {
    const { rows } = await getPool().query<{ document_type: string; version: string; supplier: string }>(
      `SELECT document_type, version, metadata ->> 'supplier' AS supplier
         FROM public.legal_text_versions
        WHERE is_active AND document_type IN ('terms', 'privacy_policy', 'dpa')
        ORDER BY document_type`,
    )
    expect(rows).toEqual([
      { document_type: 'dpa', version: '2026-10-01', supplier: 'Trafexa Nordic AB' },
      { document_type: 'privacy_policy', version: '2026-10-01', supplier: 'Trafexa Nordic AB' },
      { document_type: 'terms', version: '2026-10-01', supplier: 'Trafexa Nordic AB' },
    ])
    const old = await getPool().query(
      `SELECT 1 FROM public.legal_text_versions WHERE version = '2026-06-27' AND document_type = 'terms' AND (is_active OR retired_at IS NULL)`,
    )
    expect(old.rowCount).toBe(0)
  })
})

describe('pending_legal_documents', () => {
  it('lists terms and privacy policy for a user who accepted only the old versions', async () => {
    const user = await insertAuthUser()
    await getPool().query(
      `INSERT INTO public.legal_acceptances (user_id, legal_text_version_id, document_type, source)
       SELECT $1, id, document_type, 'register' FROM public.legal_text_versions
        WHERE version = '2026-06-27' AND document_type IN ('terms', 'privacy_policy')`,
      [user],
    )
    const pending = await pendingFor(user)
    expect(pending.map((p) => [p.document_type, p.version])).toEqual([
      ['terms', '2026-10-01'],
      ['privacy_policy', '2026-10-01'],
    ])
  })

  it('does not expose another user\'s acceptances and returns nothing without a session', async () => {
    const a = await insertAuthUser()
    const b = await insertAuthUser()
    const pendingA = await pendingFor(a)
    await accept(a, pendingA.map((p) => p.legal_text_version_id))
    expect(await pendingFor(a)).toHaveLength(0)
    expect(await pendingFor(b)).toHaveLength(2)
    const anon = await getPool().query(`SELECT has_function_privilege('anon', 'public.pending_legal_documents()', 'EXECUTE') AS ok`)
    expect(anon.rows[0].ok).toBe(false)
  })
})

describe('accept_legal_documents', () => {
  it('records both acceptances with IP and user agent and is idempotent', async () => {
    const user = await insertAuthUser()
    const ids = (await pendingFor(user)).map((p) => p.legal_text_version_id)
    expect(await accept(user, ids)).toMatchObject({ ok: true, accepted: 2, pending: 0 })
    expect(await accept(user, ids)).toMatchObject({ ok: true, accepted: 0, pending: 0 })
    const { rows } = await getPool().query(
      `SELECT document_type, source, host(ip_address) AS ip, user_agent FROM public.legal_acceptances WHERE user_id = $1 ORDER BY document_type`,
      [user],
    )
    expect(rows).toEqual([
      { document_type: 'privacy_policy', source: 'reacceptance', ip: '192.0.2.1', user_agent: 'vitest' },
      { document_type: 'terms', source: 'reacceptance', ip: '192.0.2.1', user_agent: 'vitest' },
    ])
  })

  it('reports what is still pending when only one document is accepted', async () => {
    const user = await insertAuthUser()
    const terms = (await pendingFor(user)).find((p) => p.document_type === 'terms')!
    expect(await accept(user, [terms.legal_text_version_id])).toMatchObject({ ok: false, pending: 1, error: 'documents_pending' })
  })

  it('refuses a retired version', async () => {
    const user = await insertAuthUser()
    const { rows } = await getPool().query<{ id: string }>(
      `SELECT id FROM public.legal_text_versions WHERE document_type = 'terms' AND version = '2026-06-27'`,
    )
    expect(await accept(user, [rows[0].id])).toMatchObject({ ok: false, error: 'version_not_active' })
  })

  it('is not executable by API roles', async () => {
    const { rows } = await getPool().query(
      `SELECT has_function_privilege('authenticated', 'public.accept_legal_documents(uuid, uuid[], text, inet, text)', 'EXECUTE') AS auth,
              has_function_privilege('anon', 'public.accept_legal_documents(uuid, uuid[], text, inet, text)', 'EXECUTE') AS anon`,
    )
    expect(rows[0]).toEqual({ auth: false, anon: false })
  })

  it('new signups that accept the terms are recorded against the new versions', async () => {
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO auth.users (id, email, instance_id, raw_user_meta_data)
       VALUES (gen_random_uuid(), 'pg-real-legal-' || gen_random_uuid() || '@test.invalid',
               '00000000-0000-0000-0000-000000000000'::uuid,
               '{"accepted_terms": true, "accepted_privacy": true}'::jsonb)
       RETURNING id`,
    )
    expect(await pendingFor(rows[0].id)).toHaveLength(0)
  })
})
