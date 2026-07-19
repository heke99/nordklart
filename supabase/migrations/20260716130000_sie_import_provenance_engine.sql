-- SIE import through the central posting engine, with exact provenance
-- (revision items I01–I12, I17, I24).
--
--   * journal_entries.sie_import_id + external_reference — every imported
--     verification knows exactly which import run created it (I04, I10).
--   * Deferred INSERT-time balance guard — a journal entry inserted directly
--     as 'posted' without balanced lines is now impossible at the database
--     level, closing the bypass the old SIE importer used (I01–I03).
--   * sie_import_staging — vouchers are staged (resumable, idempotent) and
--     posted by ONE atomic RPC (I05, I06).
--   * finalize_sie_import() — single-transaction posting incl. precise
--     replace of a prior import, opening balance handling and N→N+1 IB
--     resync with exact continuity (I06, I07, I11, I12).
--   * undo_sie_import v3 — only ever touches rows belonging to the chosen
--     import (I09); replace_sie_import is superseded by finalize_sie_import
--     and hardened for legacy callers (I08).
--
-- pg-test: covered-by lib/import/__tests__/sie-import-engine.pg.test.ts

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Provenance columns (I04, I10)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.journal_entries
  ADD COLUMN IF NOT EXISTS sie_import_id uuid REFERENCES public.sie_imports(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS external_reference text;

COMMENT ON COLUMN public.journal_entries.sie_import_id IS
  'Exact provenance: the SIE import run that created this entry. NULL for entries created before this column existed or from other sources.';
COMMENT ON COLUMN public.journal_entries.external_reference IS
  'Stable external verification key (e.g. SIE series:number:date) used for import idempotency.';

CREATE INDEX IF NOT EXISTS idx_journal_entries_sie_import
  ON public.journal_entries (sie_import_id) WHERE sie_import_id IS NOT NULL;

-- One row per (import, external verification) — retries can never duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_sie_import_external_ref
  ON public.journal_entries (sie_import_id, external_reference)
  WHERE sie_import_id IS NOT NULL AND external_reference IS NOT NULL;

-- Deterministic backfill: tag entries for legacy completed imports where the
-- (period, source_type='import') scope is unambiguous — exactly one completed
-- import in that period. Ambiguous periods stay NULL (no silent guessing).
UPDATE public.journal_entries je
SET sie_import_id = s.import_id
FROM (
  SELECT si.fiscal_period_id, si.company_id, min(si.id::text)::uuid AS import_id
  FROM public.sie_imports si
  WHERE si.status = 'completed' AND si.fiscal_period_id IS NOT NULL
  GROUP BY si.fiscal_period_id, si.company_id
  HAVING count(*) = 1
) s
WHERE je.company_id = s.company_id
  AND je.fiscal_period_id = s.fiscal_period_id
  AND je.source_type = 'import'
  AND je.sie_import_id IS NULL;

-- Tag opening balance entries linked from the import row itself.
UPDATE public.journal_entries je
SET sie_import_id = si.id
FROM public.sie_imports si
WHERE si.opening_balance_entry_id = je.id
  AND si.status = 'completed'
  AND je.sie_import_id IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. DB guard: INSERT of already-'posted' entries must balance at commit
--    (I03). The existing check_balance_on_post only covered draft→posted
--    UPDATEs; direct inserts (the old SIE path) bypassed it entirely.
-- ─────────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS check_balance_on_posted_insert ON public.journal_entries;
CREATE CONSTRAINT TRIGGER check_balance_on_posted_insert
  AFTER INSERT ON public.journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.status = 'posted')
  EXECUTE FUNCTION public.check_journal_entry_balance();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. sie_imports state machine + progress counters (I05, I11, I17, I18, I19)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.sie_imports
  DROP CONSTRAINT IF EXISTS sie_imports_status_check;
ALTER TABLE public.sie_imports
  ADD CONSTRAINT sie_imports_status_check CHECK (status IN (
    'pending', 'validating', 'staged', 'importing', 'partial',
    'mapped', 'completed', 'failed', 'replaced', 'undone'
  ));

ALTER TABLE public.sie_imports
  ADD COLUMN IF NOT EXISTS total_vouchers integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS posted_vouchers integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS skipped_duplicate_vouchers integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed_vouchers integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_checkpoint jsonb,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archive_error text,
  ADD COLUMN IF NOT EXISTS ksumma_declared text,
  ADD COLUMN IF NOT EXISTS ksumma_verified boolean,
  ADD COLUMN IF NOT EXISTS warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS replaces_import_id uuid REFERENCES public.sie_imports(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.sie_imports.warnings IS
  'Final warning list — persisted and API responses must agree (I24).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Staging table — vouchers are written here in resumable batches, then
--    posted atomically by finalize_sie_import (I05, I06).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sie_import_staging (
  import_id   uuid NOT NULL REFERENCES public.sie_imports(id) ON DELETE CASCADE,
  company_id  uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  row_index   integer NOT NULL,
  voucher     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (import_id, row_index)
);

CREATE INDEX IF NOT EXISTS idx_sie_import_staging_company
  ON public.sie_import_staging (company_id);

ALTER TABLE public.sie_import_staging ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sie_import_staging_select ON public.sie_import_staging;
CREATE POLICY sie_import_staging_select ON public.sie_import_staging
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
DROP POLICY IF EXISTS sie_import_staging_insert ON public.sie_import_staging;
CREATE POLICY sie_import_staging_insert ON public.sie_import_staging
  FOR INSERT WITH CHECK (public.user_can_write_company(company_id));
DROP POLICY IF EXISTS sie_import_staging_update ON public.sie_import_staging;
CREATE POLICY sie_import_staging_update ON public.sie_import_staging
  FOR UPDATE USING (public.user_can_write_company(company_id))
  WITH CHECK (public.user_can_write_company(company_id));
DROP POLICY IF EXISTS sie_import_staging_delete ON public.sie_import_staging;
CREATE POLICY sie_import_staging_delete ON public.sie_import_staging
  FOR DELETE USING (public.user_can_write_company(company_id));

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Internal: post one SIE voucher with the same validation as
--    commit_journal_entry (balance, non-negative amounts, sequential voucher
--    number). Never exposed to clients.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.__sie_post_voucher(
  p_company_id uuid,
  p_user_id uuid,
  p_import_id uuid,
  p_fiscal_period_id uuid,
  p_voucher jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_entry_id uuid;
  v_line jsonb;
  v_total_debit numeric := 0;
  v_total_credit numeric := 0;
  v_next integer;
  v_series text := COALESCE(p_voucher->>'voucher_series', 'A');
  v_entry_date date := (p_voucher->>'entry_date')::date;
  v_period record;
BEGIN
  SELECT period_start, period_end INTO v_period
  FROM public.fiscal_periods
  WHERE id = p_fiscal_period_id AND company_id = p_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SIE_PERIOD_NOT_FOUND';
  END IF;
  IF v_entry_date < v_period.period_start OR v_entry_date > v_period.period_end THEN
    RAISE EXCEPTION 'SIE_DATE_OUTSIDE_PERIOD: % not in [%, %]',
      v_entry_date, v_period.period_start, v_period.period_end;
  END IF;

  IF p_voucher->'lines' IS NULL OR jsonb_array_length(p_voucher->'lines') = 0 THEN
    RAISE EXCEPTION 'SIE_EMPTY_VOUCHER: verification without transaction lines';
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_voucher->'lines') LOOP
    IF COALESCE(v_line->>'account_number', '') = '' THEN
      RAISE EXCEPTION 'SIE_INVALID_LINE: missing account number';
    END IF;
    IF COALESCE((v_line->>'debit_amount')::numeric, 0) < 0
       OR COALESCE((v_line->>'credit_amount')::numeric, 0) < 0 THEN
      RAISE EXCEPTION 'SIE_INVALID_LINE: negative amount on account %', v_line->>'account_number';
    END IF;
    v_total_debit  := v_total_debit  + COALESCE((v_line->>'debit_amount')::numeric, 0);
    v_total_credit := v_total_credit + COALESCE((v_line->>'credit_amount')::numeric, 0);
  END LOOP;

  IF round(v_total_debit, 2) <> round(v_total_credit, 2) THEN
    RAISE EXCEPTION 'SIE_UNBALANCED: debit=% credit=%', v_total_debit, v_total_credit;
  END IF;
  IF round(v_total_debit, 2) = 0 THEN
    RAISE EXCEPTION 'SIE_ZERO_VOUCHER: verification has zero total';
  END IF;

  INSERT INTO public.journal_entries
    (company_id, user_id, fiscal_period_id, voucher_number, voucher_series,
     entry_date, description, source_type, status, created_via,
     commit_method, sie_import_id, external_reference,
     source_voucher_series, source_voucher_number)
  VALUES
    (p_company_id, p_user_id, p_fiscal_period_id, 0, v_series,
     v_entry_date,
     COALESCE(NULLIF(p_voucher->>'description', ''), 'Importerad verifikation'),
     COALESCE(NULLIF(p_voucher->>'source_type', ''), 'import'),
     'draft', 'imported', 'migration',
     p_import_id,
     p_voucher->>'external_reference',
     NULLIF(p_voucher->>'source_voucher_series', ''),
     NULLIF(p_voucher->>'source_voucher_number', '')::integer)
  RETURNING id INTO v_entry_id;

  INSERT INTO public.journal_entry_lines
    (journal_entry_id, account_number, debit_amount, credit_amount,
     line_description, cost_center, project, dimensions, sort_order)
  SELECT
    v_entry_id,
    l.value->>'account_number',
    round(COALESCE((l.value->>'debit_amount')::numeric, 0), 2),
    round(COALESCE((l.value->>'credit_amount')::numeric, 0), 2),
    l.value->>'line_description',
    NULLIF(l.value->>'cost_center', ''),
    NULLIF(l.value->>'project', ''),
    CASE WHEN l.value ? 'dimensions' THEN l.value->'dimensions' ELSE NULL END,
    (l.ordinality - 1)::integer
  FROM jsonb_array_elements(p_voucher->'lines') WITH ORDINALITY l;

  INSERT INTO public.voucher_sequences (company_id, user_id, fiscal_period_id, voucher_series, last_number)
  VALUES (p_company_id, p_user_id, p_fiscal_period_id, v_series, 1)
  ON CONFLICT (company_id, fiscal_period_id, voucher_series)
  DO UPDATE SET
    last_number = public.voucher_sequences.last_number + 1,
    updated_at = now()
  RETURNING last_number INTO v_next;

  UPDATE public.journal_entries
  SET voucher_number = v_next, status = 'posted'
  WHERE id = v_entry_id AND company_id = p_company_id;

  RETURN v_entry_id;
END;
$$;

REVOKE ALL ON FUNCTION public.__sie_post_voucher(uuid, uuid, uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.__sie_post_voucher(uuid, uuid, uuid, uuid, jsonb) FROM anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Internal: precisely delete one import's journal entries (I07, I09).
--    Detaches documents, clears OB pointers that belong to THIS import,
--    hard-deletes only rows tagged with the import id, and resets voucher
--    sequences to the max remaining number. Guarded legacy fallback: imports
--    that predate provenance may be deleted by (period, source_type) scope,
--    but only when no other completed import shares the period.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.__sie_delete_import_entries(
  p_company_id uuid,
  p_import_id uuid
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_import record;
  v_deleted integer := 0;
  v_tagged integer;
  v_other_imports integer;
BEGIN
  SELECT * INTO v_import FROM public.sie_imports
  WHERE id = p_import_id AND company_id = p_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SIE_IMPORT_NOT_FOUND';
  END IF;

  PERFORM set_config('nordklart.allow_delete', 'true', true);

  SELECT count(*)::integer INTO v_tagged
  FROM public.journal_entries
  WHERE company_id = p_company_id AND sie_import_id = p_import_id;

  IF v_tagged > 0 THEN
    -- Precise path: only rows tagged with this import id.
    UPDATE public.document_attachments
       SET journal_entry_id = NULL, journal_entry_line_id = NULL
     WHERE journal_entry_id IN (
             SELECT id FROM public.journal_entries
             WHERE company_id = p_company_id AND sie_import_id = p_import_id)
        OR journal_entry_line_id IN (
             SELECT jel.id FROM public.journal_entry_lines jel
             JOIN public.journal_entries je ON je.id = jel.journal_entry_id
             WHERE je.company_id = p_company_id AND je.sie_import_id = p_import_id);

    -- Clear period OB pointer only if it points at THIS import's OB entry.
    UPDATE public.fiscal_periods fp
       SET opening_balances_set = false
     WHERE fp.company_id = p_company_id
       AND fp.opening_balance_entry_id IN (
             SELECT id FROM public.journal_entries
             WHERE company_id = p_company_id AND sie_import_id = p_import_id);
    UPDATE public.fiscal_periods fp
       SET opening_balance_entry_id = NULL
     WHERE fp.company_id = p_company_id
       AND fp.opening_balance_entry_id IN (
             SELECT id FROM public.journal_entries
             WHERE company_id = p_company_id AND sie_import_id = p_import_id);

    UPDATE public.sie_imports
       SET opening_balance_entry_id = NULL
     WHERE id = p_import_id;

    WITH deleted AS (
      DELETE FROM public.journal_entries
       WHERE company_id = p_company_id
         AND sie_import_id = p_import_id
      RETURNING id, fiscal_period_id
    )
    SELECT count(*) INTO v_deleted FROM deleted;
  ELSIF v_import.fiscal_period_id IS NOT NULL THEN
    -- Legacy fallback (pre-provenance imports). Refuse when another completed
    -- import shares the period — a broad delete would destroy its data.
    SELECT count(*)::integer INTO v_other_imports
    FROM public.sie_imports si
    WHERE si.company_id = p_company_id
      AND si.fiscal_period_id = v_import.fiscal_period_id
      AND si.id <> p_import_id
      AND si.status = 'completed';
    IF v_other_imports > 0 THEN
      RAISE EXCEPTION 'SIE_AMBIGUOUS_LEGACY_SCOPE: % other completed import(s) share the period; cannot safely delete untagged entries', v_other_imports;
    END IF;

    UPDATE public.document_attachments
       SET journal_entry_id = NULL, journal_entry_line_id = NULL
     WHERE journal_entry_id IN (
             SELECT id FROM public.journal_entries
             WHERE company_id = p_company_id
               AND fiscal_period_id = v_import.fiscal_period_id
               AND source_type IN ('import', 'opening_balance')
               AND status IN ('posted', 'cancelled'))
        OR journal_entry_line_id IN (
             SELECT jel.id FROM public.journal_entry_lines jel
             JOIN public.journal_entries je ON je.id = jel.journal_entry_id
             WHERE je.company_id = p_company_id
               AND je.fiscal_period_id = v_import.fiscal_period_id
               AND je.source_type IN ('import', 'opening_balance')
               AND je.status IN ('posted', 'cancelled'));

    IF v_import.opening_balance_entry_id IS NOT NULL THEN
      UPDATE public.fiscal_periods
         SET opening_balances_set = false
       WHERE id = v_import.fiscal_period_id
         AND opening_balance_entry_id = v_import.opening_balance_entry_id;
      UPDATE public.fiscal_periods
         SET opening_balance_entry_id = NULL
       WHERE id = v_import.fiscal_period_id
         AND opening_balance_entry_id = v_import.opening_balance_entry_id;
    END IF;

    UPDATE public.sie_imports
       SET opening_balance_entry_id = NULL
     WHERE id = p_import_id;

    WITH deleted AS (
      DELETE FROM public.journal_entries je
       WHERE je.company_id = p_company_id
         AND je.fiscal_period_id = v_import.fiscal_period_id
         AND je.status IN ('posted', 'cancelled')
         AND (
           je.source_type = 'import'
           OR (je.source_type = 'opening_balance'
               AND je.id = v_import.opening_balance_entry_id)
         )
      RETURNING id
    )
    SELECT count(*) INTO v_deleted FROM deleted;
  END IF;

  -- Reset voucher sequences to the max remaining number per series.
  UPDATE public.voucher_sequences vs
     SET last_number = COALESCE((
           SELECT MAX(je.voucher_number)
             FROM public.journal_entries je
            WHERE je.company_id       = vs.company_id
              AND je.fiscal_period_id = vs.fiscal_period_id
              AND je.voucher_series   = vs.voucher_series
              AND je.voucher_number  > 0
         ), 0),
         updated_at = now()
   WHERE vs.company_id = p_company_id
     AND vs.fiscal_period_id IN (
       SELECT DISTINCT fp.id FROM public.fiscal_periods fp
       WHERE fp.company_id = p_company_id
         AND (fp.id = v_import.fiscal_period_id
              OR fp.id IN (SELECT DISTINCT fiscal_period_id FROM public.journal_entries
                           WHERE company_id = p_company_id AND sie_import_id = p_import_id))
     );

  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.__sie_delete_import_entries(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.__sie_delete_import_entries(uuid, uuid) FROM anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. finalize_sie_import — post all staged vouchers in ONE transaction
--    (I01–I06, I11, I12). On any failure the transaction rolls back and, for
--    replace, the old import remains untouched.
--
--    p_options:
--      replaces_import_id      uuid   — atomic replace of a prior import
--      skip_duplicates         bool   — true: skip + report; false: fail
--      opening_balance         jsonb  — { entry_date, description, lines }
--      next_period_ob          jsonb  — { lines } for year N+1 IB resync
--      create_next_period      bool   — create N+1 if missing
--      expected_voucher_count  int    — staging completeness check
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.finalize_sie_import(
  p_company_id uuid,
  p_import_id uuid,
  p_user_id uuid,
  p_options jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text := COALESCE(auth.role(), current_user::text);
  v_import record;
  v_old_import record;
  v_replaces uuid := NULLIF(p_options->>'replaces_import_id', '')::uuid;
  v_skip_duplicates boolean := COALESCE((p_options->>'skip_duplicates')::boolean, true);
  v_expected integer := NULLIF(p_options->>'expected_voucher_count', '')::integer;
  v_staged integer;
  v_row record;
  v_posted integer := 0;
  v_skipped integer := 0;
  v_failed jsonb := '[]'::jsonb;
  v_deleted integer := 0;
  v_ob jsonb := p_options->'opening_balance';
  v_ob_entry_id uuid;
  v_next_ob jsonb := p_options->'next_period_ob';
  v_period record;
  v_next_period record;
  v_next_ob_entry_id uuid;
  v_diff record;
  v_ext_ref text;
BEGIN
  -- Authorization: authenticated callers need write capability + membership;
  -- service_role callers must pass attribution.
  IF v_uid IS NOT NULL THEN
    IF NOT public.user_can_write_company(p_company_id) THEN
      RAISE EXCEPTION 'FORBIDDEN: no write access to company' USING ERRCODE = '42501';
    END IF;
    p_user_id := v_uid;
  ELSIF v_role NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'FORBIDDEN: unauthenticated caller' USING ERRCODE = '42501';
  ELSIF p_user_id IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: service caller must supply p_user_id' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_company_id::text || ':sie_import'));

  SELECT * INTO v_import FROM public.sie_imports
  WHERE id = p_import_id AND company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SIE_IMPORT_NOT_FOUND';
  END IF;
  IF v_import.status NOT IN ('pending', 'validating', 'staged', 'importing', 'partial') THEN
    RAISE EXCEPTION 'SIE_IMPORT_WRONG_STATUS: cannot finalize import in status %', v_import.status;
  END IF;
  IF v_import.fiscal_period_id IS NULL THEN
    RAISE EXCEPTION 'SIE_IMPORT_NO_PERIOD: import has no fiscal period';
  END IF;

  SELECT * INTO v_period FROM public.fiscal_periods
  WHERE id = v_import.fiscal_period_id AND company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SIE_PERIOD_NOT_FOUND';
  END IF;
  IF v_period.is_closed OR v_period.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'SIE_PERIOD_LOCKED: cannot import into a locked or closed period';
  END IF;

  SELECT count(*)::integer INTO v_staged
  FROM public.sie_import_staging
  WHERE import_id = p_import_id AND company_id = p_company_id;
  IF v_expected IS NOT NULL AND v_staged <> v_expected THEN
    RAISE EXCEPTION 'SIE_STAGING_INCOMPLETE: staged=% expected=%', v_staged, v_expected;
  END IF;

  -- Atomic replace: the old import is deleted INSIDE this transaction, after
  -- which the new vouchers are posted. Any failure rolls everything back and
  -- the old import remains untouched (I06).
  IF v_replaces IS NOT NULL THEN
    SELECT * INTO v_old_import FROM public.sie_imports
    WHERE id = v_replaces AND company_id = p_company_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SIE_REPLACE_TARGET_NOT_FOUND';
    END IF;
    IF v_old_import.status <> 'completed' THEN
      RAISE EXCEPTION 'SIE_REPLACE_TARGET_WRONG_STATUS: % is %', v_replaces, v_old_import.status;
    END IF;

    v_deleted := public.__sie_delete_import_entries(p_company_id, v_replaces);

    UPDATE public.sie_imports
       SET status = 'replaced', replaced_at = now()
     WHERE id = v_replaces AND company_id = p_company_id;
  END IF;

  UPDATE public.sie_imports SET status = 'importing', updated_at = now()
  WHERE id = p_import_id;

  -- Post every staged voucher through the shared engine-equivalent routine.
  FOR v_row IN
    SELECT row_index, voucher FROM public.sie_import_staging
    WHERE import_id = p_import_id AND company_id = p_company_id
    ORDER BY row_index
  LOOP
    v_ext_ref := v_row.voucher->>'external_reference';

    IF v_ext_ref IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.journal_entries
      WHERE sie_import_id = p_import_id AND external_reference = v_ext_ref
    ) THEN
      IF v_skip_duplicates THEN
        v_skipped := v_skipped + 1;
        CONTINUE;
      ELSE
        RAISE EXCEPTION 'SIE_DUPLICATE_VOUCHER: % already posted for this import', v_ext_ref;
      END IF;
    END IF;

    -- No per-voucher swallow: a validation failure aborts the whole
    -- finalize so the import never ends half-posted (I01/I11). Detailed
    -- per-voucher validation errors were already surfaced at staging time.
    PERFORM public.__sie_post_voucher(
      p_company_id, p_user_id, p_import_id, v_import.fiscal_period_id, v_row.voucher);
    v_posted := v_posted + 1;
  END LOOP;

  -- Opening balance for the imported period.
  IF v_ob IS NOT NULL AND jsonb_array_length(COALESCE(v_ob->'lines', '[]'::jsonb)) > 0 THEN
    IF EXISTS (
      SELECT 1 FROM public.journal_entries
      WHERE company_id = p_company_id
        AND fiscal_period_id = v_import.fiscal_period_id
        AND source_type = 'opening_balance'
        AND status = 'posted'
    ) THEN
      RAISE EXCEPTION 'SIE_OB_CONFLICT: period already has a posted opening balance from another source';
    END IF;

    v_ob_entry_id := public.__sie_post_voucher(
      p_company_id, p_user_id, p_import_id, v_import.fiscal_period_id,
      jsonb_build_object(
        'entry_date', COALESCE(v_ob->>'entry_date', v_period.period_start::text),
        'description', COALESCE(v_ob->>'description', 'Ingående balanser från SIE-import'),
        'source_type', 'opening_balance',
        'voucher_series', 'A',
        'external_reference', 'opening_balance',
        'lines', v_ob->'lines'));

    UPDATE public.fiscal_periods
       SET opening_balance_entry_id = v_ob_entry_id,
           opening_balances_set = true
     WHERE id = v_import.fiscal_period_id AND company_id = p_company_id;

    UPDATE public.sie_imports
       SET opening_balance_entry_id = v_ob_entry_id
     WHERE id = p_import_id;
  END IF;

  -- N → N+1 opening balance resync (I12): rebuild the next period's IB from
  -- the imported UB, with exact continuity enforced.
  IF v_next_ob IS NOT NULL AND jsonb_array_length(COALESCE(v_next_ob->'lines', '[]'::jsonb)) > 0 THEN
    SELECT * INTO v_next_period FROM public.fiscal_periods
    WHERE company_id = p_company_id
      AND period_start > v_period.period_end
    ORDER BY period_start ASC
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
      IF COALESCE((p_options->>'create_next_period')::boolean, false) THEN
        INSERT INTO public.fiscal_periods
          (company_id, user_id, name, period_start, period_end, previous_period_id)
        VALUES
          (p_company_id, p_user_id,
           to_char(v_period.period_end + 1, 'YYYY') ||
             CASE WHEN extract(month FROM v_period.period_end + 1) = 1
                  THEN '' ELSE '/' || to_char(v_period.period_end + interval '1 year', 'YYYY') END,
           v_period.period_end + 1,
           ((v_period.period_end + 1) + interval '1 year' - interval '1 day')::date,
           v_import.fiscal_period_id)
        RETURNING * INTO v_next_period;
      END IF;
    END IF;

    IF v_next_period.id IS NOT NULL THEN
      IF v_next_period.is_closed OR v_next_period.locked_at IS NOT NULL THEN
        RAISE EXCEPTION 'SIE_NEXT_PERIOD_LOCKED: next period is locked/closed — cannot resync opening balance';
      END IF;

      -- An existing IB is only replaceable when it came from THIS import
      -- chain (the replaced import). Anything else is a conflict (I12).
      IF v_next_period.opening_balance_entry_id IS NOT NULL THEN
        IF EXISTS (
          SELECT 1 FROM public.journal_entries
          WHERE id = v_next_period.opening_balance_entry_id
            AND (sie_import_id = v_replaces OR sie_import_id = p_import_id)
        ) THEN
          -- Replaced-import IB was already deleted by __sie_delete_import_entries;
          -- if the pointer survived (legacy), clear it now in two steps.
          UPDATE public.fiscal_periods SET opening_balances_set = false
          WHERE id = v_next_period.id;
          UPDATE public.fiscal_periods SET opening_balance_entry_id = NULL
          WHERE id = v_next_period.id;
        ELSE
          RAISE EXCEPTION 'SIE_NEXT_OB_CONFLICT: next period has an opening balance from another source — resolve manually';
        END IF;
      END IF;

      v_next_ob_entry_id := public.__sie_post_voucher(
        p_company_id, p_user_id, p_import_id, v_next_period.id,
        jsonb_build_object(
          'entry_date', v_next_period.period_start::text,
          'description', 'Ingående balans ' || v_next_period.name || ' (från SIE-import)',
          'source_type', 'opening_balance',
          'voucher_series', 'A',
          'external_reference', 'next_period_opening_balance',
          'lines', v_next_ob->'lines'));

      UPDATE public.fiscal_periods
         SET opening_balance_entry_id = v_next_ob_entry_id,
             opening_balances_set = true,
             previous_period_id = v_import.fiscal_period_id,
             continuity_verified = NULL
       WHERE id = v_next_period.id AND company_id = p_company_id;

      -- Exact continuity: imported UB (classes 1–2, all posted entries of
      -- period N) must equal the new IB to the öre.
      FOR v_diff IN
        WITH ub AS (
          SELECT l.account_number, round(sum(l.debit_amount - l.credit_amount), 2) AS net
          FROM public.journal_entry_lines l
          JOIN public.journal_entries e ON e.id = l.journal_entry_id
          WHERE e.company_id = p_company_id
            AND e.fiscal_period_id = v_import.fiscal_period_id
            AND e.status IN ('posted', 'reversed')
            AND substring(l.account_number, 1, 1) IN ('1', '2')
          GROUP BY l.account_number
          HAVING abs(round(sum(l.debit_amount - l.credit_amount), 2)) >= 0.005
        ),
        ib AS (
          SELECT l.account_number, round(sum(l.debit_amount - l.credit_amount), 2) AS net
          FROM public.journal_entry_lines l
          WHERE l.journal_entry_id = v_next_ob_entry_id
          GROUP BY l.account_number
        )
        SELECT COALESCE(ub.account_number, ib.account_number) AS account_number,
               COALESCE(ub.net, 0) AS ub_net, COALESCE(ib.net, 0) AS ib_net
        FROM ub FULL OUTER JOIN ib ON ib.account_number = ub.account_number
        WHERE abs(COALESCE(ub.net, 0) - COALESCE(ib.net, 0)) > 0.005
      LOOP
        RAISE EXCEPTION 'SIE_CONTINUITY: account % UB=% IB=% — aborting import',
          v_diff.account_number, v_diff.ub_net, v_diff.ib_net;
      END LOOP;

      UPDATE public.fiscal_periods
         SET continuity_verified = true
       WHERE id = v_next_period.id AND company_id = p_company_id;
    END IF;
  END IF;

  -- Clear staging and finalize counters. Status stays 'importing' — the API
  -- layer flips to completed/failed AFTER archiving the original file (I18)
  -- via complete_sie_import below.
  DELETE FROM public.sie_import_staging
  WHERE import_id = p_import_id AND company_id = p_company_id;

  UPDATE public.sie_imports
     SET total_vouchers = v_staged,
         posted_vouchers = v_posted,
         skipped_duplicate_vouchers = v_skipped,
         failed_vouchers = 0,
         last_checkpoint = jsonb_build_object('finalized_at', now()),
         replaces_import_id = v_replaces,
         updated_at = now()
   WHERE id = p_import_id;

  RETURN jsonb_build_object(
    'posted', v_posted,
    'skipped_duplicates', v_skipped,
    'deleted_from_replaced', v_deleted,
    'opening_balance_entry_id', v_ob_entry_id,
    'next_period_opening_balance_entry_id', v_next_ob_entry_id,
    'next_period_id', v_next_period.id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_sie_import(uuid, uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_sie_import(uuid, uuid, uuid, jsonb) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. undo_sie_import v3 — precise scope (I09), auth + search_path hardened
--    (I08). Signature unchanged for existing callers.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.undo_sie_import(p_company_id uuid, p_import_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_role text;
  v_role text := COALESCE(auth.role(), current_user::text);
  v_import record;
  v_deleted integer;
BEGIN
  -- Owner/admin only for authenticated callers; service_role passes through
  -- (server routes enforce their own write guard).
  IF auth.uid() IS NOT NULL THEN
    SELECT cm.role INTO v_caller_role
    FROM public.company_members cm
    WHERE cm.company_id = p_company_id
      AND cm.user_id = auth.uid();
    IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin') THEN
      RAISE EXCEPTION 'Only company owners and admins can undo SIE imports'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_role NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'FORBIDDEN: unauthenticated caller' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_company_id::text || ':sie_import'));

  SELECT * INTO v_import FROM public.sie_imports
  WHERE id = p_import_id AND company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Import % not found', p_import_id;
  END IF;
  IF v_import.status NOT IN ('completed', 'partial') THEN
    RAISE EXCEPTION 'Import % not in an undoable status (%)', p_import_id, v_import.status;
  END IF;

  IF v_import.fiscal_period_id IS NOT NULL THEN
    PERFORM 1 FROM public.fiscal_periods
    WHERE id = v_import.fiscal_period_id
      AND (is_closed OR locked_at IS NOT NULL);
    IF FOUND THEN
      RAISE EXCEPTION 'Cannot undo SIE import in a locked or closed fiscal period';
    END IF;
  END IF;

  v_deleted := public.__sie_delete_import_entries(p_company_id, p_import_id);

  UPDATE public.sie_imports
     SET status = 'undone', replaced_at = now()
   WHERE id = p_import_id AND company_id = p_company_id;

  RETURN v_deleted;
END;
$function$;

REVOKE ALL ON FUNCTION public.undo_sie_import(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.undo_sie_import(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.undo_sie_import(uuid, uuid) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. replace_sie_import — superseded by finalize_sie_import(replaces_import_id).
--    Hardened shim kept for legacy callers: same auth as undo, delegates to
--    the precise deletion helper (no more broad period+source_type deletes
--    when provenance exists).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.replace_sie_import(p_company_id uuid, p_import_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_role text;
  v_role text := COALESCE(auth.role(), current_user::text);
  v_import record;
  v_deleted integer;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    SELECT cm.role INTO v_caller_role
    FROM public.company_members cm
    WHERE cm.company_id = p_company_id
      AND cm.user_id = auth.uid();
    IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin') THEN
      RAISE EXCEPTION 'Only company owners and admins can replace SIE imports'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_role NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'FORBIDDEN: unauthenticated caller' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_company_id::text || ':sie_import'));

  SELECT * INTO v_import FROM public.sie_imports
  WHERE id = p_import_id AND company_id = p_company_id AND status = 'completed'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Import % not found or not in completed status', p_import_id;
  END IF;

  IF v_import.fiscal_period_id IS NOT NULL THEN
    PERFORM 1 FROM public.fiscal_periods
    WHERE id = v_import.fiscal_period_id
      AND (is_closed OR locked_at IS NOT NULL);
    IF FOUND THEN
      RAISE EXCEPTION 'Cannot replace SIE import in a locked or closed fiscal period';
    END IF;
  END IF;

  v_deleted := public.__sie_delete_import_entries(p_company_id, p_import_id);

  UPDATE public.sie_imports
     SET status = 'replaced', replaced_at = now()
   WHERE id = p_import_id AND company_id = p_company_id;

  RETURN v_deleted;
END;
$function$;

REVOKE ALL ON FUNCTION public.replace_sie_import(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.replace_sie_import(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.replace_sie_import(uuid, uuid) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. complete_sie_import — controlled status finalization (I17, I18): the
--     API flips importing → completed/failed here, with the archive result
--     and the FINAL warning list recorded in the same statement (I24).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.complete_sie_import(
  p_company_id uuid,
  p_import_id uuid,
  p_status text,
  p_error_message text DEFAULT NULL,
  p_warnings jsonb DEFAULT NULL,
  p_archived boolean DEFAULT NULL,
  p_archive_error text DEFAULT NULL,
  p_file_storage_path text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text := COALESCE(auth.role(), current_user::text);
BEGIN
  IF v_uid IS NOT NULL THEN
    IF NOT public.user_can_write_company(p_company_id) THEN
      RAISE EXCEPTION 'FORBIDDEN: no write access to company' USING ERRCODE = '42501';
    END IF;
  ELSIF v_role NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'FORBIDDEN: unauthenticated caller' USING ERRCODE = '42501';
  END IF;

  IF p_status NOT IN ('completed', 'failed', 'partial') THEN
    RAISE EXCEPTION 'SIE_INVALID_FINAL_STATUS: %', p_status;
  END IF;

  -- Fail closed on archive (I18): an import may only become 'completed' when
  -- the original file is archived.
  IF p_status = 'completed' AND COALESCE(p_archived, false) = false THEN
    RAISE EXCEPTION 'SIE_ARCHIVE_REQUIRED: original file must be archived before completing (BFL 7 kap)';
  END IF;

  UPDATE public.sie_imports
     SET status = p_status,
         error_message = p_error_message,
         warnings = COALESCE(p_warnings, warnings),
         archived_at = CASE WHEN COALESCE(p_archived, false) THEN now() ELSE archived_at END,
         archive_error = p_archive_error,
         file_storage_path = COALESCE(p_file_storage_path, file_storage_path),
         imported_at = CASE WHEN p_status = 'completed' THEN now() ELSE imported_at END,
         updated_at = now()
   WHERE id = p_import_id AND company_id = p_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SIE_IMPORT_NOT_FOUND';
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_sie_import(uuid, uuid, text, text, jsonb, boolean, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_sie_import(uuid, uuid, text, text, jsonb, boolean, text, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
