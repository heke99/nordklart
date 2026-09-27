/**
 * pg-real test for the Supabase advisor migrations:
 *   20260925140000_advisor_security_hardening.sql
 *   20260925141000_advisor_rls_policy_performance.sql
 *   20260925142000_advisor_indexes.sql
 *
 * Catalog invariants keep the advisor findings from creeping back one
 * migration at a time; the behavioural cases prove the view and grant
 * changes did what they claim. Row-level behaviour of the rebuilt policies is
 * covered by the tenant-isolation and RLS suites, which run unchanged.
 */
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertFiscalPeriod, seedCompany } from './fixtures'

interface PgError extends Error {
  code?: string
}

/**
 * SECURITY DEFINER functions a signed-in session may execute. Each is called
 * from a user session on purpose and checks its caller in the body (reviewed
 * in 20260925140000). Adding one means reviewing it the same way.
 */
const AUTHENTICATED_SECURITY_DEFINER = [
  'anonymize_user_account', 'approve_fiscal_period_reopen', 'bulk_book_transactions',
  'check_and_increment_agent_quota', 'check_and_increment_inbox_quota', 'commit_journal_entry',
  'company_commercial_limit', 'company_effective_feature_access', 'company_feature_access',
  'company_feature_access_catalog', 'company_request_subscription_change', 'complete_core_onboarding',
  'complete_sie_import', 'create_company_with_owner', 'create_document_version',
  'create_new_annual_report_draft', 'delete_last_voucher', 'detect_voucher_gaps', 'ensure_user_team',
  'generate_article_number', 'generate_delivery_note_number', 'generate_invoice_number',
  'get_account_gl_lines_for_matching', 'get_next_arrival_number', 'get_unlinked_gl_lines',
  'historical_open_items_at', 'is_platform_admin', 'link_invoice_to_voucher',
  'link_supplier_invoice_to_voucher', 'list_accessible_companies', 'mark_entry_as_opening_balance',
  'match_batch_allocate', 'next_voucher_number', 'peek_next_invoice_number',
  'platform_add_subscription_item', 'platform_bind_stripe_price', 'platform_create_one_time_purchase',
  'platform_create_price_plan', 'platform_create_price_plan_version',
  'platform_grant_complimentary_bankgiro', 'platform_grant_complimentary_full_access',
  'platform_mark_subscription_change_request', 'platform_publish_price_plan_version',
  'platform_repair_complimentary_access_grants', 'platform_replace_plan_version_features',
  'platform_retire_price_plan_version', 'platform_revoke_commercial_access_grant',
  'platform_revoke_user_role', 'platform_set_company_subscription',
  'platform_set_price_plan_commercial_profile', 'platform_set_price_plan_version_grace_days',
  'platform_set_product_tax_settings', 'platform_set_subscription_cancellation_state',
  'platform_set_subscription_item_status', 'platform_set_user_role', 'platform_update_price_plan_catalog',
  'record_annual_report_preflight', 'record_sie_import_corrections', 'replace_recurring_schedule_items',
  'request_bankgiro_application', 'request_fiscal_period_reopen', 'resolve_company_access',
  'rotate_company_inbox', 'seed_chart_of_accounts', 'seed_tax_codes_for_company',
  'select_onboarding_start_path', 'user_can_access_company_v2', 'user_can_manage_company_billing',
  'user_can_write_company', 'user_company_ids', 'user_is_agency_admin', 'user_is_agency_member',
  'user_is_company_admin', 'user_is_team_admin', 'user_role_in_company', 'user_team_ids',
  'year_end_control_status', 'year_end_profit_disposition_proposal',
].sort()

async function asRole<T>(role: 'anon' | 'authenticated', userId: string | null, fn: (q: (sql: string, p?: unknown[]) => Promise<{ rows: T[] }>) => Promise<void>) {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify(userId ? { sub: userId, role } : { role }),
    ])
    if (userId) await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
    await client.query(`SET LOCAL ROLE ${role}`)
    await fn(async (sql, p) => (await client.query(sql, p)) as unknown as { rows: T[] })
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

describe('advisor hardening — catalog invariants', () => {
  it('exactly the reviewed SECURITY DEFINER functions are executable by authenticated, none by anon', async () => {
    const { rows } = await getPool().query<{ name: string; anon: boolean }>(`
      SELECT DISTINCT p.proname AS name, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon
        FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.prosecdef
         AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       ORDER BY 1`)
    expect(rows.map((r) => r.name)).toEqual(AUTHENTICATED_SECURITY_DEFINER)
    expect(rows.filter((r) => r.anon)).toEqual([])
  })

  it('no trigger function is executable by a session role', async () => {
    const { rows } = await getPool().query(`
      SELECT p.oid::regprocedure::text AS fn
        FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.prosecdef
         AND p.prorettype = 'trigger'::regtype
         AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
              OR has_function_privilege('anon', p.oid, 'EXECUTE'))`)
    expect(rows).toEqual([])
  })

  it('delete_user_account (bypasses retention triggers) is executable by no API role', async () => {
    const { rows } = await getPool().query<{ authenticated: boolean; service: boolean }>(`
      SELECT has_function_privilege('authenticated', 'public.delete_user_account(uuid)', 'EXECUTE') AS authenticated,
             has_function_privilege('service_role', 'public.delete_user_account(uuid)', 'EXECUTE') AS service`)
    expect(rows[0]).toEqual({ authenticated: false, service: false })
  })

  it('every public function outside extensions pins search_path', async () => {
    const { rows } = await getPool().query(`
      SELECT p.oid::regprocedure::text AS fn
        FROM pg_proc p
        LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
       WHERE p.pronamespace = 'public'::regnamespace
         AND d.objid IS NULL
         AND p.prokind IN ('f', 'p')
         AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%')`)
    expect(rows).toEqual([])
  })

  it('no RLS policy evaluates auth.* or current_setting() per row', async () => {
    const { rows } = await getPool().query(`
      SELECT tablename, policyname
        FROM pg_policies
       WHERE schemaname = 'public'
         AND (   coalesce(qual, '') ~ '(?<!SELECT )(auth\\.(uid|jwt|role)\\(\\)|current_setting\\()'
              OR coalesce(with_check, '') ~ '(?<!SELECT )(auth\\.(uid|jwt|role)\\(\\)|current_setting\\()')`)
    expect(rows).toEqual([])
  })

  it('at most one permissive policy per table, role and command', async () => {
    const { rows } = await getPool().query(`
      WITH p AS (
        SELECT tablename, policyname, unnest(roles) AS role,
               unnest(CASE WHEN cmd = 'ALL' THEN ARRAY['SELECT','INSERT','UPDATE','DELETE'] ELSE ARRAY[cmd] END) AS action
          FROM pg_policies
         WHERE schemaname = 'public' AND permissive = 'PERMISSIVE')
      SELECT tablename, role, action, array_agg(policyname) AS policies
        FROM p GROUP BY 1, 2, 3 HAVING count(*) > 1`)
    expect(rows).toEqual([])
  })

  it('no SECURITY DEFINER views in public', async () => {
    const { rows } = await getPool().query(`
      SELECT c.relname
        FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace
         AND c.relkind = 'v'
         AND NOT coalesce('security_invoker=true' = ANY (c.reloptions), false)
         AND c.relname IN ('skatteverket_connections_v', 'public_price_plans_v', 'public_price_start_v')`)
    expect(rows).toEqual([])
  })

  it('every foreign key outside auth.users has a covering index; no duplicate on webhook_events', async () => {
    const { rows } = await getPool().query(`
      SELECT c.conrelid::regclass::text AS tbl, c.conname
        FROM pg_constraint c
       WHERE c.contype = 'f'
         AND c.connamespace = 'public'::regnamespace
         AND c.confrelid <> 'auth.users'::regclass
         AND NOT EXISTS (
           SELECT 1 FROM pg_index i
            WHERE i.indrelid = c.conrelid
              AND (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] @> c.conkey
              AND (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] <@ c.conkey)`)
    expect(rows).toEqual([])
    const dup = await getPool().query(`SELECT to_regclass('public.webhook_events_code_uidx') AS idx`)
    expect(dup.rows[0].idx).toBeNull()
  })
})

describe('advisor hardening — behaviour', () => {
  it('skatteverket_connections_v: members see their own company, not others, never the tokens', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    for (const c of [a, b]) {
      await getPool().query(
        `INSERT INTO public.skatteverket_tokens (user_id, company_id, access_token, refresh_token, expires_at)
         VALUES ($1, $2, 'secret-access', 'secret-refresh', now() + interval '1 hour')`,
        [c.userId, c.companyId],
      )
    }

    await asRole<{ company_id: string }>('authenticated', a.userId, async (q) => {
      const { rows } = await q(`SELECT company_id FROM public.skatteverket_connections_v`)
      expect(rows.map((r) => r.company_id)).toEqual([a.companyId])
    })
    await asRole('authenticated', a.userId, async (q) => {
      await expect(q(`SELECT access_token FROM public.skatteverket_tokens`)).rejects.toMatchObject({ code: '42501' })
    })
    await asRole('authenticated', a.userId, async (q) => {
      await expect(q(`SELECT * FROM public.skatteverket_tokens`)).rejects.toMatchObject({ code: '42501' })
    })
    await asRole('anon', null, async (q) => {
      await expect(q(`SELECT * FROM public.skatteverket_connections_v`)).rejects.toMatchObject({ code: '42501' })
    })
  })

  it('public pricing views are not readable by session roles', async () => {
    const userId = await insertAuthUser()
    for (const view of ['public_price_plans_v', 'public_price_start_v']) {
      await asRole('anon', null, async (q) => {
        await expect(q(`SELECT * FROM public.${view}`)).rejects.toMatchObject({ code: '42501' })
      })
      await asRole('authenticated', userId, async (q) => {
        await expect(q(`SELECT * FROM public.${view}`)).rejects.toMatchObject({ code: '42501' })
      })
    }
  })

  it('create_company_with_owner is refused for a regular session', async () => {
    const userId = await insertAuthUser()
    const err = await withUserContext(userId, async (client) => {
      try {
        await client.query(`SELECT public.create_company_with_owner('Direkt AB', 'aktiebolag', false, NULL)`)
        return null
      } catch (e) {
        return e as PgError
      }
    })
    expect(err?.code).toBe('42501')
  })

  it('revoked functions fail with insufficient_privilege for a session', async () => {
    const a = await seedCompany()
    for (const sql of [
      `SELECT public.delete_user_account('${a.userId}'::uuid)`,
      `SELECT public.reserve_voucher_range('${a.companyId}'::uuid, '${a.fiscalPeriodId}'::uuid, 'A', 10)`,
      `SELECT public.start_onboarding_session('${a.companyId}'::uuid, 'bookkeeping_direct', '${a.userId}'::uuid)`,
    ]) {
      await asRole('authenticated', a.userId, async (q) => {
        await expect(q(sql), sql).rejects.toMatchObject({ code: '42501' })
      })
    }
  })

  it('btree_gist lives outside public and the fiscal-year exclusion constraint still holds', async () => {
    const { rows } = await getPool().query(
      `SELECT extnamespace::regnamespace::text AS schema FROM pg_extension WHERE extname = 'btree_gist'`,
    )
    expect(rows[0].schema).not.toBe('public')

    const a = await seedCompany()
    await expect(
      insertFiscalPeriod({ userId: a.userId, companyId: a.companyId, periodStart: '2026-06-01', periodEnd: '2027-05-31', name: 'Overlap' }),
    ).rejects.toMatchObject({ code: '23P01' })
  })
})
