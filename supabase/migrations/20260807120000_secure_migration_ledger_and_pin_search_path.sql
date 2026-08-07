-- Close the one ERROR-level Supabase security advisor finding on the migration
-- ledger, and pin search_path on the accounting-critical trigger functions the
-- advisor still reports as mutable.
--
-- Evidence: docs/audits/2026-08-07-live-database-verification.md §5.
--
-- pg-test: covered-by lib/core/bookkeeping/__tests__/migration-ledger-rls.pg.test.ts

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Migration ledger must not be readable through PostgREST
-- ---------------------------------------------------------------------------
-- public.nordklart_schema_migrations is created by scripts/supabase-migrate.cjs
-- at runtime, not by a migration, so it does not exist in a freshly migrated
-- test database. Everything here is therefore conditional.
--
-- The advisor reports `rls_disabled_in_public` for it: the table sits in the
-- PostgREST-exposed `public` schema, so anon/authenticated could enumerate the
-- full deployment history. It holds no tenant data, and the runner connects as
-- the table owner (which bypasses RLS), so enabling RLS with no policy denies
-- every PostgREST role while leaving migrations working.
DO $$
BEGIN
  IF to_regclass('public.nordklart_schema_migrations') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.nordklart_schema_migrations ENABLE ROW LEVEL SECURITY';
    -- Deliberately no policy: deny-all for anon/authenticated. Owner and
    -- service-role access is unaffected.
    EXECUTE 'REVOKE ALL ON public.nordklart_schema_migrations FROM anon, authenticated';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Pin search_path on accounting-critical trigger functions
-- ---------------------------------------------------------------------------
-- These predate the "always pin search_path" convention and are still reported
-- as `function_search_path_mutable`. They enforce journal immutability, voucher
-- numbering, retention and period locks — exactly the functions where object
-- shadowing would be most damaging.
--
-- ALTER FUNCTION ... SET search_path only changes the configuration; it does not
-- touch the body, so this cannot alter accounting behaviour. Each is applied
-- only if the function exists, matched on name so overloads are all covered.
DO $$
DECLARE
  target text;
  fn record;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'enforce_journal_entry_line_immutability',
    'enforce_retention_journal_entries',
    'next_voucher_number',
    'detect_voucher_gaps',
    'get_next_arrival_number',
    'enforce_company_lock_date',
    'assign_specification_number',
    'generate_inbox_local_part',
    'enforce_company_member_role_transitions',
    'enforce_company_member_role_on_insert',
    'enforce_first_of_month_for_subsequent_periods',
    'handle_new_user'
  ]
  LOOP
    FOR fn IN
      SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = target
        AND NOT EXISTS (
          SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS c
          WHERE c LIKE 'search_path=%'
        )
    LOOP
      EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', fn.sig);
    END LOOP;
  END LOOP;
END;
$$;

COMMIT;
