WITH staged AS (
  INSERT INTO public.nordklart_deploy_staging (file, idx, body, expected_sha)
  VALUES ('20260821120000_storno_and_correction_are_atomic.sql', 1, $nk_stage_0$-- =============================================================================
-- Storno and rättelse create their vouchers inside one transaction (H-03 class)
--
-- reverseEntry() and correctEntry() were the last economically significant
-- write paths still assembled from separate PostgREST calls with hand-rolled
-- compensation:
--
--   reverseEntry:  next_voucher_number → INSERT header → INSERT lines
--                  → UPDATE status='posted' → CAS UPDATE original
--   correctEntry:  the same, twice, across two entries
--
-- Three defects follow from that shape, and none of them are theoretical:
--
--   1. The voucher number is allocated BEFORE the entry is known to be
--      writable. Every failure after that call burns a number, and BFL 5 kap.
--      7 § wants the series unbroken (a gap then needs a documented
--      explanation in voucher_gap_explanations).
--   2. `UPDATE status='posted'` bypasses commit_journal_entry entirely — the
--      function that carries the anon guard and the company write check added
--      in 20260808190000. The storno path posted vouchers without ever asking
--      whether the actor may write this company.
--   3. Process death between any two statements strands a posted storno with
--      the original still 'posted', or a storno with no correction behind it.
--      The compensating cancelEntry() is best effort by definition.
--
-- Same remedy as the settlement work: the line derivation stays in TypeScript
-- (a storno swaps debit/credit and negates amount_in_currency; a rättelse is
-- the caller's proposal), and this function persists a plan it is handed. It
-- never decides which accounts a storno hits.
--
-- Ordering inside the transaction is forced by enforce_journal_entry_immutability:
-- an original may only go posted → reversed once the storno is already posted
-- AND mutually linked (reversal.reverses_id = original.id). So: draft → link →
-- commit → flip the original. A failure anywhere rolls the whole thing back and
-- leaves no voucher, not even a cancelled one.
--
-- pg-test: covered-by lib/core/bookkeeping/__tests__/storno-atomicity.pg.test.ts
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. commit_method values this function writes.
--
-- Fourth time this list needs widening for a new writer, and the reason it is
-- caught up front rather than in production is commit-method-provenance: the
-- guard compares every commit_method literal a live function writes against
-- this CHECK. Restated in full because a CHECK cannot be extended in place;
-- every previously allowed value is carried forward unchanged.
-- -----------------------------------------------------------------------------
ALTER TABLE public.journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_commit_method_check;

ALTER TABLE public.journal_entries
  ADD CONSTRAINT journal_entries_commit_method_check
  CHECK (
    commit_method IS NULL
    OR commit_method = ANY (ARRAY[
      'user_accept',
      'bulk_accept',
      'timing_ceiling',
      'migration',
      'legacy',
      'agent',
      'api_key',
      'automation',
      'sie_import_reversal',
      'atomic_customer_settlement',
      'atomic_supplier_settlement',
      'system',
      'atomic_storno',
      'atomic_correction'
    ])
  );

-- -----------------------------------------------------------------------------
-- 2. reverse_journal_entry_v2
--
-- One call covers both flows:
--   * storno only            — p_correction_journal IS NULL
--   * storno + rättelse      — p_correction_journal supplied
--
-- Returns {"reversal_entry_id": uuid, "correction_entry_id": uuid|null}.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reverse_journal_entry_v2(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_entry_id uuid,
  p_reversal_journal jsonb,
  p_reversal_date date,
  p_correction_journal jsonb DEFAULT NULL,
  p_correction_date date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_access record;
  v_original public.journal_entries%ROWTYPE;
  v_reversal public.journal_entries%ROWTYPE;
  v_correction public.journal_entries%ROWTYPE;
  v_correction_id uuid := NULL;
  v_updated uuid;
BEGIN
  PERFORM public.require_service_role();

  IF p_actor_user_id IS NULL OR p_entry_id IS NULL OR p_company_id IS NULL THEN
    RAISE EXCEPTION 'Invalid storno input.'
      USING ERRCODE = '22023', DETAIL = '{"code":"VALIDATION_ERROR"}';
  END IF;

  -- The server call still verifies the named actor, exactly as the settlement
  -- RPCs do. require_service_role() only proves the *connection* is trusted; it
  -- says nothing about whether this user may write this company.
  SELECT * INTO v_access FROM public.resolve_company_access_for_user(p_actor_user_id, p_company_id);
  IF NOT FOUND OR NOT coalesce(v_access.can_write, false) THEN
    RAISE EXCEPTION 'Actor cannot write this company.'
      USING ERRCODE = '42501', DETAIL = '{"code":"COMPANY_WRITE_FORBIDDEN"}';
  END IF;

  -- Serialise concurrent reversals of the same entry. The CAS at the end is
  -- still the authority; this only stops two callers from each building a full
  -- storno before one of them loses.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_company_id::text || ':journal_entry_reversal:' || p_entry_id::text, 0));

  SELECT * INTO v_original FROM public.journal_entries
  WHERE id = p_entry_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Journal entry not found.'
      USING ERRCODE = 'P0002', DETAIL = '{"code":"JOURNAL_ENTRY_NOT_FOUND"}';
  END IF;

  IF v_original.status = 'reversed' THEN
    RAISE EXCEPTION 'Journal entry is already reversed.'
      USING ERRCODE = 'P0001', DETAIL = '{"code":"ENTRY_ALREADY_REVERSED"}';
  END IF;

  IF v_original.status <> 'posted' THEN
    RAISE EXCEPTION 'Only a posted journal entry can be reversed (status: %).', v_original.status
      USING ERRCODE = 'P0001', DETAIL = '{"code":"CANNOT_REVERSE_NON_POSTED"}';
  END IF;

  -- Storno. Period lock, chart membership and balance are all enforced inside
  -- create_planned_draft_entry, in this transaction, before anything exists.
  v_reversal := public.create_planned_draft_entry(
    p_company_id,
    p_actor_user_id,
    p_reversal_journal,
    ARRAY['storno'],
    p_reversal_date,
    nullif(p_reversal_journal->>'source_id', '')::uuid,
    'STORNO_BOOK_FAILED'
  );

  -- The mutual link must exist before the storno is posted: the immutability
  -- trigger refuses posted → reversed unless reversal.reverses_id already
  -- points back at the original.
  UPDATE public.journal_entries
     SET reverses_id = p_entry_id
   WHERE id = v_reversal.id;

  PERFORM public.commit_journal_entry(
    p_company_id, v_reversal.id, 'atomic_storno', NULL, 'user', NULL);

  IF p_correction_journal IS NOT NULL THEN
    IF p_correction_date IS NULL THEN
      RAISE EXCEPTION 'A correction plan requires a correction date.'
        USING ERRCODE = '22023', DETAIL = '{"code":"VALIDATION_ERROR"}';
    END IF;

    v_correction := public.create_planned_draft_entry(
      p_company_id,
      p_actor_user_id,
      p_correction_journal,
      ARRAY['correction'],
      p_correction_date,
      nullif(p_correction_journal->>'source_id', '')::uuid,
      'CORRECTION_BOOK_FAILED'
    );

    UPDATE public.journal_entries
       SET correction_of_id = p_entry_id
     WHERE id = v_correction.id;

    PERFORM public.commit_journal_entry(
      p_company_id, v_correction.id, 'atomic_correction', NULL, 'user', NULL);

    v_correction_id := v_correction.id;
  END IF;

  -- CAS on the original. The row is already locked FOR UPDATE above, so this
  -- cannot lose a race inside this transaction; the predicate stays as a
  -- belt-and-braces assertion that nothing else moved it.
  UPDATE public.journal_entries
     SET status = 'reversed',
         reversed_by_id = v_reversal.id
   WHERE id = p_entry_id
     AND company_id = p_company_id
     AND status = 'posted'
  RETURNING id INTO v_updated;

  IF v_updated IS NULL THEN
    RAISE EXCEPTION 'Journal entry is already reversed.'
      USING ERRCODE = 'P0001', DETAIL = '{"code":"ENTRY_ALREADY_REVERSED"}';
  END IF;

  RETURN jsonb_build_object(
    'reversal_entry_id', v_reversal.id,
    'correction_entry_id', v_correction_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reverse_journal_entry_v2(uuid,uuid,uuid,jsonb,date,jsonb,date)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reverse_journal_entry_v2(uuid,uuid,uuid,jsonb,date,jsonb,date)
  TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
$nk_stage_0$, '2a4a143555e6da7f78baa8ae7a4a0e88a11b817b08cee37fdcb77daaa376772c')
  ON CONFLICT (file, idx) DO UPDATE
    SET body = EXCLUDED.body, expected_sha = EXCLUDED.expected_sha, staged_at = now()
  RETURNING idx, body, expected_sha
)
SELECT idx,
       encode(sha256(convert_to(body, 'UTF8')), 'hex') = expected_sha AS ok,
       octet_length(body) AS bytes
FROM staged;
