-- =============================================================================
-- Close the SECURITY DEFINER surface to anon
--
-- A Supabase project ships with
--
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role
--
-- so every function this repository has ever created is EXECUTE-able by `anon`
-- — the role a request carries when it presents the public anon key and no
-- session. For an ordinary function that is fine: it runs as the caller and RLS
-- decides what it can see. For a SECURITY DEFINER function it is not, because
-- the whole point of SECURITY DEFINER is that it runs as the owner and RLS does
-- not apply. The only thing standing between an unauthenticated caller and the
-- data is whatever check the function body happens to make.
--
-- Most of them do check. 39 did not, and it was reproducible: against a replay
-- carrying production's grants,
--
--   SET ROLE anon;
--   SELECT public.company_entity_type('<any company id>');   -- 'aktiebolag'
--   SELECT public.check_email_exists('someone@example.com');  -- true/false
--   SELECT * FROM public.detect_voucher_gaps('<any company id>', NULL, NULL);
--
-- all answer. That is a cross-tenant read and a user-enumeration oracle
-- reachable with nothing but the public key, and the same list includes
-- functions that write (`seed_chart_of_accounts`, `finalize_sie_import`,
-- `sync_team_to_company`, `cleanup_sandbox_user`).
--
-- Adding a guard to 39 function bodies would fix today's list and leave the
-- next one to be found the same way. The grant is the defect: nothing in this
-- product calls a SECURITY DEFINER function as anon. Every call site goes
-- through a service-role client or an authenticated session — verified across
-- `app/`, `lib/`, `components/` and `extensions/`, and the only two public
-- endpoints read a view (`public_price_plans_v`) and an external API.
--
-- So this revokes EXECUTE from anon on every SECURITY DEFINER function in
-- `public`, and changes the default privilege so the next one is closed when it
-- is created rather than after someone notices. `authenticated` and
-- `service_role` are untouched: they are the roles the application actually
-- uses, and the per-function REVOKEs the sensitive migrations already carry
-- stay in force on top of this.
--
-- Non-SECURITY-DEFINER functions keep their anon grant. They run as the caller
-- and RLS gates them, which is Supabase's model working as intended; narrowing
-- them too would be a change with no defect behind it.
--
-- pg-test: covered-by tests/pg/anon-security-definer-surface.pg.test.ts
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_fn      regprocedure;
  v_revoked integer := 0;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosecdef
       AND has_function_privilege('anon', p.oid, 'EXECUTE')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_fn);
    v_revoked := v_revoked + 1;
  END LOOP;

  RAISE NOTICE 'revoked anon EXECUTE on % SECURITY DEFINER function(s)', v_revoked;
END;
$$;

-- Drop anon from the explicit default so a new function does not pick up a
-- direct grant.
--
-- This is NOT sufficient on its own, and it would be dishonest to imply it is.
-- PostgreSQL applies its own hardwired default for functions — `GRANT EXECUTE
-- TO PUBLIC` — in addition to whatever `pg_default_acl` holds, and anon is a
-- member of PUBLIC. `ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE ON FUNCTIONS
-- FROM PUBLIC` does not suppress it: measured against this exact database, a
-- freshly created SECURITY DEFINER function still comes out with `=X` in its
-- ACL and `has_function_privilege('anon', …)` still answers true. So that line
-- is not here pretending to work.
--
-- What actually keeps this closed is the per-function `REVOKE ALL … FROM
-- PUBLIC, anon, authenticated` that the sensitive migrations already carry, and
-- `tests/pg/anon-security-definer-surface.pg.test.ts`, which fails the moment
-- any SECURITY DEFINER function in `public` becomes anon-executable again. The
-- test is the durable half of this fix; the loop above is the one-time repair.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;

-- Belt and braces: a function granted to PUBLIC is reachable by anon through
-- that grant regardless of the direct one.
DO $$
DECLARE
  v_fn regprocedure;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosecdef
       AND p.proacl IS NOT NULL
       AND array_to_string(p.proacl, ',') LIKE '%=X/%'
       AND EXISTS (
         SELECT 1 FROM aclexplode(p.proacl) a
          WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
       )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_fn);
  END LOOP;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
