-- commit_journal_entry must authorize its caller.
--
-- The function is SECURITY DEFINER and EXECUTE is granted to `anon` and
-- `authenticated` (the Supabase default for functions in `public`). It used
-- auth.uid() in exactly one place — as an attribution fallback when writing
-- voucher_sequences.user_id — and nowhere as an authorization check.
--
-- Demonstrated on a replayed database: an authenticated user who is a member of
-- company A, given company B's id and the id of a draft entry in B, calls
--
--     SELECT public.commit_journal_entry(B_company_id, B_draft_entry_id);
--
-- and B's voucher is POSTED, with a voucher number from B's sequence. Posted
-- entries are immutable by law (BFL 7 kap; enforced here by
-- enforce_journal_entry_immutability), so the victim cannot edit or delete it —
-- only reverse it with a storno, which leaves both vouchers in their ledger
-- permanently. An attacker can corrupt another company's books irreversibly.
--
-- The same call as `anon` also reached the voucher-number assignment. It failed
-- one statement later only because a non-definer balance trigger lacks SELECT on
-- journal_entry_lines for that role. That is an accident of table grants, not a
-- control, and it would disappear the moment those grants changed.
--
-- The check mirrors __year_end_assert_actor: when there IS an authenticated
-- actor they must be able to write the company; when there is none the caller is
-- service_role or an internal SECURITY DEFINER function that has already
-- authorized, and is allowed through. Every internal caller was checked against
-- this rule before the change:
--
--   settle_customer_invoice_v2 / settle_supplier_invoice_v2  service_role, no auth.uid()
--   match_batch_allocate                                     authenticated member (checks membership itself)
--   bulk_book_transactions                                   authenticated member
--   __sie_reverse_import_entries                             runs under the importing member
--   __year_end_prior_result_transfer                         runs under the closing actor, who must already have write access
--
-- The rest of the body is reproduced verbatim from the definition this replaces
-- (20260619120000_journal_entry_committed_actor.sql). The ONLY change is the
-- added authorization block. This function is on the critical-redefinition
-- register, so the count change is acknowledged deliberately.
--
-- pg-test: covered-by tests/pg/commit-journal-entry-authorization.pg.test.ts

BEGIN;

CREATE OR REPLACE FUNCTION public.commit_journal_entry(
  p_company_id uuid,
  p_entry_id uuid,
  p_commit_method text DEFAULT NULL::text,
  p_rubric_version text DEFAULT NULL::text,
  p_actor_type text DEFAULT NULL::text,
  p_actor_label text DEFAULT NULL::text
)
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

-- `anon` has no legitimate reason to post bookkeeping. Revoking is defence in
-- depth behind the check above, not a substitute for it.
--
-- The grant anon holds is the implicit PUBLIC one PostgreSQL gives every new
-- function, not a named grant — the ACL reads `{=X/postgres, postgres=X/postgres,
-- authenticated=X/postgres, service_role=X/postgres}`, where the leading `=X`
-- is PUBLIC. REVOKE ... FROM anon is therefore a no-op, and the explicit grants
-- to authenticated and service_role have to be restated after revoking PUBLIC
-- or the application loses access.
REVOKE EXECUTE ON FUNCTION public.commit_journal_entry(uuid, uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.commit_journal_entry(uuid, uuid, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commit_journal_entry(uuid, uuid, text, text, text, text) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
