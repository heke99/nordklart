-- Complete the canonical year-end execution contract without changing any
-- deployed migration. This migration separates adjustment source types from
-- the final close, makes execute retries replay before preview validation, and
-- adds operational processors for reversals and the transactional outbox.

BEGIN;

ALTER TABLE public.journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_source_type_check;
ALTER TABLE public.journal_entries
  ADD CONSTRAINT journal_entries_source_type_check CHECK (source_type = ANY (ARRAY[
    'manual'::text, 'bank_transaction'::text, 'invoice_created'::text,
    'invoice_paid'::text, 'invoice_cash_payment'::text, 'credit_note'::text,
    'salary_payment'::text, 'opening_balance'::text, 'year_end'::text,
    'year_end_accrual'::text, 'year_end_depreciation'::text,
    'year_end_fx_revaluation'::text, 'year_end_tax_adjustment'::text,
    'year_end_disposition'::text, 'year_end_deferred_tax'::text,
    'year_end_closing'::text, 'storno'::text, 'correction'::text,
    'import'::text, 'system'::text, 'inbox_item'::text,
    'supplier_invoice_registered'::text, 'supplier_invoice_paid'::text,
    'supplier_invoice_cash_payment'::text, 'supplier_credit_note'::text,
    'currency_revaluation'::text, 'currency_revaluation_reversal'::text,
    'supplier_invoice_privately_paid'::text, 'reminder_fee'::text,
    'accrual'::text, 'result_appropriation'::text
  ]));

DROP INDEX IF EXISTS public.journal_entries_one_year_end_per_period;
CREATE UNIQUE INDEX journal_entries_one_year_end_closing_per_period
  ON public.journal_entries (company_id, fiscal_period_id)
  WHERE source_type IN ('year_end', 'year_end_closing')
    AND status = 'posted';

ALTER TABLE public.year_end_runs
  ADD COLUMN IF NOT EXISTS next_period_created boolean;

ALTER TABLE public.year_end_scheduled_reversals
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS processed_at timestamptz;
ALTER TABLE public.year_end_scheduled_reversals
  DROP CONSTRAINT IF EXISTS year_end_scheduled_reversals_status_check;
ALTER TABLE public.year_end_scheduled_reversals
  ADD CONSTRAINT year_end_scheduled_reversals_status_check CHECK (
    status IN ('scheduled', 'processing', 'posted', 'cancelled', 'failed', 'dead_letter')
  );
CREATE INDEX IF NOT EXISTS year_end_scheduled_reversals_due
  ON public.year_end_scheduled_reversals (next_attempt_at, reversal_date, id)
  WHERE status IN ('scheduled', 'failed', 'processing');

ALTER TABLE public.year_end_outbox
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS processed_at timestamptz,
  ADD COLUMN IF NOT EXISTS dead_lettered_at timestamptz;
ALTER TABLE public.year_end_outbox
  DROP CONSTRAINT IF EXISTS year_end_outbox_status_check;
ALTER TABLE public.year_end_outbox
  ADD CONSTRAINT year_end_outbox_status_check CHECK (
    status IN ('pending', 'processing', 'delivered', 'failed', 'dead_letter')
  );
CREATE INDEX IF NOT EXISTS year_end_outbox_due
  ON public.year_end_outbox (next_attempt_at, id)
  WHERE status IN ('pending', 'failed', 'processing');

-- Future callers that still request the legacy final-close source are mapped
-- to the canonical source before the draft is inserted. Historical posted
-- rows remain immutable and are covered by the compatibility unique index.
CREATE OR REPLACE FUNCTION public.__ye_post_entry(
  p_company_id uuid,
  p_user_id uuid,
  p_fiscal_period_id uuid,
  p_entry_date date,
  p_description text,
  p_source_type text,
  p_series text,
  p_lines jsonb,
  p_reverses_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_entry_id uuid;
  v_line jsonb;
  v_total_debit numeric := 0;
  v_total_credit numeric := 0;
  v_next integer;
  v_source_type text := CASE
    WHEN p_source_type = 'year_end' THEN 'year_end_closing'
    ELSE p_source_type
  END;
BEGIN
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array'
     OR jsonb_array_length(p_lines) < 2 THEN
    RAISE EXCEPTION 'YE_EMPTY_ENTRY: refusing to post entry "%" without two lines',
      p_description USING ERRCODE = '22023';
  END IF;

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines)
  LOOP
    IF coalesce(v_line->>'account_number', '') !~ '^[0-9]{4}$' THEN
      RAISE EXCEPTION 'YE_INVALID_LINE: invalid account in "%"', p_description
        USING ERRCODE = '22023';
    END IF;
    IF coalesce((v_line->>'debit_amount')::numeric, 0) < 0
       OR coalesce((v_line->>'credit_amount')::numeric, 0) < 0
       OR (
         coalesce((v_line->>'debit_amount')::numeric, 0) > 0
         AND coalesce((v_line->>'credit_amount')::numeric, 0) > 0
       ) THEN
      RAISE EXCEPTION 'YE_INVALID_LINE: invalid amount on account %',
        v_line->>'account_number' USING ERRCODE = '22023';
    END IF;
    v_total_debit := v_total_debit
      + coalesce((v_line->>'debit_amount')::numeric, 0);
    v_total_credit := v_total_credit
      + coalesce((v_line->>'credit_amount')::numeric, 0);
  END LOOP;

  IF abs(round(v_total_debit - v_total_credit, 2)) >= 0.005
     OR round(v_total_debit, 2) <= 0 THEN
    RAISE EXCEPTION 'YE_UNBALANCED: entry "%" does not balance', p_description
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.journal_entries (
    company_id, user_id, fiscal_period_id, voucher_number, voucher_series,
    entry_date, description, source_type, status, created_via, reverses_id
  ) VALUES (
    p_company_id, p_user_id, p_fiscal_period_id, 0, p_series,
    p_entry_date, p_description, v_source_type, 'draft', 'system', p_reverses_id
  )
  RETURNING id INTO v_entry_id;

  INSERT INTO public.journal_entry_lines (
    journal_entry_id, account_number, debit_amount, credit_amount, line_description
  )
  SELECT
    v_entry_id,
    line->>'account_number',
    round(coalesce((line->>'debit_amount')::numeric, 0), 2),
    round(coalesce((line->>'credit_amount')::numeric, 0), 2),
    line->>'line_description'
  FROM jsonb_array_elements(p_lines) line;

  INSERT INTO public.voucher_sequences (
    company_id, user_id, fiscal_period_id, voucher_series, last_number
  ) VALUES (
    p_company_id, p_user_id, p_fiscal_period_id, p_series, 1
  )
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

REVOKE ALL ON FUNCTION public.__ye_post_entry(
  uuid, uuid, uuid, date, text, text, text, jsonb, uuid
) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.execute_year_end_closing(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_user_id uuid,
  p_idempotency_key text,
  p_revaluation jsonb,
  p_preview_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_preview public.year_end_previews%ROWTYPE;
  v_adjustment public.year_end_staged_adjustments%ROWTYPE;
  v_existing_run public.year_end_runs%ROWTYPE;
  v_entry_id uuid;
  v_reversal_lines jsonb;
  v_result jsonb;
  v_run_id uuid;
  v_next_period_existed boolean;
BEGIN
  v_actor := public.__year_end_assert_actor(p_company_id, p_user_id);
  IF coalesce(btrim(p_idempotency_key), '') = '' THEN
    RAISE EXCEPTION 'YE_IDEMPOTENCY_REQUIRED' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat_ws(':', 'year-end-execute', p_company_id, p_fiscal_period_id), 0
  ));

  -- Replay is intentionally checked before preview state. A successful first
  -- call marks the preview executed, so reversing this order breaks retry
  -- after a lost HTTP response.
  SELECT run.* INTO v_existing_run
  FROM public.year_end_runs run
  WHERE run.company_id = p_company_id
    AND run.fiscal_period_id = p_fiscal_period_id
    AND run.idempotency_key = p_idempotency_key
    AND run.status = 'closed'
  ORDER BY run.created_at DESC
  LIMIT 1;
  IF FOUND THEN
    RETURN coalesce(v_existing_run.result_payload, '{}'::jsonb)
      || jsonb_build_object(
        'run_id', v_existing_run.id,
        'closing_entry_id', v_existing_run.closing_entry_id,
        'opening_balance_entry_id', v_existing_run.opening_balance_entry_id,
        'next_period_id', v_existing_run.next_period_id,
        'revaluation_entry_id', v_existing_run.revaluation_entry_id,
        'revaluation_reversal_entry_id', v_existing_run.revaluation_reversal_entry_id,
        'preview_id', v_existing_run.preview_id,
        'ledger_hash', v_existing_run.ledger_hash,
        'readiness_hash', v_existing_run.readiness_hash,
        'adjustment_hash', v_existing_run.adjustment_hash,
        'ruleset_version', v_existing_run.ruleset_version,
        'next_period_created', v_existing_run.next_period_created,
        'idempotent', true
      );
  END IF;

  IF p_preview_id IS NULL THEN
    RAISE EXCEPTION 'YE_PREVIEW_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT preview.* INTO v_preview
  FROM public.year_end_previews preview
  WHERE preview.id = p_preview_id
    AND preview.company_id = p_company_id
    AND preview.fiscal_period_id = p_fiscal_period_id
  FOR UPDATE;
  IF NOT FOUND OR v_preview.status <> 'active' OR v_preview.expires_at <= now() THEN
    RAISE EXCEPTION 'YE_PREVIEW_STALE' USING ERRCODE = '55000';
  END IF;
  IF v_preview.ledger_hash
       <> public.__year_end_ledger_hash(p_company_id, p_fiscal_period_id)
     OR v_preview.readiness_hash
       <> public.__year_end_readiness_hash(p_company_id, p_fiscal_period_id)
     OR v_preview.adjustment_hash
       <> public.__year_end_adjustment_hash(p_company_id, p_fiscal_period_id) THEN
    UPDATE public.year_end_previews SET status = 'stale' WHERE id = p_preview_id;
    RAISE EXCEPTION 'YE_PREVIEW_STALE' USING ERRCODE = '55000';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.fiscal_periods current_period
    JOIN public.fiscal_periods next_period
      ON next_period.company_id = current_period.company_id
     AND next_period.period_start = current_period.period_end + 1
    WHERE current_period.id = p_fiscal_period_id
      AND current_period.company_id = p_company_id
  ) INTO v_next_period_existed;

  FOR v_adjustment IN
    SELECT *
    FROM public.year_end_staged_adjustments
    WHERE company_id = p_company_id
      AND fiscal_period_id = p_fiscal_period_id
      AND status = 'included_in_preview'
    ORDER BY CASE adjustment_group
      WHEN 'accrual' THEN 10
      WHEN 'depreciation' THEN 20
      WHEN 'disposition' THEN 30
      WHEN 'tax' THEN 40
      ELSE 50
    END, stable_key, id
    FOR UPDATE
  LOOP
    v_entry_id := public.__ye_post_entry(
      p_company_id,
      v_actor,
      p_fiscal_period_id,
      v_adjustment.entry_date,
      v_adjustment.description,
      CASE
        WHEN v_adjustment.adjustment_group = 'accrual'
          THEN 'year_end_accrual'
        WHEN v_adjustment.adjustment_group = 'depreciation'
          THEN 'year_end_depreciation'
        WHEN v_adjustment.adjustment_kind IN ('bolagsskatt', 'sarskild_loneskatt')
          THEN 'year_end_tax_adjustment'
        WHEN v_adjustment.adjustment_kind = 'uppskjuten_skatt'
          THEN 'year_end_deferred_tax'
        ELSE 'year_end_disposition'
      END,
      'A',
      v_adjustment.journal_lines
    );

    UPDATE public.year_end_staged_adjustments
    SET status = 'posted', posted_entry_id = v_entry_id,
        updated_by = v_actor, updated_at = now()
    WHERE id = v_adjustment.id;

    IF v_adjustment.adjustment_group = 'depreciation'
       AND v_adjustment.adjustment_kind = 'planned_depreciation' THEN
      INSERT INTO public.depreciation_schedules (
        user_id, company_id, asset_id, fiscal_period_id,
        planned_depreciation, journal_entry_id, posted_at
      ) VALUES (
        v_actor,
        p_company_id,
        (v_adjustment.calculation_payload->>'asset_id')::uuid,
        p_fiscal_period_id,
        (v_adjustment.calculation_payload->>'planned_depreciation')::numeric,
        v_entry_id,
        now()
      )
      ON CONFLICT (asset_id, fiscal_period_id) DO UPDATE SET
        planned_depreciation = EXCLUDED.planned_depreciation,
        journal_entry_id = EXCLUDED.journal_entry_id,
        posted_at = EXCLUDED.posted_at;
    END IF;

    IF v_adjustment.reversal_date IS NOT NULL THEN
      SELECT jsonb_agg(jsonb_build_object(
        'account_number', line->>'account_number',
        'debit_amount', coalesce((line->>'credit_amount')::numeric, 0),
        'credit_amount', coalesce((line->>'debit_amount')::numeric, 0),
        'line_description',
          'Återföring: ' || coalesce(line->>'line_description', v_adjustment.description)
      ))
      INTO v_reversal_lines
      FROM jsonb_array_elements(v_adjustment.journal_lines) line;

      INSERT INTO public.year_end_scheduled_reversals (
        company_id, fiscal_period_id, adjustment_id, source_entry_id,
        reversal_date, reversal_lines, created_by
      ) VALUES (
        p_company_id, p_fiscal_period_id, v_adjustment.id, v_entry_id,
        v_adjustment.reversal_date, v_reversal_lines, v_actor
      )
      ON CONFLICT (adjustment_id) DO NOTHING;
    END IF;
  END LOOP;

  v_result := public.__execute_year_end_closing_preview_core_20260730(
    p_company_id, p_fiscal_period_id, v_actor, p_idempotency_key, p_revaluation
  );
  v_run_id := (v_result->>'run_id')::uuid;

  UPDATE public.year_end_previews
  SET status = 'executed', executed_at = now()
  WHERE id = p_preview_id;

  v_result := v_result || jsonb_build_object(
    'preview_id', p_preview_id,
    'ledger_hash', v_preview.ledger_hash,
    'readiness_hash', v_preview.readiness_hash,
    'adjustment_hash', v_preview.adjustment_hash,
    'ruleset_version', v_preview.ruleset_version,
    'next_period_created', NOT v_next_period_existed
  );

  UPDATE public.year_end_runs
  SET preview_id = p_preview_id,
      ledger_hash = v_preview.ledger_hash,
      readiness_hash = v_preview.readiness_hash,
      adjustment_hash = v_preview.adjustment_hash,
      ruleset_version = v_preview.ruleset_version,
      next_period_created = NOT v_next_period_existed,
      committed_at = coalesce(committed_at, now()),
      result_payload = v_result
  WHERE id = v_run_id
    AND company_id = p_company_id
    AND fiscal_period_id = p_fiscal_period_id;

  INSERT INTO public.year_end_outbox (
    company_id, fiscal_period_id, year_end_run_id, event_type, payload,
    next_attempt_at
  ) VALUES (
    p_company_id, p_fiscal_period_id, v_run_id, 'period.year_closed',
    v_result, now()
  )
  ON CONFLICT (year_end_run_id, event_type) DO NOTHING;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.execute_year_end_closing(
  uuid, uuid, uuid, text, jsonb, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.execute_year_end_closing(
  uuid, uuid, uuid, text, jsonb, uuid
) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.process_due_year_end_reversals(
  p_limit integer DEFAULT 100
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_reversal public.year_end_scheduled_reversals%ROWTYPE;
  v_target_period public.fiscal_periods%ROWTYPE;
  v_entry_id uuid;
  v_posted integer := 0;
  v_failed integer := 0;
BEGIN
  IF current_user NOT IN ('postgres', 'service_role', 'supabase_admin') THEN
    RAISE EXCEPTION 'YE_PROCESSOR_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  FOR v_reversal IN
    SELECT reversal.*
    FROM public.year_end_scheduled_reversals reversal
    WHERE (
      reversal.status IN ('scheduled', 'failed')
      OR (
        reversal.status = 'processing'
        AND reversal.locked_at < now() - interval '15 minutes'
      )
    )
      AND reversal.reversal_date <= current_date
      AND reversal.next_attempt_at <= now()
      AND reversal.attempt_count < 10
    ORDER BY reversal.reversal_date, reversal.id
    FOR UPDATE SKIP LOCKED
    LIMIT greatest(1, least(coalesce(p_limit, 100), 500))
  LOOP
    BEGIN
      UPDATE public.year_end_scheduled_reversals
      SET status = 'processing', locked_at = now(),
          attempt_count = attempt_count + 1, last_error = NULL
      WHERE id = v_reversal.id;

      SELECT period.* INTO v_target_period
      FROM public.fiscal_periods period
      WHERE period.company_id = v_reversal.company_id
        AND v_reversal.reversal_date BETWEEN period.period_start AND period.period_end
        AND NOT period.is_closed
        AND period.locked_at IS NULL
      ORDER BY period.period_start
      LIMIT 1
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'YE_REVERSAL_PERIOD_MISSING';
      END IF;

      v_entry_id := public.__ye_post_entry(
        v_reversal.company_id,
        v_reversal.created_by,
        v_target_period.id,
        v_reversal.reversal_date,
        'Automatisk återföring av bokslutsperiodisering',
        'year_end_accrual',
        'A',
        v_reversal.reversal_lines,
        v_reversal.source_entry_id
      );

      UPDATE public.year_end_scheduled_reversals
      SET status = 'posted', reversal_entry_id = v_entry_id,
          processed_at = now(), locked_at = NULL, last_error = NULL
      WHERE id = v_reversal.id
        AND reversal_entry_id IS NULL;
      v_posted := v_posted + 1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.year_end_scheduled_reversals
      SET attempt_count = v_reversal.attempt_count + 1,
          status = CASE
            WHEN v_reversal.attempt_count + 1 >= 10 THEN 'dead_letter'
            ELSE 'failed'
          END,
          last_error = left(SQLSTATE || ': ' || SQLERRM, 2000),
          next_attempt_at = now()
            + power(2, least(v_reversal.attempt_count + 1, 8)) * interval '1 minute',
          locked_at = NULL
      WHERE id = v_reversal.id;
      v_failed := v_failed + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('posted', v_posted, 'failed', v_failed);
END;
$$;

REVOKE ALL ON FUNCTION public.process_due_year_end_reversals(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_due_year_end_reversals(integer)
  TO service_role;

CREATE OR REPLACE FUNCTION public.claim_year_end_outbox(
  p_limit integer DEFAULT 100
) RETURNS TABLE (
  id uuid,
  company_id uuid,
  fiscal_period_id uuid,
  year_end_run_id uuid,
  event_type text,
  payload jsonb,
  actor_user_id uuid,
  attempt_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user NOT IN ('postgres', 'service_role', 'supabase_admin') THEN
    RAISE EXCEPTION 'YE_OUTBOX_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH due AS (
    SELECT outbox.id
    FROM public.year_end_outbox outbox
    WHERE (
      outbox.status IN ('pending', 'failed')
      OR (
        outbox.status = 'processing'
        AND outbox.locked_at < now() - interval '15 minutes'
      )
    )
      AND outbox.next_attempt_at <= now()
      AND outbox.attempt_count < 10
    ORDER BY outbox.next_attempt_at, outbox.id
    FOR UPDATE SKIP LOCKED
    LIMIT greatest(1, least(coalesce(p_limit, 100), 500))
  ),
  claimed AS (
    UPDATE public.year_end_outbox outbox
    SET status = 'processing',
        locked_at = now(),
        attempt_count = outbox.attempt_count + 1,
        last_error = NULL
    FROM due
    WHERE outbox.id = due.id
    RETURNING outbox.*
  )
  SELECT claimed.id, claimed.company_id, claimed.fiscal_period_id,
         claimed.year_end_run_id, claimed.event_type, claimed.payload,
         run.created_by, claimed.attempt_count
  FROM claimed
  JOIN public.year_end_runs run ON run.id = claimed.year_end_run_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_year_end_outbox(
  p_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user NOT IN ('postgres', 'service_role', 'supabase_admin') THEN
    RAISE EXCEPTION 'YE_OUTBOX_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  UPDATE public.year_end_outbox
  SET status = 'delivered', delivered_at = now(), processed_at = now(),
      locked_at = NULL, last_error = NULL
  WHERE id = p_id AND status = 'processing';
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_year_end_outbox(
  p_id uuid,
  p_error text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user NOT IN ('postgres', 'service_role', 'supabase_admin') THEN
    RAISE EXCEPTION 'YE_OUTBOX_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  UPDATE public.year_end_outbox
  SET status = CASE WHEN attempt_count >= 10 THEN 'dead_letter' ELSE 'failed' END,
      dead_lettered_at = CASE WHEN attempt_count >= 10 THEN now() ELSE NULL END,
      next_attempt_at = now()
        + power(2, least(attempt_count, 8)) * interval '1 minute',
      last_error = left(coalesce(p_error, 'unknown'), 2000),
      locked_at = NULL
  WHERE id = p_id AND status = 'processing';
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_year_end_outbox(integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_year_end_outbox(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_year_end_outbox(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_year_end_outbox(integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_year_end_outbox(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_year_end_outbox(uuid, text)
  TO service_role;

COMMENT ON FUNCTION public.process_due_year_end_reversals(integer) IS
  'Idempotently posts due year-end accrual reversals with retry/dead-letter state.';
COMMENT ON FUNCTION public.claim_year_end_outbox(integer) IS
  'Claims due year-end events with SKIP LOCKED for the authenticated cron processor.';

NOTIFY pgrst, 'reload schema';

COMMIT;
