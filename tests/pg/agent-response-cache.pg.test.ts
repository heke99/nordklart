import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany } from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/** Covers 20261001120000_agent_response_cache. */

async function seed(opts: { expiresIn?: string } = {}) {
  const owner = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: owner })
  await getPool().query(`INSERT INTO public.company_members (company_id, user_id, role) VALUES ($1, $2, 'owner')`, [companyId, owner])
  const key = 'k'.repeat(64)
  await getPool().query(
    `INSERT INTO public.agent_response_cache (company_id, cache_key, intent_id, model, prompt_hash, response, response_text, expires_at)
     VALUES ($1, $2, 'general.help', 'claude-sonnet-5-5', 'sha256:p', '[{"type":"text","text":"Svar"}]', 'Svar', now() + $3::interval)`,
    [companyId, key, opts.expiresIn ?? '1 day'],
  )
  return { owner, companyId, key }
}

const hit = async (companyId: string, key: string) => {
  const { rows } = await getPool().query(`SELECT * FROM public.agent_response_cache_hit($1, $2)`, [companyId, key])
  return rows
}

describe('agent_response_cache', () => {
  it('returns a live answer and counts the hit', async () => {
    const s = await seed()
    expect(await hit(s.companyId, s.key)).toEqual([{ response: [{ type: 'text', text: 'Svar' }], response_text: 'Svar' }])
    await hit(s.companyId, s.key)
    const { rows } = await getPool().query(`SELECT hit_count, last_hit_at FROM public.agent_response_cache WHERE company_id = $1`, [s.companyId])
    expect(rows[0].hit_count).toBe(2)
    expect(rows[0].last_hit_at).not.toBeNull()
  })

  it('never returns an expired answer', async () => {
    const s = await seed({ expiresIn: '-1 minute' })
    expect(await hit(s.companyId, s.key)).toEqual([])
  })

  it('keeps answers per company', async () => {
    const s = await seed()
    const other = await seed()
    expect(await hit(other.companyId, s.key)).toHaveLength(1) // other company's own row
    await getPool().query(`DELETE FROM public.agent_response_cache WHERE company_id = $1`, [other.companyId])
    expect(await hit(other.companyId, s.key)).toEqual([])
  })

  it('rejects a duplicate key within a company', async () => {
    const s = await seed()
    await expect(
      getPool().query(
        `INSERT INTO public.agent_response_cache (company_id, cache_key, intent_id, model, prompt_hash, response, response_text, expires_at)
         VALUES ($1, $2, 'general.help', 'm', 'h', '[]', 'x', now() + interval '1 day')`,
        [s.companyId, s.key],
      ),
    ).rejects.toThrow(/duplicate key/)
  })

  it('is not readable or writable by company members through the API', async () => {
    const s = await seed()
    await withUserContext(s.owner, async (client) => {
      await expect(client.query(`SELECT 1 FROM public.agent_response_cache`)).rejects.toThrow(/permission denied/)
    })
    await withUserContext(s.owner, async (client) => {
      await expect(
        client.query(
          `INSERT INTO public.agent_response_cache (company_id, cache_key, intent_id, model, prompt_hash, response, response_text, expires_at)
           VALUES ($1, $2, 'general.help', 'm', 'h', '[]', 'planted', now() + interval '1 day')`,
          [s.companyId, 'p'.repeat(64)],
        ),
      ).rejects.toThrow(/permission denied/)
    })
    const { rows } = await getPool().query(
      `SELECT has_function_privilege('authenticated', 'public.agent_response_cache_hit(uuid, text)', 'EXECUTE') AS auth`,
    )
    expect(rows[0].auth).toBe(false)
  })

  it('is removed with the company', async () => {
    const s = await seed()
    const before = await getPool().query(`SELECT count(*)::int AS n FROM public.agent_response_cache WHERE company_id = $1`, [s.companyId])
    expect(before.rows[0].n).toBe(1)
    const fk = await getPool().query(
      `SELECT confdeltype FROM pg_constraint WHERE conrelid = 'public.agent_response_cache'::regclass AND contype = 'f'`,
    )
    expect(fk.rows[0].confdeltype).toBe('c')
  })
})
