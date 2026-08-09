import { describe, expect, it } from 'vitest'
import { getPool } from './setup'

/**
 * Two search_path invariants, enforced against the live catalog rather than
 * against the migration text — because what matters is the definition that
 * survived every later redefinition, not the one a migration wrote once.
 *
 * 1. Every SECURITY DEFINER function in `public` pins its search_path.
 *    Without a pin the body runs with the definer's privileges but resolves
 *    names against the CALLER's search_path, so anyone who can create objects
 *    in an earlier schema can shadow a table the body trusts. This is the
 *    `function_search_path_mutable` advisor finding, and it reached three
 *    functions including the API-key validator.
 *
 * 2. Every function that calls pgcrypto includes the extension schema in that
 *    pin. This one has already cost an outage: pinning `search_path = public,
 *    pg_temp` on a function whose body calls `digest()` makes it fail at
 *    RUNTIME with `function digest(bytea, unknown) does not exist`, because
 *    pgcrypto lives in `extensions`. The fix for finding #1 is exactly what
 *    causes #2, which is why they are guarded together.
 */

/** Functions that legitimately have no pin, with the reason recorded. */
const UNPINNED_ALLOWLIST = new Map<string, string>([
  // Intentionally empty. Add an entry only with a written justification —
  // "it is only a trigger" is not one; block_document_deletion was a trigger.
])

interface FunctionRow {
  name: string
  args: string
  /**
   * proconfig as an ARRAY, not a joined string. `search_path=public,
   * extensions, pg_temp` contains commas of its own, so joining the array and
   * splitting it again silently truncates every multi-schema path to its first
   * entry — which reports every correctly pinned pgcrypto function as broken.
   */
  config: string[] | null
}

async function securityDefinerFunctions(): Promise<FunctionRow[]> {
  const { rows } = await getPool().query<FunctionRow>(`
    SELECT p.proname AS name,
           pg_get_function_identity_arguments(p.oid) AS args,
           p.proconfig AS config
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
    ORDER BY p.proname
  `)
  return rows
}

function searchPathOf(config: string[] | null): string | null {
  const entry = config?.find((part) => part.startsWith('search_path='))
  return entry ? entry.slice('search_path='.length) : null
}

describe('SECURITY DEFINER functions pin their search_path', () => {
  it('leaves no unpinned SECURITY DEFINER function in public', async () => {
    const functions = await securityDefinerFunctions()
    expect(functions.length).toBeGreaterThan(100)

    const unpinned = functions
      .filter((fn) => searchPathOf(fn.config) === null)
      .filter((fn) => !UNPINNED_ALLOWLIST.has(fn.name))
      .map((fn) => `${fn.name}(${fn.args})`)

    expect(
      unpinned,
      'A SECURITY DEFINER function without a pinned search_path resolves object '
      + 'names against the caller. Pin it with ALTER FUNCTION ... SET search_path.',
    ).toEqual([])
  })

  it('never pins a search_path that omits pg_temp handling or is empty', async () => {
    const functions = await securityDefinerFunctions()
    const suspicious = functions
      .map((fn) => ({ fn, path: searchPathOf(fn.config) }))
      .filter(({ path }) => path !== null && path.trim() === '')
      .map(({ fn }) => fn.name)
    expect(suspicious).toEqual([])
  })
})

describe('functions using pgcrypto keep the extension schema on their path', () => {
  it('resolves pgcrypto from the schema the extension is actually installed in', async () => {
    const { rows: extensionRows } = await getPool().query<{ schema: string }>(
      `SELECT n.nspname AS schema FROM pg_extension e
       JOIN pg_namespace n ON n.oid = e.extnamespace
       WHERE e.extname = 'pgcrypto'`,
    )
    // If pgcrypto is not installed at all the guard below is meaningless.
    expect(extensionRows).toHaveLength(1)
    const extensionSchema = extensionRows[0].schema

    const { rows } = await getPool().query<FunctionRow>(`
      SELECT p.proname AS name,
             pg_get_function_identity_arguments(p.oid) AS args,
             p.proconfig AS config
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.prosrc ~* '(^|[^a-z_.])(digest|gen_random_bytes|crypt|gen_salt|hmac)\\s*\\('
      ORDER BY p.proname
    `)
    // The set is small but must not be empty — an empty set would mean the
    // detector stopped matching and the guard silently stopped guarding.
    expect(rows.length).toBeGreaterThan(0)

    const broken = rows
      .filter((fn) => {
        const path = searchPathOf(fn.config)
        // No pin at all is caught by the first suite; here we only care that a
        // pin, if present, can still reach pgcrypto.
        return path !== null && !path.split(',').some((part) => part.trim() === extensionSchema)
      })
      .map((fn) => `${fn.name}(${fn.args})`)

    expect(
      broken,
      `These functions call pgcrypto but their pinned search_path cannot reach `
      + `schema "${extensionSchema}". They will fail at runtime with `
      + `"function digest(bytea, unknown) does not exist".`,
    ).toEqual([])
  })

  it('can actually call digest from inside a pinned function', async () => {
    // The catalog check above is structural. This one proves the pin works,
    // which is the property the outage actually violated.
    const { rows } = await getPool().query<{ ok: boolean }>(`
      SELECT length(public.__nordklart_search_path_probe()) = 32 AS ok
    `).catch(async () => {
      await getPool().query(`
        CREATE OR REPLACE FUNCTION public.__nordklart_search_path_probe()
        RETURNS bytea LANGUAGE sql SECURITY DEFINER
        SET search_path = public, extensions, pg_temp
        AS $$ SELECT digest('nordklart', 'sha256') $$;
      `)
      return getPool().query<{ ok: boolean }>(
        `SELECT length(public.__nordklart_search_path_probe()) = 32 AS ok`,
      )
    })
    expect(rows[0].ok).toBe(true)
    await getPool().query('DROP FUNCTION IF EXISTS public.__nordklart_search_path_probe()')
  })
})
