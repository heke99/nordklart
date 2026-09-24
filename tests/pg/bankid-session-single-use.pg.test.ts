/**
 * pg-real test for 20260924102000_bankid_session_single_use.sql.
 *
 *   - A login order can be consumed once; the second attempt (replay) is false.
 *   - Two concurrent consumers: exactly one wins.
 *   - A missing start row (the start audit write is best-effort) is created
 *     already consumed, so the first login still works and the second fails.
 *   - A link order only links for the user who started it.
 *   - Only service_role may call it.
 */
import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, openServiceRoleTx } from './setup'
import { insertAuthUser } from './fixtures'

async function consume(ref: string, kind: 'login' | 'link', userId: string | null = null): Promise<boolean> {
  const { rows } = await getPool().query<{ ok: boolean }>(
    `SELECT public.consume_bankid_session('mock', $1, $2, $3) AS ok`,
    [ref, kind, userId],
  )
  return rows[0].ok
}

async function startRow(ref: string, initiator: string | null = null): Promise<void> {
  await getPool().query(
    `INSERT INTO public.bankid_sessions (provider, provider_session_ref, purpose, status, initiator_user_id)
     VALUES ('mock', $1, 'auth', 'complete', $2)`,
    [ref, initiator],
  )
}

describe('consume_bankid_session', () => {
  it('lets a login order through once', async () => {
    const ref = randomUUID()
    await startRow(ref)
    expect(await consume(ref, 'login')).toBe(true)
    expect(await consume(ref, 'login')).toBe(false)
  })

  it('creates a missing start row already consumed', async () => {
    const ref = randomUUID()
    expect(await consume(ref, 'login')).toBe(true)
    expect(await consume(ref, 'login')).toBe(false)
    const { rows } = await getPool().query(
      `SELECT consumed_at IS NOT NULL AS consumed FROM public.bankid_sessions WHERE provider_session_ref = $1`,
      [ref],
    )
    expect(rows[0].consumed).toBe(true)
  })

  it('exactly one of two concurrent consumers wins', async () => {
    const ref = randomUUID()
    await startRow(ref)
    const a = await openServiceRoleTx()
    const b = await openServiceRoleTx()
    try {
      const first = await a.client.query<{ ok: boolean }>(
        `SELECT public.consume_bankid_session('mock', $1, 'login') AS ok`,
        [ref],
      )
      const secondPromise = b.client.query<{ ok: boolean }>(
        `SELECT public.consume_bankid_session('mock', $1, 'login') AS ok`,
        [ref],
      )
      await a.commit()
      const second = await secondPromise
      await b.commit()
      expect([first.rows[0].ok, second.rows[0].ok].sort()).toEqual([false, true])
    } finally {
      await a.rollback().catch(() => {})
      await b.rollback().catch(() => {})
    }
  })

  it('links only for the user who started the order', async () => {
    const owner = await insertAuthUser()
    const other = await insertAuthUser()
    const ref = randomUUID()
    await startRow(ref, owner)

    expect(await consume(ref, 'link', other)).toBe(false)
    expect(await consume(ref, 'link', owner)).toBe(true)
    expect(await consume(ref, 'link', owner)).toBe(false)
  })

  it('refuses to link an order with no recorded initiator', async () => {
    const user = await insertAuthUser()
    const ref = randomUUID()
    await startRow(ref, null)
    expect(await consume(ref, 'link', user)).toBe(false)
  })

  it('is not executable by authenticated', async () => {
    const { rows } = await getPool().query<{ ok: boolean }>(
      `SELECT has_function_privilege('authenticated',
         'public.consume_bankid_session(text, text, text, uuid)', 'EXECUTE') AS ok`,
    )
    expect(rows[0].ok).toBe(false)
  })
})
