-- SIE undo/replace must preserve posted bookkeeping rows.
--
-- The legacy helper name __sie_delete_import_entries is retained only as an
-- internal compatibility shim because finalize_sie_import already calls that
-- signature. Its semantics are changed from DELETE to exact storno reversal.
-- Direct replace_sie_import is disabled: replacement requires a corrected file
-- and is performed by finalize_sie_import(replaces_import_id) in one transaction.
--
-- pg-test: covered by lib/import/__tests__/sie-import.replace.pg.test.ts and sie-import-engine.pg.test.ts

CREATE TABLE IF NOT EXISTS public.sie_import_entry_reversals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  sie_import_id uuid NOT NULL REFERENCES public.sie_imports(id) ON DELETE RESTRICT,
  original_entry_id uuid NOT NULL REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  reversal_entry_id uuid NOT NULL REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  reversed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sie_import_entry_reversals_original_unique UNIQUE (original_entry_id),
  CONSTRAINT sie_import_entry_reversals_reversal_unique UNIQUE (reversal_entry_id),
  CONSTRAINT sie_import_entry_reversals_distinct_entries CHECK (original_entry_id <> reversal_entry_id)
);

CREATE INDEX IF NOT EXISTS sie_import_entry_reversals_import_idx
  ON public.sie_import_entry_reversals(company_id, sie_import_id, created_at);

ALTER TABLE public.sie_import_entry_reversals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sie_import_entry_reversals_select ON public.sie_import_entry_reversals;
CREATE POLICY sie_import_entry_reversals_select
  ON public.sie_import_entry_reversals
  FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

REVOKE INSERT, UPDATE, DELETE ON public.sie_import_entry_reversals FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sie_import_entry_reversals TO authenticated;
GRANT ALL ON public.sie_import_entry_reversals TO service_role;

CREATE OR REPLACE FUNCTION public.__sie_reverse_import_entries(
  p_company_id uuid,
  p_import_id uuid
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_import public.sie_imports%ROWTYPE;
  v_entry public.journal_entries%ROWTYPE;
  v_actor uuid;
  v_reversal_id uuid;
  v_reversed integer := 0;
  v_tagged integer := 0;
BEGIN
  SELECT * INTO v_import
  FROM public.sie_imports
  WHERE id = p_import_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SIE_IMPORT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- Service-role callers must still preserve the real user attribution.
  -- Undo passes a transaction-local actor through undo_sie_import_internal;
  -- replace can infer the actor from the staged import that names this import
  -- as replaces_import_id. Falling back to the original importer is only for
  -- legacy service-only maintenance calls.
  v_actor := COALESCE(
    NULLIF(current_setting('nordklart.actor_user_id', true), '')::uuid,
    auth.uid(),
    (
      SELECT replacement.user_id
      FROM public.sie_imports replacement
      WHERE replacement.company_id = p_company_id
        AND replacement.replaces_import_id = p_import_id
        AND replacement.status IN ('pending','validating','staged','importing','partial')
      ORDER BY replacement.created_at DESC
      LIMIT 1
    ),
    v_import.user_id
  );
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'SIE_REVERSAL_ACTOR_REQUIRED' USING ERRCODE = '42501';
  END IF;

  SELECT count(*)::integer INTO v_tagged
  FROM public.journal_entries je
  WHERE je.company_id = p_company_id
    AND je.sie_import_id = p_import_id
    AND je.source_type <> 'storno';

  -- Never guess a legacy period scope. Exact provenance is required to avoid
  -- touching another import or a native/manual journal entry.
  IF v_tagged = 0 THEN
    RAISE EXCEPTION 'SIE_LEGACY_PROVENANCE_REQUIRED: import has no exactly tagged journal entries'
      USING ERRCODE = '55000';
  END IF;

  FOR v_entry IN
    SELECT je.*
    FROM public.journal_entries je
    WHERE je.company_id = p_company_id
      AND je.sie_import_id = p_import_id
      AND je.source_type <> 'storno'
      AND je.status = 'posted'
    ORDER BY je.entry_date, je.voucher_series, je.voucher_number, je.id
    FOR UPDATE
  LOOP
    -- Idempotency guard. A successfully reversed original can never receive a
    -- second storno, even if a retry reaches this helper through another path.
    IF EXISTS (
      SELECT 1
      FROM public.sie_import_entry_reversals r
      WHERE r.original_entry_id = v_entry.id
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO public.journal_entries (
      company_id,
      user_id,
      fiscal_period_id,
      voucher_number,
      voucher_series,
      entry_date,
      description,
      source_type,
      source_id,
      status,
      created_via,
      reverses_id,
      sie_import_id,
      external_reference,
      source_voucher_series,
      source_voucher_number
    ) VALUES (
      p_company_id,
      v_actor,
      v_entry.fiscal_period_id,
      0,
      v_entry.voucher_series,
      v_entry.entry_date,
      'Reversering av ' || v_entry.voucher_series || v_entry.voucher_number::text || ': ' || COALESCE(v_entry.description, ''),
      'storno',
      v_entry.id,
      'draft',
      'system',
      v_entry.id,
      p_import_id,
      'reversal:' || v_entry.id::text,
      v_entry.source_voucher_series,
      v_entry.source_voucher_number
    )
    RETURNING id INTO v_reversal_id;

    INSERT INTO public.journal_entry_lines (
      journal_entry_id,
      account_number,
      account_id,
      debit_amount,
      credit_amount,
      currency,
      amount_in_currency,
      exchange_rate,
      line_description,
      sort_order,
      tax_code,
      cost_center,
      project,
      dimensions
    )
    SELECT
      v_reversal_id,
      l.account_number,
      l.account_id,
      l.credit_amount,
      l.debit_amount,
      l.currency,
      CASE WHEN l.amount_in_currency IS NULL THEN NULL ELSE -l.amount_in_currency END,
      l.exchange_rate,
      CASE
        WHEN l.line_description IS NULL OR btrim(l.line_description) = '' THEN 'Reversering'
        ELSE 'Reversering: ' || l.line_description
      END,
      l.sort_order,
      l.tax_code,
      l.cost_center,
      l.project,
      l.dimensions
    FROM public.journal_entry_lines l
    WHERE l.journal_entry_id = v_entry.id
    ORDER BY l.sort_order, l.id;

    -- Reuse the canonical posting RPC so balance validation, voucher-number
    -- allocation, immutable commit metadata and audit attribution stay exactly
    -- aligned with every other journal entry path.
    PERFORM public.commit_journal_entry(
      p_company_id,
      v_reversal_id,
      'sie_import_reversal',
      NULL,
      'system',
      'SIE undo/replace'
    );

    UPDATE public.journal_entries
    SET status = 'reversed',
        reversed_by_id = v_reversal_id
    WHERE id = v_entry.id
      AND company_id = p_company_id
      AND status = 'posted';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'SIE_REVERSAL_RACE: original entry % changed status', v_entry.id
        USING ERRCODE = '40001';
    END IF;

    INSERT INTO public.sie_import_entry_reversals (
      company_id, sie_import_id, original_entry_id, reversal_entry_id, reversed_by
    ) VALUES (
      p_company_id, p_import_id, v_entry.id, v_reversal_id, v_actor
    );

    v_reversed := v_reversed + 1;
  END LOOP;

  -- An explicit opening-balance pointer must not continue to reference only
  -- the original side of a now-reversed pair, otherwise reports would ignore
  -- the storno. Clear the pointer while keeping both immutable entries.
  UPDATE public.fiscal_periods fp
  SET opening_balances_set = false
  WHERE fp.company_id = p_company_id
    AND fp.opening_balance_entry_id IN (
      SELECT r.original_entry_id
      FROM public.sie_import_entry_reversals r
      WHERE r.company_id = p_company_id AND r.sie_import_id = p_import_id
    );

  UPDATE public.fiscal_periods fp
  SET opening_balance_entry_id = NULL
  WHERE fp.company_id = p_company_id
    AND fp.opening_balance_entry_id IN (
      SELECT r.original_entry_id
      FROM public.sie_import_entry_reversals r
      WHERE r.company_id = p_company_id AND r.sie_import_id = p_import_id
    );

  UPDATE public.sie_imports
  SET opening_balance_entry_id = NULL,
      updated_at = now()
  WHERE id = p_import_id AND company_id = p_company_id;

  INSERT INTO public.audit_log (
    user_id, actor_id, company_id, action, table_name, record_id, description, new_state
  ) VALUES (
    v_actor,
    v_actor,
    p_company_id,
    'UPDATE',
    'sie_imports',
    p_import_id,
    'SIE-importens bokförda verifikationer reverserades utan hårdradering.',
    jsonb_build_object(
      'operation', 'sie_import.entries.reverse',
      'sie_import_id', p_import_id,
      'reversed_entries', v_reversed
    )
  );

  RETURN v_reversed;
END;
$$;

REVOKE ALL ON FUNCTION public.__sie_reverse_import_entries(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.__sie_reverse_import_entries(uuid, uuid) TO service_role;

-- Compatibility shim: callers and the already-deployed finalize function keep
-- the old internal name, but no DELETE occurs.
CREATE OR REPLACE FUNCTION public.__sie_delete_import_entries(
  p_company_id uuid,
  p_import_id uuid
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  RETURN public.__sie_reverse_import_entries(p_company_id, p_import_id);
END;
$$;

REVOKE ALL ON FUNCTION public.__sie_delete_import_entries(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.__sie_delete_import_entries(uuid, uuid) TO service_role;

-- Server-only undo entrypoint. It re-verifies the attributed actor, permits
-- a period-scoped one-off customer only for the purchased period, and then
-- carries that actor into the reversal audit trail.
CREATE OR REPLACE FUNCTION public.undo_sie_import_internal(
  p_company_id uuid,
  p_import_id uuid,
  p_actor_user_id uuid
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_role text := COALESCE(auth.role(), current_user::text);
  v_access record;
  v_import public.sie_imports%ROWTYPE;
  v_can_operate boolean := false;
  v_reversed integer;
BEGIN
  IF v_role NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'FORBIDDEN: service role required' USING ERRCODE = '42501';
  END IF;
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'SIE_REVERSAL_ACTOR_REQUIRED' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_company_id::text || ':sie_import'));

  SELECT * INTO v_import
  FROM public.sie_imports
  WHERE id = p_import_id AND company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SIE_IMPORT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_access
  FROM public.resolve_company_access_for_user(p_actor_user_id, p_company_id)
  LIMIT 1;
  IF NOT FOUND OR NOT COALESCE(v_access.can_read, false) THEN
    RAISE EXCEPTION 'PERMISSION_DENIED' USING ERRCODE = '42501';
  END IF;

  v_can_operate := COALESCE(v_access.can_write, false)
    OR (COALESCE(v_access.can_manage_platform, false)
        AND v_access.effective_role = 'platform_admin');

  IF NOT v_can_operate
     AND v_access.effective_role IN ('company_owner','company_admin','accountant','client_user') THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.one_time_purchases otp
      WHERE otp.company_id = p_company_id
        AND otp.purchase_type = 'year_end'
        AND otp.fiscal_period_id = v_import.fiscal_period_id
        AND otp.status IN ('paid','active','fulfilled')
        AND (otp.access_starts_at IS NULL OR otp.access_starts_at <= now())
        AND (otp.permanent_access OR otp.access_expires_at IS NULL OR otp.access_expires_at > now())
    ) INTO v_can_operate;
  END IF;

  IF NOT v_can_operate THEN
    RAISE EXCEPTION 'PERMISSION_DENIED' USING ERRCODE = '42501';
  END IF;
  IF v_import.status NOT IN ('completed','partial') THEN
    RAISE EXCEPTION 'SIE_IMPORT_WRONG_STATUS: %', v_import.status USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.fiscal_periods fp
    WHERE fp.id = v_import.fiscal_period_id
      AND fp.company_id = p_company_id
      AND (fp.is_closed OR fp.locked_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'SIE_PERIOD_LOCKED' USING ERRCODE = '55000';
  END IF;

  PERFORM set_config('nordklart.actor_user_id', p_actor_user_id::text, true);
  v_reversed := public.__sie_reverse_import_entries(p_company_id, p_import_id);

  UPDATE public.sie_imports
  SET status = 'undone', replaced_at = now(), updated_at = now()
  WHERE id = p_import_id AND company_id = p_company_id;

  RETURN v_reversed;
END;
$$;

REVOKE ALL ON FUNCTION public.undo_sie_import_internal(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.undo_sie_import_internal(uuid, uuid, uuid) TO service_role;

-- Legacy direct RPC is no longer available to browser clients.
REVOKE ALL ON FUNCTION public.undo_sie_import(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.undo_sie_import(uuid, uuid) TO service_role;

-- A replacement without a corrected, fully staged file is unsafe. The new
-- file must go through finalize_sie_import(replaces_import_id), which invokes
-- the reversal helper and posts the new import in the same transaction.
CREATE OR REPLACE FUNCTION public.replace_sie_import(
  p_company_id uuid,
  p_import_id uuid
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  RAISE EXCEPTION 'SIE_REPLACE_FILE_REQUIRED: upload and validate the corrected file before replacement'
    USING ERRCODE = '55000';
END;
$$;

REVOKE ALL ON FUNCTION public.replace_sie_import(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.__sie_delete_import_entries(uuid, uuid) IS
  'Compatibility name only. Creates exact storno entries; never deletes posted journal entries.';
