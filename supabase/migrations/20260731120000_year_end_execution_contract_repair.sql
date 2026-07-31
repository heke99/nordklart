-- Canonical year-end execution contract repair.
--
-- Dependencies (must already be applied in this order):
--   20260730170000_canonical_year_end_staging_preview_execute.sql
--   20260730213000_canonical_year_end_completion_repair.sql
--
-- This migration is forward-only. It does not rewrite posted journal entries.
-- Legacy `year_end` rows remain immutable; only rows already linked as a fiscal
-- period/run closing entry are treated as legacy final closes by the guard.

BEGIN;

-- Keep every runtime/source schema on one canonical source-type vocabulary.
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
DROP INDEX IF EXISTS public.journal_entries_one_year_end_closing_per_period;
CREATE UNIQUE INDEX journal_entries_one_year_end_closing_per_period
  ON public.journal_entries (company_id, fiscal_period_id)
  WHERE source_type = 'year_end_closing' AND status = 'posted';

-- Historical generic final closes cannot be rewritten without violating the
-- immutable-ledger contract. This trigger prevents a canonical duplicate only
-- when the legacy row is already linked as the actual final close. Unlinked
-- generic rows are intentionally left for explicit review/reversal.
CREATE OR REPLACE FUNCTION public.enforce_canonical_year_end_closing_uniqueness()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'posted' AND NEW.source_type = 'year_end' THEN
    IF TG_OP = 'INSERT'
       OR (TG_OP = 'UPDATE' AND (
         OLD.status IS DISTINCT FROM NEW.status
         OR OLD.source_type IS DISTINCT FROM NEW.source_type
       )) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'YE_LEGACY_SOURCE_TYPE_FORBIDDEN',
        DETAIL = jsonb_build_object('code', 'YE_DUPLICATE_CLOSING_ENTRY')::text;
    END IF;
  END IF;

  IF NEW.status = 'posted' AND NEW.source_type = 'year_end_closing' AND EXISTS (
    SELECT 1
    FROM public.journal_entries legacy
    WHERE legacy.company_id = NEW.company_id
      AND legacy.fiscal_period_id = NEW.fiscal_period_id
      AND legacy.status = 'posted'
      AND legacy.source_type = 'year_end'
      AND legacy.id <> NEW.id
      AND (
        EXISTS (
          SELECT 1 FROM public.fiscal_periods fp
          WHERE fp.company_id = NEW.company_id
            AND fp.id = NEW.fiscal_period_id
            AND fp.closing_entry_id = legacy.id
        )
        OR EXISTS (
          SELECT 1 FROM public.year_end_runs run
          WHERE run.company_id = NEW.company_id
            AND run.fiscal_period_id = NEW.fiscal_period_id
            AND run.closing_entry_id = legacy.id
            AND run.status = 'closed'
        )
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'YE_DUPLICATE_CLOSING_ENTRY',
      DETAIL = jsonb_build_object('code', 'YE_DUPLICATE_CLOSING_ENTRY')::text;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_canonical_year_end_closing_uniqueness()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS enforce_canonical_year_end_closing_uniqueness
  ON public.journal_entries;
CREATE TRIGGER enforce_canonical_year_end_closing_uniqueness
  BEFORE INSERT OR UPDATE OF status, source_type ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.enforce_canonical_year_end_closing_uniqueness();

ALTER TABLE public.year_end_runs
  ADD COLUMN IF NOT EXISTS retryable boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS recovery_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS opening_balance_created boolean,
  ADD COLUMN IF NOT EXISTS next_period_created boolean,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.year_end_runs
  DROP CONSTRAINT IF EXISTS year_end_runs_status_check;
ALTER TABLE public.year_end_runs
  ADD CONSTRAINT year_end_runs_status_check CHECK (status IN (
    'open', 'created', 'validating', 'locking', 'posting_adjustments',
    'posting_closing_entry', 'creating_next_period',
    'creating_opening_balance', 'verifying_continuity', 'closing_period',
    'committing', 'closing', 'closed', 'failed', 'recovery_required',
    'reopening', 'reopened', 'superseded'
  ));

CREATE OR REPLACE FUNCTION public.enforce_year_end_run_status_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.status = 'open' AND NEW.status IN ('created', 'validating', 'failed', 'recovery_required', 'superseded'))
    OR (OLD.status = 'created' AND NEW.status IN ('validating', 'failed', 'recovery_required'))
    OR (OLD.status = 'validating' AND NEW.status IN ('locking', 'failed', 'recovery_required'))
    OR (OLD.status = 'locking' AND NEW.status IN ('posting_adjustments', 'failed', 'recovery_required'))
    OR (OLD.status = 'posting_adjustments' AND NEW.status IN ('posting_closing_entry', 'failed', 'recovery_required'))
    OR (OLD.status = 'posting_closing_entry' AND NEW.status IN ('creating_next_period', 'failed', 'recovery_required'))
    OR (OLD.status = 'creating_next_period' AND NEW.status IN ('creating_opening_balance', 'failed', 'recovery_required'))
    OR (OLD.status = 'creating_opening_balance' AND NEW.status IN ('verifying_continuity', 'failed', 'recovery_required'))
    OR (OLD.status = 'verifying_continuity' AND NEW.status IN ('closing_period', 'failed', 'recovery_required'))
    OR (OLD.status = 'closing_period' AND NEW.status IN ('committing', 'failed', 'recovery_required'))
    OR (OLD.status = 'committing' AND NEW.status IN ('closed', 'failed', 'recovery_required'))
    OR (OLD.status = 'closing' AND NEW.status IN ('closed', 'failed', 'recovery_required'))
    OR (OLD.status = 'failed' AND NEW.status IN ('created', 'validating', 'recovery_required', 'superseded'))
    OR (OLD.status = 'recovery_required' AND NEW.status IN ('reopening', 'failed', 'superseded'))
    OR (OLD.status = 'closed' AND NEW.status = 'reopening')
    OR (OLD.status = 'reopening' AND NEW.status IN ('reopened', 'failed', 'recovery_required'))
    OR (OLD.status = 'reopened' AND NEW.status IN ('created', 'validating', 'superseded'))
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', MESSAGE = 'YE_INVALID_RUN_STATUS_TRANSITION',
      DETAIL = jsonb_build_object(
        'code', 'YE_UNKNOWN', 'from_status', OLD.status, 'to_status', NEW.status
      )::text;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_year_end_run_status_transition
  ON public.year_end_runs;
CREATE TRIGGER enforce_year_end_run_status_transition
  BEFORE UPDATE OF status ON public.year_end_runs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_year_end_run_status_transition();

DROP INDEX IF EXISTS public.year_end_runs_idempotency;
CREATE UNIQUE INDEX year_end_runs_idempotency
  ON public.year_end_runs (company_id, fiscal_period_id, idempotency_key)
  WHERE status IN (
    'created', 'validating', 'locking', 'posting_adjustments',
    'posting_closing_entry', 'creating_next_period',
    'creating_opening_balance', 'verifying_continuity', 'closing_period',
    'committing', 'closing', 'closed'
  );
CREATE INDEX IF NOT EXISTS idx_year_end_runs_correlation_id
  ON public.year_end_runs (correlation_id)
  WHERE correlation_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_updated_at_year_end_runs ON public.year_end_runs;
CREATE TRIGGER set_updated_at_year_end_runs
  BEFORE UPDATE ON public.year_end_runs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- All canonical year-end RPCs are server-only. Actor attribution and access
-- are still revalidated in PostgreSQL; service_role is not treated as user
-- authorization by itself.
CREATE OR REPLACE FUNCTION public.__year_end_assert_actor(
  p_company_id uuid,
  p_user_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text := coalesce(auth.role(), current_user::text);
  v_access record;
BEGIN
  IF v_role NOT IN ('service_role', 'postgres')
     AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501', MESSAGE = 'YE_PERMISSION_DENIED',
      DETAIL = jsonb_build_object('code', 'YE_PERMISSION_DENIED')::text;
  END IF;
  IF p_user_id IS NULL OR p_company_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501', MESSAGE = 'YE_PERMISSION_DENIED',
      DETAIL = jsonb_build_object('code', 'YE_PERMISSION_DENIED')::text;
  END IF;

  SELECT access.* INTO v_access
  FROM public.resolve_company_access_for_user(p_user_id, p_company_id) access
  LIMIT 1;
  IF NOT FOUND OR NOT coalesce(v_access.can_read, false)
     OR NOT coalesce(v_access.can_write, false) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501', MESSAGE = 'YE_PERMISSION_DENIED',
      DETAIL = jsonb_build_object('code', 'YE_PERMISSION_DENIED')::text;
  END IF;
  RETURN p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.__year_end_assert_actor(uuid, uuid)
  FROM PUBLIC, anon, authenticated;

-- Replace the private atomic core. The wrapper below owns preview and staged
-- adjustment handling; this core owns the final close, next period and IB.
CREATE OR REPLACE FUNCTION public.__execute_year_end_closing_preview_core_20260730(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_user_id uuid,
  p_idempotency_key text,
  p_revaluation jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period public.fiscal_periods%ROWTYPE;
  v_next_period public.fiscal_periods%ROWTYPE;
  v_existing_run public.year_end_runs%ROWTYPE;
  v_blocker record;
  v_blockers text[] := '{}';
  v_entity_type text;
  v_closing_account text;
  v_closing_account_name text;
  v_reval_result jsonb;
  v_reval_run record;
  v_closing_lines jsonb;
  v_closing_entry_id uuid;
  v_ob_lines jsonb;
  v_ob_entry_id uuid;
  v_existing_ob_id uuid;
  v_existing_ob_count integer := 0;
  v_opening_balance_created boolean := false;
  v_next_period_created boolean := false;
  v_reversal_entry_id uuid;
  v_reversal_lines jsonb;
  v_run_id uuid;
  v_result_net numeric;
  v_fx_exposure integer;
  v_diff_count integer;
BEGIN
  IF p_user_id IS NULL
     OR NOT public.__year_end_actor_can_write(
       p_user_id, p_company_id, p_fiscal_period_id
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501', MESSAGE = 'YE_PERMISSION_DENIED',
      DETAIL = jsonb_build_object('code', 'YE_PERMISSION_DENIED')::text;
  END IF;
  IF coalesce(btrim(p_idempotency_key), '') = '' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023', MESSAGE = 'YE_IDEMPOTENCY_REQUIRED',
      DETAIL = jsonb_build_object('code', 'YE_UNKNOWN')::text;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat_ws(':', 'year-end-execute', p_company_id, p_fiscal_period_id), 0
  ));

  SELECT run.* INTO v_existing_run
  FROM public.year_end_runs run
  WHERE run.company_id = p_company_id
    AND run.fiscal_period_id = p_fiscal_period_id
    AND run.status = 'closed'
  ORDER BY run.created_at DESC
  LIMIT 1;
  IF FOUND THEN
    IF v_existing_run.idempotency_key = p_idempotency_key THEN
      RETURN coalesce(v_existing_run.result_payload, '{}'::jsonb)
        || jsonb_build_object(
          'run_id', v_existing_run.id,
          'status', 'closed',
          'closing_entry_id', v_existing_run.closing_entry_id,
          'opening_balance_entry_id', v_existing_run.opening_balance_entry_id,
          'opening_balance_created', coalesce(v_existing_run.opening_balance_created, false),
          'next_period_id', v_existing_run.next_period_id,
          'next_period_created', coalesce(v_existing_run.next_period_created, false),
          'revaluation_entry_id', v_existing_run.revaluation_entry_id,
          'revaluation_reversal_entry_id', v_existing_run.revaluation_reversal_entry_id,
          'idempotent', true
        );
    END IF;
    RAISE EXCEPTION USING
      ERRCODE = '55000', MESSAGE = 'YE_ALREADY_CLOSED',
      DETAIL = jsonb_build_object('code', 'YE_ALREADY_CLOSED')::text;
  END IF;

  SELECT fp.* INTO v_period
  FROM public.fiscal_periods fp
  WHERE fp.id = p_fiscal_period_id AND fp.company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023', MESSAGE = 'YE_PERIOD_NOT_FOUND',
      DETAIL = jsonb_build_object('code', 'YE_PERIOD_NOT_FOUND')::text;
  END IF;
  IF v_period.is_closed AND v_period.closing_entry_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000', MESSAGE = 'YE_ALREADY_CLOSED',
      DETAIL = jsonb_build_object('code', 'YE_ALREADY_CLOSED')::text;
  ELSIF v_period.closing_entry_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000', MESSAGE = 'YE_DUPLICATE_CLOSING_ENTRY',
      DETAIL = jsonb_build_object(
        'code', 'YE_DUPLICATE_CLOSING_ENTRY',
        'state', 'closing_entry_without_closed_period'
      )::text;
  ELSIF v_period.is_closed OR v_period.locked_at IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000', MESSAGE = 'YE_RESULT_INVALID',
      DETAIL = jsonb_build_object(
        'code', 'YE_RESULT_INVALID',
        'state', 'closed_or_locked_without_closing_entry'
      )::text;
  END IF;

  FOR v_blocker IN
    SELECT * FROM public.year_end_db_blockers(p_company_id, p_fiscal_period_id)
  LOOP
    v_blockers := array_append(v_blockers, v_blocker.code);
  END LOOP;
  IF cardinality(v_blockers) > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000', MESSAGE = 'YE_NOT_READY',
      DETAIL = jsonb_build_object(
        'code', 'YE_NOT_READY', 'blockers', to_jsonb(v_blockers)
      )::text;
  END IF;

  INSERT INTO public.year_end_runs (
    company_id, fiscal_period_id, status, current_step, idempotency_key,
    created_by, retryable, recovery_required
  ) VALUES (
    p_company_id, p_fiscal_period_id, 'created', 'created',
    p_idempotency_key, p_user_id, false, false
  ) RETURNING id INTO v_run_id;

  UPDATE public.year_end_runs
  SET status = 'validating', current_step = 'validating'
  WHERE id = v_run_id;

  SELECT c.entity_type INTO v_entity_type
  FROM public.companies c WHERE c.id = p_company_id;
  IF v_entity_type IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000', MESSAGE = 'YE_ENTITY_TYPE_MISSING',
      DETAIL = jsonb_build_object('code', 'YE_ENTITY_TYPE_MISSING')::text;
  END IF;
  IF v_entity_type = 'enskild_firma' THEN
    v_closing_account := '2010';
    v_closing_account_name := 'Eget kapital';
  ELSE
    v_closing_account := '2099';
    v_closing_account_name := 'Årets resultat';
  END IF;

  UPDATE public.year_end_runs
  SET status = 'locking', current_step = 'locking'
  WHERE id = v_run_id;

  UPDATE public.year_end_runs
  SET status = 'posting_adjustments', current_step = 'posting_adjustments'
  WHERE id = v_run_id;

  IF p_revaluation IS NOT NULL THEN
    v_reval_result := public.post_currency_revaluation(
      p_company_id, p_fiscal_period_id, p_user_id,
      coalesce((p_revaluation->>'balance_date')::date, v_period.period_end),
      p_revaluation->>'snapshot_key',
      coalesce(p_revaluation->'lines', '[]'::jsonb),
      coalesce(p_revaluation->'items', '[]'::jsonb)
    );
  ELSE
    SELECT count(*)::integer INTO v_fx_exposure FROM (
      SELECT i.id FROM public.invoices i
      WHERE i.company_id = p_company_id AND i.currency <> 'SEK'
        AND i.status IN (
          'sent', 'partially_paid', 'overdue', 'disputed', 'collection_ready'
        )
      UNION ALL
      SELECT si.id FROM public.supplier_invoices si
      WHERE si.company_id = p_company_id AND si.currency <> 'SEK'
        AND si.status IN ('registered', 'approved', 'overdue', 'partially_paid')
    ) exposure;
    IF v_fx_exposure > 0 AND NOT EXISTS (
      SELECT 1 FROM public.currency_revaluation_runs fx
      WHERE fx.company_id = p_company_id
        AND fx.fiscal_period_id = p_fiscal_period_id
        AND fx.status = 'posted'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000', MESSAGE = 'YE_NOT_READY',
        DETAIL = jsonb_build_object(
          'code', 'YE_NOT_READY', 'blocker', 'fx_revaluation'
        )::text;
    END IF;
  END IF;

  SELECT fx.* INTO v_reval_run
  FROM public.currency_revaluation_runs fx
  WHERE fx.company_id = p_company_id
    AND fx.fiscal_period_id = p_fiscal_period_id
    AND fx.status = 'posted';

  UPDATE public.year_end_runs
  SET status = 'posting_closing_entry', current_step = 'posting_closing_entry'
  WHERE id = v_run_id;

  SELECT jsonb_agg(jsonb_build_object(
    'account_number', balance.account_number,
    'debit_amount', CASE WHEN balance.net < 0 THEN round(-balance.net, 2) ELSE 0 END,
    'credit_amount', CASE WHEN balance.net > 0 THEN round(balance.net, 2) ELSE 0 END,
    'line_description', 'Nollställning resultatkonto'
  ) ORDER BY balance.account_number)
  INTO v_closing_lines
  FROM (
    SELECT line.account_number,
      round(sum(line.debit_amount - line.credit_amount), 2) AS net
    FROM public.journal_entry_lines line
    JOIN public.journal_entries entry ON entry.id = line.journal_entry_id
    WHERE entry.company_id = p_company_id
      AND entry.fiscal_period_id = p_fiscal_period_id
      AND entry.status IN ('posted', 'reversed')
      AND substring(line.account_number, 1, 1) IN ('3', '4', '5', '6', '7', '8')
    GROUP BY line.account_number
    HAVING abs(round(sum(line.debit_amount - line.credit_amount), 2)) >= 0.005
  ) balance;
  IF v_closing_lines IS NULL OR jsonb_array_length(v_closing_lines) = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000', MESSAGE = 'YE_NO_ACTIVITY',
      DETAIL = jsonb_build_object('code', 'YE_NO_ACTIVITY')::text;
  END IF;

  SELECT round(sum((line->>'debit_amount')::numeric)
    - sum((line->>'credit_amount')::numeric), 2)
  INTO v_result_net
  FROM jsonb_array_elements(v_closing_lines) line;
  IF abs(v_result_net) >= 0.005 THEN
    v_closing_lines := v_closing_lines || jsonb_build_array(jsonb_build_object(
      'account_number', v_closing_account,
      'debit_amount', CASE WHEN v_result_net < 0 THEN round(-v_result_net, 2) ELSE 0 END,
      'credit_amount', CASE WHEN v_result_net > 0 THEN round(v_result_net, 2) ELSE 0 END,
      'line_description', 'Årets resultat → ' || v_closing_account_name
    ));
  END IF;

  v_closing_entry_id := public.__ye_post_entry(
    p_company_id, p_user_id, p_fiscal_period_id, v_period.period_end,
    'Årsbokslut ' || v_period.name, 'year_end_closing', 'A', v_closing_lines
  );

  SELECT count(*)::integer INTO v_diff_count
  FROM (
    SELECT line.account_number
    FROM public.journal_entry_lines line
    JOIN public.journal_entries entry ON entry.id = line.journal_entry_id
    WHERE entry.company_id = p_company_id
      AND entry.fiscal_period_id = p_fiscal_period_id
      AND entry.status IN ('posted', 'reversed')
      AND substring(line.account_number, 1, 1) IN ('3', '4', '5', '6', '7', '8')
    GROUP BY line.account_number
    HAVING abs(round(sum(line.debit_amount - line.credit_amount), 2)) > 0.005
  ) remaining;
  IF v_diff_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', MESSAGE = 'YE_CLOSING_INVARIANT',
      DETAIL = jsonb_build_object(
        'code', 'YE_CLOSING_INVARIANT', 'account_count', v_diff_count
      )::text;
  END IF;

  UPDATE public.year_end_runs
  SET status = 'creating_next_period', current_step = 'creating_next_period',
      closing_entry_id = v_closing_entry_id
  WHERE id = v_run_id;

  SELECT next_period.* INTO v_next_period
  FROM public.fiscal_periods next_period
  WHERE next_period.company_id = p_company_id
    AND next_period.period_start = v_period.period_end + 1
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1 FROM public.fiscal_periods future
      WHERE future.company_id = p_company_id
        AND future.period_start > v_period.period_end
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000', MESSAGE = 'YE_NEXT_PERIOD_NOT_CONTIGUOUS',
        DETAIL = jsonb_build_object('code', 'YE_NEXT_PERIOD_NOT_CONTIGUOUS')::text;
    END IF;
    INSERT INTO public.fiscal_periods (
      company_id, user_id, name, period_start, period_end, previous_period_id
    ) VALUES (
      p_company_id, p_user_id,
      to_char(v_period.period_end + 1, 'YYYY'),
      v_period.period_end + 1,
      ((v_period.period_end + 1) + interval '1 year' - interval '1 day')::date,
      p_fiscal_period_id
    ) RETURNING * INTO v_next_period;
    v_next_period_created := true;
  ELSIF v_next_period.previous_period_id IS NOT NULL
        AND v_next_period.previous_period_id <> p_fiscal_period_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000', MESSAGE = 'YE_NEXT_PERIOD_NOT_CONTIGUOUS',
      DETAIL = jsonb_build_object('code', 'YE_NEXT_PERIOD_NOT_CONTIGUOUS')::text;
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
    'account_number', balance.account_number,
    'debit_amount', CASE WHEN balance.net > 0 THEN round(balance.net, 2) ELSE 0 END,
    'credit_amount', CASE WHEN balance.net < 0 THEN round(-balance.net, 2) ELSE 0 END,
    'line_description', 'Ingående balans'
  ) ORDER BY balance.account_number)
  INTO v_ob_lines
  FROM (
    SELECT line.account_number,
      round(sum(line.debit_amount - line.credit_amount), 2) AS net
    FROM public.journal_entry_lines line
    JOIN public.journal_entries entry ON entry.id = line.journal_entry_id
    WHERE entry.company_id = p_company_id
      AND entry.fiscal_period_id = p_fiscal_period_id
      AND entry.status IN ('posted', 'reversed')
      AND substring(line.account_number, 1, 1) IN ('1', '2')
    GROUP BY line.account_number
    HAVING abs(round(sum(line.debit_amount - line.credit_amount), 2)) >= 0.005
  ) balance;
  IF v_ob_lines IS NULL OR jsonb_array_length(v_ob_lines) = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000', MESSAGE = 'YE_NO_BALANCE_SHEET',
      DETAIL = jsonb_build_object('code', 'YE_NO_BALANCE_SHEET')::text;
  END IF;

  UPDATE public.year_end_runs
  SET status = 'creating_opening_balance', current_step = 'creating_opening_balance',
      next_period_id = v_next_period.id,
      next_period_created = v_next_period_created
  WHERE id = v_run_id;

  SELECT count(*)::integer, min(entry.id::text)::uuid
  INTO v_existing_ob_count, v_existing_ob_id
  FROM public.journal_entries entry
  WHERE entry.company_id = p_company_id
    AND entry.fiscal_period_id = v_next_period.id
    AND entry.source_type = 'opening_balance'
    AND entry.status = 'posted';

  IF v_existing_ob_count > 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000', MESSAGE = 'YE_NEXT_PERIOD_HAS_CONFLICTING_OB',
      DETAIL = jsonb_build_object(
        'code', 'YE_NEXT_PERIOD_HAS_CONFLICTING_OB', 'opening_balance_count', v_existing_ob_count
      )::text;
  ELSIF v_existing_ob_count = 1 THEN
    IF v_next_period.opening_balance_entry_id IS NOT NULL
       AND v_next_period.opening_balance_entry_id <> v_existing_ob_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000', MESSAGE = 'YE_NEXT_PERIOD_HAS_CONFLICTING_OB',
        DETAIL = jsonb_build_object('code', 'YE_NEXT_PERIOD_HAS_CONFLICTING_OB')::text;
    END IF;
    WITH expected AS (
      SELECT item->>'account_number' AS account_number,
        round(coalesce((item->>'debit_amount')::numeric, 0)
          - coalesce((item->>'credit_amount')::numeric, 0), 2) AS net
      FROM jsonb_array_elements(v_ob_lines) item
    ), actual AS (
      SELECT line.account_number,
        round(sum(line.debit_amount - line.credit_amount), 2) AS net
      FROM public.journal_entry_lines line
      WHERE line.journal_entry_id = v_existing_ob_id
      GROUP BY line.account_number
    )
    SELECT count(*)::integer INTO v_diff_count
    FROM expected FULL OUTER JOIN actual USING (account_number)
    WHERE abs(coalesce(expected.net, 0) - coalesce(actual.net, 0)) > 0.005;
    IF v_diff_count > 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000', MESSAGE = 'YE_NEXT_PERIOD_HAS_CONFLICTING_OB',
        DETAIL = jsonb_build_object(
          'code', 'YE_NEXT_PERIOD_HAS_CONFLICTING_OB', 'account_count', v_diff_count
        )::text;
    END IF;
    v_ob_entry_id := v_existing_ob_id;
  ELSE
    IF v_next_period.opening_balance_entry_id IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000', MESSAGE = 'YE_NEXT_PERIOD_HAS_CONFLICTING_OB',
        DETAIL = jsonb_build_object('code', 'YE_NEXT_PERIOD_HAS_CONFLICTING_OB')::text;
    END IF;
    v_ob_entry_id := public.__ye_post_entry(
      p_company_id, p_user_id, v_next_period.id, v_next_period.period_start,
      'Ingående balans ' || v_next_period.name, 'opening_balance', 'A', v_ob_lines
    );
    v_opening_balance_created := true;
  END IF;

  IF v_reval_run.id IS NOT NULL AND v_reval_run.entry_id IS NOT NULL
     AND v_reval_run.reversal_entry_id IS NULL THEN
    SELECT jsonb_agg(jsonb_build_object(
      'account_number', line.account_number,
      'debit_amount', line.credit_amount,
      'credit_amount', line.debit_amount,
      'line_description', 'Återföring orealiserad valutadifferens'
    ) ORDER BY line.sort_order, line.id)
    INTO v_reversal_lines
    FROM public.journal_entry_lines line
    WHERE line.journal_entry_id = v_reval_run.entry_id;
    v_reversal_entry_id := public.__ye_post_entry(
      p_company_id, p_user_id, v_next_period.id, v_next_period.period_start,
      'Återföring valutaomvärdering per ' || v_reval_run.balance_date::text,
      'currency_revaluation_reversal', 'A', v_reversal_lines
    );
    UPDATE public.currency_revaluation_runs
    SET reversal_entry_id = v_reversal_entry_id, updated_at = now()
    WHERE id = v_reval_run.id;
  END IF;

  UPDATE public.year_end_runs
  SET status = 'verifying_continuity', current_step = 'verifying_continuity',
      opening_balance_entry_id = v_ob_entry_id,
      opening_balance_created = v_opening_balance_created
  WHERE id = v_run_id;

  WITH ub AS (
    SELECT line.account_number,
      round(sum(line.debit_amount - line.credit_amount), 2) AS net
    FROM public.journal_entry_lines line
    JOIN public.journal_entries entry ON entry.id = line.journal_entry_id
    WHERE entry.company_id = p_company_id
      AND entry.fiscal_period_id = p_fiscal_period_id
      AND entry.status IN ('posted', 'reversed')
      AND substring(line.account_number, 1, 1) IN ('1', '2')
    GROUP BY line.account_number
  ), ib AS (
    SELECT line.account_number,
      round(sum(line.debit_amount - line.credit_amount), 2) AS net
    FROM public.journal_entry_lines line
    WHERE line.journal_entry_id = v_ob_entry_id
    GROUP BY line.account_number
  )
  SELECT count(*)::integer INTO v_diff_count
  FROM ub FULL OUTER JOIN ib USING (account_number)
  WHERE abs(coalesce(ub.net, 0) - coalesce(ib.net, 0)) > 0.005;
  IF v_diff_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', MESSAGE = 'YE_CONTINUITY_FAILED',
      DETAIL = jsonb_build_object(
        'code', 'YE_CONTINUITY_FAILED', 'account_count', v_diff_count
      )::text;
  END IF;

  UPDATE public.fiscal_periods
  SET opening_balance_entry_id = v_ob_entry_id,
      opening_balances_set = true,
      previous_period_id = p_fiscal_period_id,
      continuity_verified = true
  WHERE id = v_next_period.id AND company_id = p_company_id;

  UPDATE public.year_end_runs
  SET status = 'closing_period', current_step = 'closing_period'
  WHERE id = v_run_id;
  UPDATE public.fiscal_periods
  SET closing_entry_id = v_closing_entry_id,
      locked_at = now(), is_closed = true, closed_at = now()
  WHERE id = p_fiscal_period_id AND company_id = p_company_id;

  UPDATE public.year_end_runs
  SET status = 'committing', current_step = 'committing',
      closing_entry_id = v_closing_entry_id,
      opening_balance_entry_id = v_ob_entry_id,
      opening_balance_created = v_opening_balance_created,
      revaluation_entry_id = v_reval_run.entry_id,
      revaluation_reversal_entry_id = v_reversal_entry_id,
      next_period_id = v_next_period.id,
      next_period_created = v_next_period_created
  WHERE id = v_run_id;

  UPDATE public.year_end_runs
  SET status = 'closed', current_step = 'closed',
      committed_at = now(), finished_at = now()
  WHERE id = v_run_id;

  RETURN jsonb_build_object(
    'run_id', v_run_id,
    'status', 'closed',
    'closing_entry_id', v_closing_entry_id,
    'opening_balance_entry_id', v_ob_entry_id,
    'opening_balance_created', v_opening_balance_created,
    'next_period_id', v_next_period.id,
    'next_period_created', v_next_period_created,
    'revaluation_entry_id', v_reval_run.entry_id,
    'revaluation_reversal_entry_id', v_reversal_entry_id,
    'idempotent', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.__execute_year_end_closing_preview_core_20260730(
  uuid, uuid, uuid, text, jsonb
) FROM PUBLIC, anon, authenticated, service_role;

-- Public name, server-only signature. p_correlation_id becomes part of the
-- committed run/result and is therefore always searchable after a response.
DROP FUNCTION IF EXISTS public.execute_year_end_closing(
  uuid, uuid, uuid, text, jsonb, uuid
);
CREATE FUNCTION public.execute_year_end_closing(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_user_id uuid,
  p_idempotency_key text,
  p_revaluation jsonb,
  p_preview_id uuid,
  p_correlation_id text DEFAULT NULL
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
BEGIN
  v_actor := public.__year_end_assert_actor(p_company_id, p_user_id);
  IF coalesce(btrim(p_idempotency_key), '') = '' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023', MESSAGE = 'YE_IDEMPOTENCY_REQUIRED',
      DETAIL = jsonb_build_object('code', 'YE_UNKNOWN')::text;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat_ws(':', 'year-end-execute', p_company_id, p_fiscal_period_id), 0
  ));

  SELECT run.* INTO v_existing_run
  FROM public.year_end_runs run
  WHERE run.company_id = p_company_id
    AND run.fiscal_period_id = p_fiscal_period_id
    AND run.idempotency_key = p_idempotency_key
    AND run.status = 'closed'
  ORDER BY run.created_at DESC LIMIT 1;
  IF FOUND THEN
    RETURN coalesce(v_existing_run.result_payload, '{}'::jsonb)
      || jsonb_build_object(
        'run_id', v_existing_run.id,
        'status', 'closed',
        'closing_entry_id', v_existing_run.closing_entry_id,
        'opening_balance_entry_id', v_existing_run.opening_balance_entry_id,
        'opening_balance_created', coalesce(v_existing_run.opening_balance_created, false),
        'next_period_id', v_existing_run.next_period_id,
        'next_period_created', coalesce(v_existing_run.next_period_created, false),
        'revaluation_entry_id', v_existing_run.revaluation_entry_id,
        'revaluation_reversal_entry_id', v_existing_run.revaluation_reversal_entry_id,
        'preview_id', v_existing_run.preview_id,
        'correlation_id', v_existing_run.correlation_id,
        'ledger_hash', v_existing_run.ledger_hash,
        'readiness_hash', v_existing_run.readiness_hash,
        'adjustment_hash', v_existing_run.adjustment_hash,
        'ruleset_version', v_existing_run.ruleset_version,
        'idempotent', true
      );
  END IF;

  IF p_preview_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023', MESSAGE = 'YE_PREVIEW_NOT_FOUND',
      DETAIL = jsonb_build_object('code', 'YE_PREVIEW_NOT_FOUND')::text;
  END IF;
  SELECT preview.* INTO v_preview
  FROM public.year_end_previews preview
  WHERE preview.id = p_preview_id
    AND preview.company_id = p_company_id
    AND preview.fiscal_period_id = p_fiscal_period_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000', MESSAGE = 'YE_PREVIEW_NOT_FOUND',
      DETAIL = jsonb_build_object('code', 'YE_PREVIEW_NOT_FOUND')::text;
  END IF;
  IF v_preview.status = 'executed' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000', MESSAGE = 'YE_PREVIEW_ALREADY_EXECUTED',
      DETAIL = jsonb_build_object('code', 'YE_PREVIEW_ALREADY_EXECUTED')::text;
  END IF;
  IF v_preview.status <> 'active' OR v_preview.expires_at <= now() THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000', MESSAGE = 'YE_PREVIEW_STALE',
      DETAIL = jsonb_build_object('code', 'YE_PREVIEW_STALE')::text;
  END IF;
  IF v_preview.ledger_hash
       <> public.__year_end_ledger_hash(p_company_id, p_fiscal_period_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000', MESSAGE = 'YE_LEDGER_CHANGED',
      DETAIL = jsonb_build_object('code', 'YE_LEDGER_CHANGED')::text;
  END IF;
  IF v_preview.readiness_hash
       <> public.__year_end_readiness_hash(p_company_id, p_fiscal_period_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000', MESSAGE = 'YE_READINESS_CHANGED',
      DETAIL = jsonb_build_object('code', 'YE_READINESS_CHANGED')::text;
  END IF;
  IF v_preview.adjustment_hash
       <> public.__year_end_adjustment_hash(p_company_id, p_fiscal_period_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000', MESSAGE = 'YE_ADJUSTMENTS_CHANGED',
      DETAIL = jsonb_build_object('code', 'YE_ADJUSTMENTS_CHANGED')::text;
  END IF;

  FOR v_adjustment IN
    SELECT adjustment.*
    FROM public.year_end_staged_adjustments adjustment
    WHERE adjustment.company_id = p_company_id
      AND adjustment.fiscal_period_id = p_fiscal_period_id
      AND adjustment.status = 'included_in_preview'
    ORDER BY CASE adjustment.adjustment_group
      WHEN 'accrual' THEN 10 WHEN 'depreciation' THEN 20
      WHEN 'disposition' THEN 30 WHEN 'tax' THEN 40 ELSE 50
    END, adjustment.stable_key, adjustment.id
    FOR UPDATE
  LOOP
    v_entry_id := public.__ye_post_entry(
      p_company_id, v_actor, p_fiscal_period_id, v_adjustment.entry_date,
      v_adjustment.description,
      CASE
        WHEN v_adjustment.adjustment_group = 'accrual' THEN 'year_end_accrual'
        WHEN v_adjustment.adjustment_group = 'depreciation' THEN 'year_end_depreciation'
        WHEN v_adjustment.adjustment_kind IN ('bolagsskatt', 'sarskild_loneskatt')
          THEN 'year_end_tax_adjustment'
        WHEN v_adjustment.adjustment_kind = 'uppskjuten_skatt'
          THEN 'year_end_deferred_tax'
        ELSE 'year_end_disposition'
      END,
      'A', v_adjustment.journal_lines
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
        v_actor, p_company_id,
        (v_adjustment.calculation_payload->>'asset_id')::uuid,
        p_fiscal_period_id,
        (v_adjustment.calculation_payload->>'planned_depreciation')::numeric,
        v_entry_id, now()
      ) ON CONFLICT (asset_id, fiscal_period_id) DO UPDATE SET
        planned_depreciation = EXCLUDED.planned_depreciation,
        journal_entry_id = EXCLUDED.journal_entry_id,
        posted_at = EXCLUDED.posted_at;
    END IF;

    IF v_adjustment.reversal_date IS NOT NULL THEN
      SELECT jsonb_agg(jsonb_build_object(
        'account_number', line->>'account_number',
        'debit_amount', coalesce((line->>'credit_amount')::numeric, 0),
        'credit_amount', coalesce((line->>'debit_amount')::numeric, 0),
        'line_description', 'Återföring: '
          || coalesce(line->>'line_description', v_adjustment.description)
      )) INTO v_reversal_lines
      FROM jsonb_array_elements(v_adjustment.journal_lines) line;
      INSERT INTO public.year_end_scheduled_reversals (
        company_id, fiscal_period_id, adjustment_id, source_entry_id,
        reversal_date, reversal_lines, created_by
      ) VALUES (
        p_company_id, p_fiscal_period_id, v_adjustment.id, v_entry_id,
        v_adjustment.reversal_date, v_reversal_lines, v_actor
      ) ON CONFLICT (adjustment_id) DO NOTHING;
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
    'status', 'closed',
    'preview_id', p_preview_id,
    'correlation_id', nullif(p_correlation_id, ''),
    'ledger_hash', v_preview.ledger_hash,
    'readiness_hash', v_preview.readiness_hash,
    'adjustment_hash', v_preview.adjustment_hash,
    'ruleset_version', v_preview.ruleset_version
  );
  UPDATE public.year_end_runs
  SET preview_id = p_preview_id,
      correlation_id = nullif(p_correlation_id, ''),
      ledger_hash = v_preview.ledger_hash,
      readiness_hash = v_preview.readiness_hash,
      adjustment_hash = v_preview.adjustment_hash,
      ruleset_version = v_preview.ruleset_version,
      result_payload = v_result
  WHERE id = v_run_id
    AND company_id = p_company_id
    AND fiscal_period_id = p_fiscal_period_id;

  INSERT INTO public.audit_log (
    user_id, company_id, action, table_name, record_id, actor_id,
    new_state, description, actor_type, actor_label
  ) VALUES (
    v_actor, p_company_id, 'COMMIT', 'year_end_runs', v_run_id, v_actor,
    jsonb_build_object(
      'fiscal_period_id', p_fiscal_period_id,
      'preview_id', p_preview_id,
      'run_id', v_run_id,
      'correlation_id', nullif(p_correlation_id, ''),
      'idempotency_key', p_idempotency_key,
      'closing_entry_id', v_result->>'closing_entry_id',
      'next_period_id', v_result->>'next_period_id',
      'next_period_created', (v_result->>'next_period_created')::boolean,
      'opening_balance_entry_id', v_result->>'opening_balance_entry_id',
      'opening_balance_created', (v_result->>'opening_balance_created')::boolean,
      'ledger_hash', v_preview.ledger_hash,
      'readiness_hash', v_preview.readiness_hash,
      'adjustment_hash', v_preview.adjustment_hash,
      'ruleset_version', v_preview.ruleset_version,
      'before_status', 'open',
      'after_status', 'closed',
      'committed_at', now()
    ),
    'Atomic year-end close committed', 'user', NULL
  );

  INSERT INTO public.year_end_outbox (
    company_id, fiscal_period_id, year_end_run_id, event_type, payload,
    next_attempt_at
  ) VALUES (
    p_company_id, p_fiscal_period_id, v_run_id, 'period.year_closed',
    v_result, now()
  ) ON CONFLICT (year_end_run_id, event_type) DO NOTHING;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.execute_year_end_closing(
  uuid, uuid, uuid, text, jsonb, uuid, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.execute_year_end_closing(
  uuid, uuid, uuid, text, jsonb, uuid, text
) TO service_role;

DROP FUNCTION IF EXISTS public.record_year_end_failure(
  uuid, uuid, uuid, text, text, text, text, text, text, boolean
);
CREATE FUNCTION public.record_year_end_failure(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_actor_user_id uuid,
  p_idempotency_key text,
  p_current_step text,
  p_error_code text,
  p_technical_error text,
  p_user_message text,
  p_correlation_id text DEFAULT NULL,
  p_recovery_required boolean DEFAULT false,
  p_retryable boolean DEFAULT false
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_run_id uuid;
  v_retry_count integer;
BEGIN
  PERFORM public.__year_end_assert_actor(p_company_id, p_actor_user_id);
  IF NOT EXISTS (
    SELECT 1 FROM public.fiscal_periods fp
    WHERE fp.id = p_fiscal_period_id AND fp.company_id = p_company_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023', MESSAGE = 'YE_PERIOD_NOT_FOUND',
      DETAIL = jsonb_build_object('code', 'YE_PERIOD_NOT_FOUND')::text;
  END IF;
  SELECT count(*)::integer INTO v_retry_count
  FROM public.year_end_runs run
  WHERE run.company_id = p_company_id
    AND run.fiscal_period_id = p_fiscal_period_id
    AND run.idempotency_key = p_idempotency_key
    AND run.status IN ('failed', 'recovery_required');

  INSERT INTO public.year_end_runs (
    company_id, fiscal_period_id, status, idempotency_key,
    current_step, error_code, error_message, technical_error, user_message,
    correlation_id, created_by, finished_at, retryable, recovery_required,
    retry_count, last_retry_at
  ) VALUES (
    p_company_id, p_fiscal_period_id,
    CASE WHEN p_recovery_required THEN 'recovery_required' ELSE 'failed' END,
    p_idempotency_key, coalesce(p_current_step, 'executing'),
    left(coalesce(p_error_code, 'YE_UNKNOWN'), 120),
    left(coalesce(p_user_message, 'Bokslutet kunde inte verkställas.'), 2000),
    left(coalesce(p_technical_error, 'unknown'), 8000),
    left(coalesce(p_user_message, 'Bokslutet kunde inte verkställas.'), 2000),
    nullif(p_correlation_id, ''), p_actor_user_id, now(),
    p_retryable, p_recovery_required, v_retry_count,
    CASE WHEN v_retry_count > 0 THEN now() ELSE NULL END
  ) RETURNING id INTO v_run_id;

  INSERT INTO public.audit_log (
    user_id, company_id, action, table_name, record_id, actor_id,
    new_state, description, actor_type, actor_label
  ) VALUES (
    p_actor_user_id, p_company_id, 'INTEGRITY_FAILURE', 'year_end_runs',
    v_run_id, p_actor_user_id,
    jsonb_build_object(
      'fiscal_period_id', p_fiscal_period_id,
      'status', CASE WHEN p_recovery_required THEN 'recovery_required' ELSE 'failed' END,
      'error_code', p_error_code,
      'correlation_id', p_correlation_id,
      'retryable', p_retryable,
      'recovery_required', p_recovery_required,
      'retry_count', v_retry_count
    ),
    'Recorded failed year-end execution', 'user', NULL
  );
  RETURN v_run_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_year_end_failure(
  uuid, uuid, uuid, text, text, text, text, text, text, boolean, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_year_end_failure(
  uuid, uuid, uuid, text, text, text, text, text, text, boolean, boolean
) TO service_role;

-- These APIs are invoked only through authenticated server routes. Staging and
-- acknowledgement are not directly executable from a browser session.
REVOKE ALL ON FUNCTION public.stage_year_end_adjustments(
  uuid, uuid, uuid, text, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stage_year_end_adjustments(
  uuid, uuid, uuid, text, jsonb
) TO service_role;

REVOKE ALL ON FUNCTION public.create_year_end_preview(
  uuid, uuid, uuid, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_year_end_preview(
  uuid, uuid, uuid, jsonb
) TO service_role;

CREATE OR REPLACE FUNCTION public.acknowledge_year_end_run(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_year_end_run_id uuid,
  p_user_id uuid,
  p_statement_version text,
  p_statement_text text,
  p_continuity_snapshot jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_id uuid;
BEGIN
  v_actor := public.__year_end_assert_actor(p_company_id, p_user_id);
  IF NOT EXISTS (
    SELECT 1 FROM public.year_end_runs run
    WHERE run.id = p_year_end_run_id
      AND run.company_id = p_company_id
      AND run.fiscal_period_id = p_fiscal_period_id
      AND run.status = 'closed'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000', MESSAGE = 'YE_RUN_NOT_COMMITTED',
      DETAIL = jsonb_build_object('code', 'YE_RUN_NOT_COMMITTED')::text;
  END IF;
  INSERT INTO public.year_end_run_acknowledgements (
    company_id, fiscal_period_id, year_end_run_id, statement_version,
    statement_text, continuity_snapshot, acknowledged_by
  ) VALUES (
    p_company_id, p_fiscal_period_id, p_year_end_run_id, p_statement_version,
    p_statement_text, p_continuity_snapshot, v_actor
  ) ON CONFLICT (year_end_run_id, acknowledged_by, statement_version)
  DO UPDATE SET
    statement_text = EXCLUDED.statement_text,
    continuity_snapshot = EXCLUDED.continuity_snapshot,
    acknowledged_at = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.acknowledge_year_end_run(
  uuid, uuid, uuid, uuid, text, text, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acknowledge_year_end_run(
  uuid, uuid, uuid, uuid, text, text, jsonb
) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
