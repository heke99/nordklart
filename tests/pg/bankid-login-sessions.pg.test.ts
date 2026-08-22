import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getClient, getPool, withUserContext } from '@/tests/pg/setup'
import { insertAuthUser } from '@/tests/pg/fixtures'

/**
 * Login BankID orders start before there is an account to attach them to, so
 * bankid_sessions had to admit a NULL user_id — but only for that one purpose,
 * and without letting a pre-authentication row become visible to anybody.
 */
describe('bankid_sessions for the login flow (pg-real)', () => {
  it('accepts an auth order with no user yet', async () => {
    const id = randomUUID()
    await getPool().query(
      `INSERT INTO public.bankid_sessions
         (id, user_id, provider, provider_mode, provider_session_ref, purpose, status, context)
       VALUES ($1, NULL, 'mock', 'test', $2, 'auth', 'pending', '{"kind":"login"}'::jsonb)`,
      [id, `ref-${id}`],
    )

    const { rows } = await getPool().query(
      'SELECT user_id, purpose FROM public.bankid_sessions WHERE id = $1',
      [id],
    )
    expect(rows[0].user_id).toBeNull()
    expect(rows[0].purpose).toBe('auth')
  })

  it('still requires a user for every other purpose', async () => {
    for (const purpose of ['sign', 'consent', 'identity_verification']) {
      const id = randomUUID()
      await expect(
        getPool().query(
          `INSERT INTO public.bankid_sessions
             (id, user_id, provider, provider_mode, provider_session_ref, purpose, status)
           VALUES ($1, NULL, 'mock', 'test', $2, $3, 'pending')`,
          [id, `ref-${id}`, purpose],
        ),
      ).rejects.toThrow(/bankid_sessions_user_required_unless_auth/)
    }
  })

  it('hides an unclaimed order from every authenticated user', async () => {
    const id = randomUUID()
    await getPool().query(
      `INSERT INTO public.bankid_sessions
         (id, user_id, provider, provider_mode, provider_session_ref, purpose, status)
       VALUES ($1, NULL, 'mock', 'test', $2, 'auth', 'pending')`,
      [id, `ref-${id}`],
    )

    const someone = await insertAuthUser()
    await withUserContext(someone, async (client) => {
      const { rows } = await client.query(
        'SELECT id FROM public.bankid_sessions WHERE id = $1',
        [id],
      )
      // user_id = auth.uid() is never true for NULL, so the row belongs to
      // nobody until the completion step claims it.
      expect(rows).toHaveLength(0)
    })
  })

  it('does not let a user forge an unclaimed order through their own session', async () => {
    // The nullable user_id is for the service role writing a pre-authentication
    // record. A client must not be able to create one: the INSERT policy is
    // `user_id = auth.uid()`, and NULL never satisfies it.
    const someone = await insertAuthUser()

    await withUserContext(someone, async (client) => {
      await expect(
        client.query(
          `INSERT INTO public.bankid_sessions
             (user_id, provider, provider_mode, provider_session_ref, purpose, status)
           VALUES (NULL, 'mock', 'test', $1, 'auth', 'pending')`,
          [`forged-${randomUUID()}`],
        ),
      ).rejects.toThrow(/row-level security/i)
    })

    // Their own row is fine — that is what the policy is for. Separate
    // transaction: the refusal above aborts the one it happened in.
    await withUserContext(someone, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO public.bankid_sessions
           (user_id, provider, provider_mode, provider_session_ref, purpose, status)
         VALUES ($1, 'mock', 'test', $2, 'auth', 'pending')
         RETURNING id`,
        [someone, `own-${randomUUID()}`],
      )
      expect(rows).toHaveLength(1)
    })
  })

  it('refuses two live orders sharing one provider reference', async () => {
    const ref = `ref-${randomUUID()}`
    await getPool().query(
      `INSERT INTO public.bankid_sessions
         (id, user_id, provider, provider_mode, provider_session_ref, purpose, status)
       VALUES (gen_random_uuid(), NULL, 'mock', 'test', $1, 'auth', 'pending')`,
      [ref],
    )
    await expect(
      getPool().query(
        `INSERT INTO public.bankid_sessions
           (id, user_id, provider, provider_mode, provider_session_ref, purpose, status)
         VALUES (gen_random_uuid(), NULL, 'mock', 'test', $1, 'auth', 'pending')`,
        [ref],
      ),
    ).rejects.toThrow(/idx_bankid_sessions_provider_ref_unique/)
  })

  it('sweeps only unclaimed orders that are old enough', async () => {
    const client = await getClient()
    try {
      const stale = randomUUID()
      const fresh = randomUUID()
      const claimed = randomUUID()
      const owner = await insertAuthUser()

      await client.query(
        `INSERT INTO public.bankid_sessions
           (id, user_id, provider, provider_mode, provider_session_ref, purpose, status, created_at)
         VALUES
           ($1, NULL,  'mock', 'test', $4, 'auth', 'pending', now() - interval '31 days'),
           ($2, NULL,  'mock', 'test', $5, 'auth', 'pending', now()),
           ($3, $6,    'mock', 'test', $7, 'auth', 'complete', now() - interval '31 days')`,
        [stale, fresh, claimed, `r1-${stale}`, `r2-${fresh}`, owner, `r3-${claimed}`],
      )

      await client.query('SELECT public.cleanup_unclaimed_bankid_sessions()')

      const { rows } = await client.query(
        'SELECT id FROM public.bankid_sessions WHERE id = ANY($1::uuid[])',
        [[stale, fresh, claimed]],
      )
      const surviving = rows.map((r) => r.id).sort()
      expect(surviving).toEqual([fresh, claimed].sort())
    } finally {
      client.release()
    }
  })
})
