-- commit_journal_entry: close the anon path that REVOKE ... FROM PUBLIC missed.
--
-- 20260808160000 added authorization to commit_journal_entry and revoked the
-- implicit PUBLIC execute grant behind it. That was verified against a plain
-- PostgreSQL, where anon holds no grant of its own and PUBLIC is the only way
-- in. On a Supabase database it is not the only way in: the platform image runs
--
--   alter default privileges in schema public
--     grant all on functions to postgres, anon, authenticated, service_role;
--
-- so every function created in `public` gets an EXPLICIT grant to anon at
-- creation time. REVOKE ... FROM PUBLIC does not touch an explicit grant, and
-- anon kept EXECUTE. CI caught it on the supabase/postgres image
-- (tests/pg/commit-journal-entry-authorization.pg.test.ts) — the local plain
-- PostgreSQL used during development could not have.
--
-- That mattered more than a stray grant usually would. The authorization block
-- reads:
--
--   IF auth.uid() IS NOT NULL AND NOT user_can_write_company(...) THEN RAISE
--
-- For anon, auth.uid() IS NULL — so the check was skipped entirely. An
-- unauthenticated caller holding only the public anon key could post any
-- company's draft voucher through PostgREST, and a posted entry is immutable by
-- law: the victim can only storno it, leaving both vouchers in their ledger
-- permanently.
--
-- Two changes, either of which would be sufficient, because this is not a place
-- to rely on one:
--
--   1. anon loses EXECUTE explicitly, so the function is unreachable.
--   2. the function refuses an anon caller outright, so a future re-grant (a
--      restore, a fresh database, an operator re-running the default-privileges
--      statement) does not silently reopen it.
--
-- The NULL-actor branch stays permitted for service_role and for internal
-- SECURITY DEFINER callers — that is how settlement, year-end and cron reach
-- this function, and they authorize before they get here.
--
-- The body below is the live definition read back with pg_get_functiondef and
-- diffed against the original: the anon guard is the only addition. Restating a
-- body from memory is how six earlier regressions were introduced in this
-- repository, so it was not done that way here.

CREATE OR REPLACE FUNCTION public.commit_journal_entry(p_company_id uuid, p_entry_id uuid, p_commit_method text DEFAULT NULL::text, p_rubric_version text DEFAULT NULL::text, p_actor_type text DEFAULT NULL::text, p_actor_label text DEFAULT NULL::text)
 RETURNS TABLE(voucher_number integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_next integer;
  v_fiscal_period_id uuid;
  v_series text;
  v_entry_user_id uuid;
BEGIN
  -- Authorization. An authenticated caller may only commit into a company they
  -- can write. A NULL actor means service_role or an internal SECURITY DEFINER
  -- caller that has already authorized, which is how every internal path
  -- reaches this function.
  --
  -- anon is checked first and separately: auth.uid() is NULL for anon, so the
  -- write check below skips for exactly the caller who should never get here.
  IF coalesce(auth.role(), '') = 'anon' THEN
    RAISE EXCEPTION 'Anonymous callers cannot commit journal entries.'
      USING ERRCODE = '42501', DETAIL = '{"code":"COMPANY_WRITE_FORBIDDEN"}';
  END IF;

  IF auth.uid() IS NOT NULL AND NOT public.user_can_write_company(p_company_id) THEN
    RAISE EXCEPTION 'Actor cannot commit journal entries for this company.'
      USING ERRCODE = '42501', DETAIL = '{"code":"COMPANY_WRITE_FORBIDDEN"}';
  END IF;

  -- Transaction-local actor context for write_audit_log (AFTER trigger on the
  -- UPDATE below runs in this same transaction). Empty string = unset; the
  -- trigger nullif()s it away.
  PERFORM set_config('nordklart.actor_type', coalesce(p_actor_type, ''), true);
  PERFORM set_config('nordklart.actor_label', coalesce(p_actor_label, ''), true);

  SELECT je.fiscal_period_id, COALESCE(je.voucher_series, 'A'), je.user_id
  INTO v_fiscal_period_id, v_series, v_entry_user_id
  FROM public.journal_entries je
  WHERE je.id = p_entry_id
    AND je.company_id = p_company_id
    AND je.status = 'draft'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft journal entry not found: %', p_entry_id;
  END IF;

  INSERT INTO public.voucher_sequences (company_id, user_id, fiscal_period_id, voucher_series, last_number)
  VALUES (p_company_id, COALESCE(auth.uid(), v_entry_user_id), v_fiscal_period_id, v_series, 1)
  ON CONFLICT (company_id, fiscal_period_id, voucher_series)
  DO UPDATE SET
    last_number = public.voucher_sequences.last_number + 1,
    updated_at = now()
  RETURNING last_number INTO v_next;

  UPDATE public.journal_entries
  SET voucher_number = v_next,
      status = 'posted',
      commit_method = p_commit_method,
      rubric_version = p_rubric_version,
      committed_actor_type = p_actor_type,
      committed_actor_label = p_actor_label
  WHERE id = p_entry_id
    AND company_id = p_company_id;

  RETURN QUERY SELECT v_next;
END;
$function$;

-- Explicit revoke: anon's grant on Supabase is its own, not the implicit PUBLIC
-- one, so REVOKE ... FROM PUBLIC alone leaves it in place. CREATE OR REPLACE
-- preserves the existing ACL, so this runs after the replace above.
REVOKE EXECUTE ON FUNCTION public.commit_journal_entry(uuid, uuid, text, text, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.commit_journal_entry(uuid, uuid, text, text, text, text)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
