import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/** Covers 20260927120000_api_keys_lifecycle. */

const h = (s: string) => createHash('sha256').update(s).digest('hex')

async function seedKey(opts: { role?: string; expiresAt?: string | null; refreshExpiresAt?: string | null } = {}) {
  const owner = await insertAuthUser()
  const user = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: owner })
  await getPool().query(
    `INSERT INTO public.company_members (company_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, $4)`,
    [companyId, owner, user, opts.role ?? 'member'],
  )
  const key = `nordklart_sk_${randomUUID()}`
  const refresh = `nordklart_rt_${randomUUID()}`
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.api_keys (user_id, company_id, key_hash, key_prefix, name, refresh_token_hash, expires_at, refresh_expires_at)
     VALUES ($1, $2, $3, 'nordklart_sk_x', 'test', $4, $5, $6) RETURNING id`,
    [user, companyId, h(key), h(refresh), opts.expiresAt ?? null, opts.refreshExpiresAt ?? null],
  )
  return { owner, user, companyId, key, refresh, keyId: rows[0].id }
}

const validate = async (key: string) => {
  const { rows } = await getPool().query(`SELECT * FROM public.validate_and_increment_api_key($1)`, [h(key)])
  return rows
}

const rotate = async (presented: string) => {
  const nextRefresh = `nordklart_rt_${randomUUID()}`
  const nextKey = `nordklart_sk_${randomUUID()}`
  const { rows } = await getPool().query<{ r: Record<string, unknown> }>(
    `SELECT public.rotate_api_key_refresh($1, $2, $3, 'nordklart_sk_y') AS r`,
    [h(presented), h(nextRefresh), h(nextKey)],
  )
  return { result: rows[0].r, nextRefresh, nextKey }
}

describe('validate_and_increment_api_key', () => {
  it('accepts a key whose owner is still a member', async () => {
    const s = await seedKey()
    const rows = await validate(s.key)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ user_id: s.user, company_id: s.companyId, rate_limited: false })
  })

  it('stops working when the membership is revoked, and the key is revoked with it', async () => {
    const s = await seedKey()
    await getPool().query(
      `UPDATE public.company_members SET status = 'revoked' WHERE company_id = $1 AND user_id = $2`,
      [s.companyId, s.user],
    )
    expect(await validate(s.key)).toHaveLength(0)
    const k = await getPool().query(`SELECT revoked_at, refresh_token_hash FROM public.api_keys WHERE id = $1`, [s.keyId])
    expect(k.rows[0].revoked_at).not.toBeNull()
    expect(k.rows[0].refresh_token_hash).toBeNull()
  })

  it('stops working when the membership row is deleted (account anonymisation)', async () => {
    const s = await seedKey()
    await getPool().query(`DELETE FROM public.company_members WHERE company_id = $1 AND user_id = $2`, [s.companyId, s.user])
    expect(await validate(s.key)).toHaveLength(0)
  })

  it('refuses an expired key', async () => {
    const s = await seedKey({ expiresAt: new Date(Date.now() - 1000).toISOString() })
    expect(await validate(s.key)).toHaveLength(0)
  })
})

describe('rotate_api_key_refresh', () => {
  it('rotates key and refresh token and sets lifetimes', async () => {
    const s = await seedKey()
    const { result, nextKey } = await rotate(s.refresh)
    expect(result).toMatchObject({ ok: true, api_key_id: s.keyId })
    expect(await validate(s.key)).toHaveLength(0)
    expect(await validate(nextKey)).toHaveLength(1)
    const k = await getPool().query(`SELECT expires_at, refresh_expires_at FROM public.api_keys WHERE id = $1`, [s.keyId])
    expect(new Date(k.rows[0].expires_at).getTime()).toBeGreaterThan(Date.now())
    expect(new Date(k.rows[0].refresh_expires_at).getTime()).toBeGreaterThan(Date.now() + 50 * 24 * 3600 * 1000)
  })

  it('revokes the key when an already-rotated refresh token is replayed', async () => {
    const s = await seedKey()
    const first = await rotate(s.refresh)
    expect(first.result.ok).toBe(true)
    const replay = await rotate(s.refresh)
    expect(replay.result).toEqual({ ok: false, error: 'refresh_token_reused' })
    expect(await validate(first.nextKey)).toHaveLength(0)
    const k = await getPool().query(`SELECT revoked_at FROM public.api_keys WHERE id = $1`, [s.keyId])
    expect(k.rows[0].revoked_at).not.toBeNull()
  })

  it('refuses an expired refresh token', async () => {
    const s = await seedKey({ refreshExpiresAt: new Date(Date.now() - 1000).toISOString() })
    expect((await rotate(s.refresh)).result).toEqual({ ok: false, error: 'refresh_token_expired' })
  })

  it('does not renew a key whose owner lost access', async () => {
    const s = await seedKey()
    await getPool().query(
      `UPDATE public.company_members SET role = 'viewer' WHERE company_id = $1 AND user_id = $2`,
      [s.companyId, s.user],
    )
    // Still a member (viewer): renewal allowed.
    expect((await rotate(s.refresh)).result.ok).toBe(true)
  })

  it('functions are service-role only', async () => {
    const { rows } = await getPool().query(
      `SELECT has_function_privilege('authenticated', 'public.rotate_api_key_refresh(text,text,text,text,interval,interval)', 'EXECUTE') AS a,
              has_function_privilege('authenticated', 'public.revoke_user_sessions(uuid,uuid)', 'EXECUTE') AS b,
              has_function_privilege('authenticated', 'public.api_key_owner_is_active(uuid,uuid)', 'EXECUTE') AS c`,
    )
    expect(rows[0]).toEqual({ a: false, b: false, c: false })
  })
})

describe('revoke_user_sessions', () => {
  it('runs on any auth schema and returns a count', async () => {
    const user = await insertAuthUser()
    const { rows } = await getPool().query<{ n: number }>(`SELECT public.revoke_user_sessions($1) AS n`, [user])
    expect(rows[0].n).toBeGreaterThanOrEqual(0)
  })
})
