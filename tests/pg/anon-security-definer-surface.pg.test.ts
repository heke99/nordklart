import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getClient, getPool } from '@/tests/pg/setup'
import { insertAuthUser, insertCompany } from '@/tests/pg/fixtures'

/**
 * `anon` is the role a request carries when it presents the public anon key and
 * no session. Supabase grants it EXECUTE on everything in `public` by default,
 * and for an ordinary function that is fine — it runs as the caller and RLS
 * decides. A SECURITY DEFINER function runs as the owner with RLS out of the
 * picture, so the grant is the whole authorisation story, and 39 of them had no
 * check of their own.
 *
 * `tests/pg/bootstrap-plain-postgres.sql` deliberately reproduces production's
 * default grants, so this file is testing the same posture the live database
 * has, not a stricter local one.
 */
describe('anon and SECURITY DEFINER (pg-real)', () => {
  it('cannot execute any SECURITY DEFINER function in public', async () => {
    const { rows } = await getPool().query<{ fn: string }>(`
      SELECT p.oid::regprocedure::text AS fn
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.prosecdef
         AND has_function_privilege('anon', p.oid, 'EXECUTE')
       ORDER BY 1
    `)

    expect(
      rows.map((r) => r.fn),
      'A SECURITY DEFINER function anon can execute is authorised by its body alone. '
      + 'Migrations must REVOKE EXECUTE FROM anon; see 20260821210000.',
    ).toEqual([])
  })

  it('leaves no table in public without RLS', async () => {
    // The table side of the same grant. anon holds ~2000 table privileges in
    // production and RLS is the only thing between it and the data — which is
    // Supabase's model working as intended, but only for as long as every table
    // has RLS. `tenant-isolation-matrix` checks tables carrying `company_id`;
    // this one takes the whole schema, because a table that leaks does not have
    // to have that column.
    const { rows } = await getPool().query<{ relname: string }>(`
      SELECT c.relname
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
       ORDER BY 1
    `)
    expect(
      rows.map((r) => r.relname),
      'anon can SELECT any table in public that has no RLS.',
    ).toEqual([])
  })

  it('has no policy that grants anything to anon', async () => {
    const { rows } = await getPool().query<{ tablename: string; policyname: string }>(`
      SELECT tablename, policyname FROM pg_policies
       WHERE schemaname = 'public' AND 'anon' = ANY(roles)
       ORDER BY 1, 2
    `)
    // A policy naming anon would turn the blanket grant into a real read.
    expect(rows).toEqual([])
  })

  it('keeps them reachable for the roles the application actually uses', async () => {
    // The fix must not have closed the door on everyone — this is what would
    // catch a REVOKE that took authenticated or service_role with it.
    const { rows } = await getPool().query<{ authed: number; service: number; total: number }>(`
      SELECT
        count(*) FILTER (WHERE has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS authed,
        count(*) FILTER (WHERE has_function_privilege('service_role', p.oid, 'EXECUTE')) AS service,
        count(*) AS total
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef
    `)
    expect(Number(rows[0].total)).toBeGreaterThan(100)
    expect(Number(rows[0].service)).toBeGreaterThan(Number(rows[0].total) / 2)
  })

  it('refuses the cross-tenant reads that were reachable before', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })

    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE anon')

      // Each of these answered for an arbitrary company id, with no session.
      await expect(
        client.query('SELECT public.company_entity_type($1)', [companyId]),
      ).rejects.toThrow(/permission denied/i)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('refuses the user-enumeration oracle', async () => {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE anon')
      await expect(
        client.query('SELECT public.check_email_exists($1)', [`probe-${randomUUID()}@example.com`]),
      ).rejects.toThrow(/permission denied/i)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('leaves the deliberately public views readable', async () => {
    // The one anon surface the product does have. Revoking too broadly would
    // take the pricing page down.
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE anon')
      await client.query('SELECT * FROM public.public_price_plans_v LIMIT 1')
      await client.query('SELECT * FROM public.public_price_start_v LIMIT 1')
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('shows why the per-function REVOKE is not optional', async () => {
    // PostgreSQL grants EXECUTE to PUBLIC on every new function, on top of
    // whatever pg_default_acl says, and anon is a member of PUBLIC. Removing
    // anon from the default privileges does not suppress that — so a new
    // SECURITY DEFINER function is born anon-executable no matter how the
    // defaults are configured. This test states that plainly rather than
    // letting a future reader assume the defaults have it covered: the first
    // case in this file is what actually holds the line, by failing the moment
    // a migration adds one without its own REVOKE.
    const name = `test_secdef_${randomUUID().replace(/-/g, '')}`
    const client = await getClient()
    try {
      await client.query(`
        CREATE FUNCTION public.${name}() RETURNS integer
        LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
        AS $fn$ SELECT 1 $fn$
      `)
      const before = await client.query(
        `SELECT has_function_privilege('anon', 'public.${name}()', 'EXECUTE') AS anon`,
      )
      expect(before.rows[0].anon).toBe(true)

      // And that one line is all it takes to close it.
      await client.query(`REVOKE ALL ON FUNCTION public.${name}() FROM PUBLIC, anon`)
      const after = await client.query(
        `SELECT has_function_privilege('anon', 'public.${name}()', 'EXECUTE') AS anon,
                has_function_privilege('authenticated', 'public.${name}()', 'EXECUTE') AS authed`,
      )
      expect(after.rows[0].anon).toBe(false)
      expect(after.rows[0].authed).toBe(true)
    } finally {
      await client.query(`DROP FUNCTION IF EXISTS public.${name}()`).catch(() => {})
      client.release()
    }
  })
})
