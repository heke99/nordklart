/**
 * pg-real test for 20260924100000_security_definer_authenticated_surface.sql.
 *
 * 20260821210000 closed the SECURITY DEFINER surface to anon. This suite pins
 * the follow-up: a signed-in user must not be able to reach another tenant
 * through a SECURITY DEFINER function either.
 *
 *   - The concrete exploits (sync_team_to_company privilege escalation,
 *     next_voucher_number gap injection, cross-tenant year-end reads) fail.
 *   - The caller's own company still works, and the no-claims path that the
 *     service role / MCP / pg harness use is unaffected.
 *   - A catalog invariant: every SECURITY DEFINER function that authenticated
 *     can execute and that takes a tenant-scoping argument either checks the
 *     caller in its body or is on a reviewed allowlist. The next unguarded
 *     function fails here instead of being found in production.
 */
import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

interface PgError extends Error {
  code?: string
}

async function callAsUser(userId: string, sql: string, params: unknown[]): Promise<PgError | null> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ])
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
    await client.query('SET LOCAL ROLE authenticated')
    await client.query(sql, params)
    return null
  } catch (err) {
    return err as PgError
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

async function callBare(sql: string, params: unknown[]): Promise<PgError | null> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(sql, params)
    return null
  } catch (err) {
    return err as PgError
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

describe('SECURITY DEFINER surface for authenticated', () => {
  it('sync_team_to_company is not callable by a signed-in user (admin escalation)', async () => {
    const victim = await seedCompany()
    const attacker = await seedCompany()
    const teamId = randomUUID()
    await getPool().query(
      `INSERT INTO public.teams (id, name, created_by) VALUES ($1, 'Attacker team', $2)`,
      [teamId, attacker.userId],
    )
    await getPool().query(
      `INSERT INTO public.team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [teamId, attacker.userId],
    )

    const err = await callAsUser(attacker.userId, `SELECT public.sync_team_to_company($1, $2)`, [
      victim.companyId,
      teamId,
    ])
    expect(err?.code).toBe('42501')

    const { rows } = await getPool().query(
      `SELECT 1 FROM public.company_members WHERE company_id = $1 AND user_id = $2`,
      [victim.companyId, attacker.userId],
    )
    expect(rows).toHaveLength(0)
  })

  it('next_voucher_number: cross-tenant blocked, own company and no-claims allowed', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const sql = `SELECT public.next_voucher_number($1, $2, 'A')`

    expect((await callAsUser(a.userId, sql, [b.companyId, b.fiscalPeriodId]))?.code).toBe('42501')
    expect(await callAsUser(a.userId, sql, [a.companyId, a.fiscalPeriodId])).toBeNull()
    // The no-claims path is not guarded. (It still needs a user for the
    // voucher_sequences.user_id column, which is an unrelated constraint.)
    expect((await callBare(sql, [b.companyId, b.fiscalPeriodId]))?.code).not.toBe('42501')
  })

  it('read RPCs over ledger state reject another tenant', async () => {
    const a = await seedCompany()
    const b = await seedCompany()

    for (const sql of [
      `SELECT * FROM public.detect_voucher_gaps($1, $2, 'A')`,
      `SELECT * FROM public.year_end_control_status($1, $2)`,
      `SELECT * FROM public.year_end_profit_disposition_proposal($1, $2)`,
    ]) {
      const err = await callAsUser(a.userId, sql, [b.companyId, b.fiscalPeriodId])
      expect(err?.code, sql).toBe('42501')
    }
    expect(
      await callAsUser(a.userId, `SELECT * FROM public.detect_voucher_gaps($1, $2, 'A')`, [
        a.companyId,
        a.fiscalPeriodId,
      ]),
    ).toBeNull()
  })

  it('internal year-end helpers are not executable by authenticated at all', async () => {
    const a = await seedCompany()
    const err = await callAsUser(a.userId, `SELECT * FROM public.year_end_db_blockers($1, $2)`, [
      a.companyId,
      a.fiscalPeriodId,
    ])
    expect(err?.code).toBe('42501')
  })

  it('write RPCs with a company argument reject another tenant', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    for (const [sql, params] of [
      [`SELECT public.seed_chart_of_accounts($1, 'aktiebolag')`, [b.companyId]],
      [`SELECT public.generate_delivery_note_number($1)`, [b.companyId]],
      [`SELECT public.get_next_arrival_number($1)`, [b.companyId]],
      [`SELECT public.check_and_increment_inbox_quota($1, 10, 100)`, [b.companyId]],
    ] as const) {
      const err = await callAsUser(a.userId, sql, [...params])
      expect(err?.code, sql).toBe('42501')
    }
  })

  it('agent quota can only be consumed for the caller', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const sql = `SELECT public.check_and_increment_agent_quota($1, 10, 100)`
    expect((await callAsUser(a.userId, sql, [b.userId]))?.code).toBe('42501')
    expect(await callAsUser(a.userId, sql, [a.userId])).toBeNull()
  })

  it('check_email_exists is no longer a user-enumeration oracle for sessions', async () => {
    const a = await seedCompany()
    const err = await callAsUser(a.userId, `SELECT public.check_email_exists('x@example.com')`, [])
    expect(err?.code).toBe('42501')
  })

  it('every tenant-scoped SECURITY DEFINER function checks its caller or is allowlisted', async () => {
    /**
     * Reviewed exceptions. Each has a reason; "it is internal" is only valid
     * when EXECUTE has actually been revoked, which would drop it from this
     * query anyway.
     */
    const ALLOWLIST = new Map<string, string>([
      ['company_has_feature', 'plan metadata; called from postgres-owned views for non-member rows'],
      ['company_feature_usage', 'plan usage counts; same view constraint as company_has_feature'],
      ['company_commercial_limit', 'plan limits; same view constraint as company_has_feature'],
      ['assert_company_commercial_limit', 'wraps company_commercial_limit; raises only'],
      ['assert_company_member_claims', 'the guard itself'],
      ['bulk_book_transactions', 'in-function auth.uid() membership check with domain error'],
      ['match_batch_allocate', 'in-function auth.uid() membership check with domain error'],
      ['create_document_version', 'requires p_user_id = auth.uid() and membership'],
      ['delete_last_voucher', 'owner/admin check against auth.uid()'],
      ['replace_period_opening_balance_link', 'owner/admin check against auth.uid()'],
      ['generate_invoice_number', 'membership check against auth.uid()'],
      ['peek_next_invoice_number', 'membership check against auth.uid()'],
      ['create_company_with_owner', 'creates a company for auth.uid(); team membership enforced'],
      ['user_is_agency_member', 'boolean predicate about the caller'],
      ['user_is_team_admin', 'boolean predicate about the caller'],
      ['user_role_in_company', 'returns the caller role; null for non-members'],
    ])

    const { rows } = await getPool().query<{ name: string; args: string }>(`
      SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.prosecdef
         AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
         AND p.prorettype <> 'trigger'::regtype
         AND pg_get_function_identity_arguments(p.oid)
             ~ '(company_id|p_user_id|fiscal_period_id|p_entry_id|p_invoice_id|p_document_id|p_team_id|p_agency_id)'
         AND p.prosrc !~* '(user_company_ids|request\\.jwt|user_can_|user_is_|resolve_company_access|is_platform|require_service_role|assert_platform|auth\\.role|require_platform|require_company|assert_company_member_claims)'
       ORDER BY 1
    `)
    const unguarded = rows.filter((r) => !ALLOWLIST.has(r.name)).map((r) => `${r.name}(${r.args})`)
    expect(
      unguarded,
      'SECURITY DEFINER functions bypass RLS. A tenant-scoped one that authenticated can '
        + 'execute must check the caller (assert_company_member_claims) or have EXECUTE revoked.',
    ).toEqual([])
  })
})
