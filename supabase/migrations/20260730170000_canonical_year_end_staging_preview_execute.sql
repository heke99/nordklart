-- Canonical staging -> persisted preview -> atomic execute chain for year-end.
--
-- This migration is deliberately forward-only. It does not alter any
-- previously deployed migration. Historical support ledgers remain
-- documentary; only approved staged adjustments are posted, and only inside
-- the same transaction that closes the fiscal period.

CREATE TABLE public.year_end_rulesets (
  tax_year                  integer PRIMARY KEY,
  version                   text NOT NULL UNIQUE,
  corporate_tax_rate       numeric(9,6) NOT NULL CHECK (corporate_tax_rate BETWEEN 0 AND 1),
  slp_rate                  numeric(9,6) NOT NULL CHECK (slp_rate BETWEEN 0 AND 1),
  periodiseringsfond_rate   numeric(9,6) NOT NULL CHECK (periodiseringsfond_rate BETWEEN 0 AND 1),
  schablonintakt_rate       numeric(9,6) NOT NULL CHECK (schablonintakt_rate >= 0),
  effective_from            date NOT NULL,
  effective_to              date,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

INSERT INTO public.year_end_rulesets (
  tax_year, version, corporate_tax_rate, slp_rate,
  periodiseringsfond_rate, schablonintakt_rate, effective_from, effective_to
) VALUES
  (2025, 'se-ab-2025.1', 0.206, 0.2426, 0.25, 0.0296, '2025-01-01', '2025-12-31'),
  (2026, 'se-ab-2026.1', 0.206, 0.2426, 0.25, 0.0355, '2026-01-01', '2026-12-31')
ON CONFLICT (tax_year) DO UPDATE SET
  version = EXCLUDED.version,
  corporate_tax_rate = EXCLUDED.corporate_tax_rate,
  slp_rate = EXCLUDED.slp_rate,
  periodiseringsfond_rate = EXCLUDED.periodiseringsfond_rate,
  schablonintakt_rate = EXCLUDED.schablonintakt_rate,
  effective_from = EXCLUDED.effective_from,
  effective_to = EXCLUDED.effective_to;

ALTER TABLE public.year_end_rulesets ENABLE ROW LEVEL SECURITY;
CREATE POLICY year_end_rulesets_select
  ON public.year_end_rulesets FOR SELECT TO authenticated USING (true);

CREATE TABLE public.year_end_staged_adjustments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id      uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE RESTRICT,
  adjustment_group      text NOT NULL CHECK (adjustment_group IN (
    'accrual', 'disposition', 'depreciation', 'tax', 'other'
  )),
  adjustment_kind       text NOT NULL,
  stable_key            text NOT NULL,
  description           text NOT NULL CHECK (length(btrim(description)) > 0),
  entry_date             date NOT NULL,
  reversal_date          date,
  journal_lines          jsonb NOT NULL CHECK (
    jsonb_typeof(journal_lines) = 'array' AND jsonb_array_length(journal_lines) >= 2
  ),
  calculation_payload   jsonb NOT NULL DEFAULT '{}'::jsonb,
  ruleset_version       text,
  status                text NOT NULL DEFAULT 'approved' CHECK (status IN (
    'draft', 'approved', 'included_in_preview', 'posted', 'reversed', 'cancelled'
  )),
  version               integer NOT NULL DEFAULT 1 CHECK (version > 0),
  idempotency_key       text NOT NULL,
  posted_entry_id       uuid REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  created_by            uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  updated_by            uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, fiscal_period_id, idempotency_key)
);

CREATE UNIQUE INDEX year_end_staged_adjustments_active_key
  ON public.year_end_staged_adjustments (
    company_id, fiscal_period_id, adjustment_group, stable_key
  )
  WHERE status IN ('draft', 'approved', 'included_in_preview');
CREATE INDEX year_end_staged_adjustments_period
  ON public.year_end_staged_adjustments (company_id, fiscal_period_id, status);

ALTER TABLE public.year_end_staged_adjustments ENABLE ROW LEVEL SECURITY;
CREATE POLICY year_end_staged_adjustments_select
  ON public.year_end_staged_adjustments FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE TABLE public.year_end_previews (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id      uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE RESTRICT,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN (
    'active', 'stale', 'executed', 'expired', 'superseded'
  )),
  ledger_hash           text NOT NULL,
  readiness_hash        text NOT NULL,
  adjustment_hash       text NOT NULL,
  ruleset_version       text NOT NULL,
  payload               jsonb NOT NULL,
  generated_by          uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  generated_at          timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL,
  executed_at           timestamptz,
  CHECK (expires_at > generated_at)
);

CREATE UNIQUE INDEX year_end_previews_one_active
  ON public.year_end_previews (company_id, fiscal_period_id)
  WHERE status = 'active';
CREATE INDEX year_end_previews_period
  ON public.year_end_previews (company_id, fiscal_period_id, generated_at DESC);

ALTER TABLE public.year_end_previews ENABLE ROW LEVEL SECURITY;
CREATE POLICY year_end_previews_select
  ON public.year_end_previews FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE TABLE public.year_end_scheduled_reversals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id      uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE RESTRICT,
  adjustment_id         uuid NOT NULL REFERENCES public.year_end_staged_adjustments(id) ON DELETE RESTRICT,
  source_entry_id       uuid NOT NULL REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  reversal_date         date NOT NULL,
  reversal_lines        jsonb NOT NULL CHECK (
    jsonb_typeof(reversal_lines) = 'array' AND jsonb_array_length(reversal_lines) >= 2
  ),
  status                text NOT NULL DEFAULT 'scheduled' CHECK (status IN (
    'scheduled', 'posted', 'cancelled', 'failed'
  )),
  reversal_entry_id     uuid REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  created_by            uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (adjustment_id)
);

ALTER TABLE public.year_end_scheduled_reversals ENABLE ROW LEVEL SECURITY;
CREATE POLICY year_end_scheduled_reversals_select
  ON public.year_end_scheduled_reversals FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE TABLE public.year_end_run_acknowledgements (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id      uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE RESTRICT,
  year_end_run_id       uuid NOT NULL REFERENCES public.year_end_runs(id) ON DELETE RESTRICT,
  statement_version     text NOT NULL,
  statement_text        text NOT NULL,
  continuity_snapshot   jsonb NOT NULL,
  acknowledged_by       uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  acknowledged_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (year_end_run_id, acknowledged_by, statement_version)
);

ALTER TABLE public.year_end_run_acknowledgements ENABLE ROW LEVEL SECURITY;
CREATE POLICY year_end_run_acknowledgements_select
  ON public.year_end_run_acknowledgements FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE TABLE public.year_end_outbox (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id      uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE RESTRICT,
  year_end_run_id       uuid NOT NULL REFERENCES public.year_end_runs(id) ON DELETE RESTRICT,
  event_type            text NOT NULL,
  payload               jsonb NOT NULL,
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'processing', 'delivered', 'failed'
  )),
  attempt_count         integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at          timestamptz NOT NULL DEFAULT now(),
  last_error            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  delivered_at          timestamptz,
  UNIQUE (year_end_run_id, event_type)
);

ALTER TABLE public.year_end_outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY year_end_outbox_select
  ON public.year_end_outbox FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

ALTER TABLE public.year_end_runs
  ADD COLUMN IF NOT EXISTS preview_id uuid REFERENCES public.year_end_previews(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS ledger_hash text,
  ADD COLUMN IF NOT EXISTS readiness_hash text,
  ADD COLUMN IF NOT EXISTS adjustment_hash text,
  ADD COLUMN IF NOT EXISTS ruleset_version text,
  ADD COLUMN IF NOT EXISTS committed_at timestamptz,
  ADD COLUMN IF NOT EXISTS result_payload jsonb;

CREATE OR REPLACE FUNCTION public.__year_end_assert_actor(
  p_company_id uuid,
  p_user_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_role text := coalesce(auth.role(), current_user::text);
BEGIN
  IF v_actor IS NOT NULL THEN
    IF NOT public.user_can_write_company(p_company_id) THEN
      RAISE EXCEPTION 'YE_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    RETURN v_actor;
  END IF;
  IF v_role NOT IN ('service_role', 'postgres')
     AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'YE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'YE_ACTOR_REQUIRED' USING ERRCODE = '22023';
  END IF;
  RETURN p_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.__year_end_ledger_hash(
  p_company_id uuid,
  p_fiscal_period_id uuid
) RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT md5(concat_ws('|',
    p_company_id::text,
    p_fiscal_period_id::text,
    coalesce(string_agg(
      concat_ws(':', je.id::text, je.status, je.entry_date::text,
        je.voucher_series, je.voucher_number::text, jel.account_number,
        jel.debit_amount::text, jel.credit_amount::text),
      '|' ORDER BY je.id, jel.sort_order, jel.id
    ), 'empty')
  ))
  FROM public.journal_entries je
  LEFT JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
  WHERE je.company_id = p_company_id
    AND je.fiscal_period_id = p_fiscal_period_id
    AND je.status IN ('posted', 'reversed', 'draft');
$$;

CREATE OR REPLACE FUNCTION public.__year_end_readiness_hash(
  p_company_id uuid,
  p_fiscal_period_id uuid
) RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT md5(coalesce(string_agg(
    concat_ws(':', b.code, b.detail_count::text, b.message),
    '|' ORDER BY b.code, b.message
  ), 'ready'))
  FROM public.year_end_db_blockers(p_company_id, p_fiscal_period_id) b;
$$;

CREATE OR REPLACE FUNCTION public.__year_end_adjustment_hash(
  p_company_id uuid,
  p_fiscal_period_id uuid
) RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT md5(coalesce(string_agg(
    -- approved and included_in_preview describe the same immutable adjustment
    -- lifecycle for snapshot purposes. Excluding status keeps the preview hash
    -- stable when create_year_end_preview marks its rows as included.
    concat_ws(':', a.id::text, a.version::text, a.stable_key,
      a.entry_date::text, coalesce(a.reversal_date::text, ''),
      a.journal_lines::text, a.ruleset_version),
    '|' ORDER BY a.adjustment_group, a.stable_key, a.id
  ), 'empty'))
  FROM public.year_end_staged_adjustments a
  WHERE a.company_id = p_company_id
    AND a.fiscal_period_id = p_fiscal_period_id
    AND a.status IN ('approved', 'included_in_preview');
$$;

CREATE OR REPLACE FUNCTION public.stage_year_end_adjustments(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_user_id uuid,
  p_adjustment_group text,
  p_items jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_period public.fiscal_periods%ROWTYPE;
  v_item jsonb;
  v_line jsonb;
  v_debit numeric;
  v_credit numeric;
  v_id uuid;
  v_ids uuid[] := '{}';
BEGIN
  v_actor := public.__year_end_assert_actor(p_company_id, p_user_id);
  IF p_adjustment_group NOT IN ('accrual', 'disposition', 'depreciation', 'tax', 'other') THEN
    RAISE EXCEPTION 'YE_ADJUSTMENT_INVALID: invalid group' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'YE_ADJUSTMENT_INVALID: items must be an array' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat_ws(':', 'year-end-stage', p_company_id, p_fiscal_period_id, p_adjustment_group), 0
  ));
  SELECT fp.* INTO v_period
  FROM public.fiscal_periods fp
  WHERE fp.id = p_fiscal_period_id AND fp.company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'YE_PERIOD_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  IF v_period.is_closed OR v_period.locked_at IS NOT NULL OR v_period.closing_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'YE_PERIOD_ALREADY_CLOSED' USING ERRCODE = '55000';
  END IF;

  UPDATE public.year_end_staged_adjustments
  SET status = 'cancelled', updated_by = v_actor, updated_at = now(), version = version + 1
  WHERE company_id = p_company_id
    AND fiscal_period_id = p_fiscal_period_id
    AND adjustment_group = p_adjustment_group
    AND status IN ('draft', 'approved', 'included_in_preview');

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    IF coalesce(v_item->>'stable_key', '') = ''
       OR coalesce(v_item->>'adjustment_kind', '') = ''
       OR coalesce(v_item->>'description', '') = ''
       OR jsonb_typeof(v_item->'journal_lines') <> 'array'
       OR jsonb_array_length(v_item->'journal_lines') < 2 THEN
      RAISE EXCEPTION 'YE_ADJUSTMENT_INVALID: incomplete item' USING ERRCODE = '22023';
    END IF;

    v_debit := 0;
    v_credit := 0;
    FOR v_line IN SELECT value FROM jsonb_array_elements(v_item->'journal_lines')
    LOOP
      IF coalesce(v_line->>'account_number', '') !~ '^[0-9]{4}$'
         OR coalesce((v_line->>'debit_amount')::numeric, 0) < 0
         OR coalesce((v_line->>'credit_amount')::numeric, 0) < 0
         OR (
           coalesce((v_line->>'debit_amount')::numeric, 0) > 0
           AND coalesce((v_line->>'credit_amount')::numeric, 0) > 0
         ) THEN
        RAISE EXCEPTION 'YE_ADJUSTMENT_INVALID: invalid journal line' USING ERRCODE = '22023';
      END IF;
      v_debit := v_debit + coalesce((v_line->>'debit_amount')::numeric, 0);
      v_credit := v_credit + coalesce((v_line->>'credit_amount')::numeric, 0);
    END LOOP;
    IF abs(round(v_debit - v_credit, 2)) >= 0.005 OR round(v_debit, 2) <= 0 THEN
      RAISE EXCEPTION 'YE_ADJUSTMENT_INVALID: unbalanced or empty item' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.year_end_staged_adjustments (
      company_id, fiscal_period_id, adjustment_group, adjustment_kind,
      stable_key, description, entry_date, reversal_date, journal_lines,
      calculation_payload, ruleset_version, status, idempotency_key,
      created_by, updated_by
    ) VALUES (
      p_company_id, p_fiscal_period_id, p_adjustment_group,
      v_item->>'adjustment_kind', v_item->>'stable_key',
      v_item->>'description',
      coalesce(nullif(v_item->>'entry_date', '')::date, v_period.period_end),
      nullif(v_item->>'reversal_date', '')::date,
      v_item->'journal_lines',
      coalesce(v_item->'calculation_payload', '{}'::jsonb),
      nullif(v_item->>'ruleset_version', ''),
      'approved',
      coalesce(nullif(v_item->>'idempotency_key', ''),
        md5(concat_ws('|', p_company_id::text, p_fiscal_period_id::text,
          p_adjustment_group, v_item->>'stable_key', v_item::text))),
      v_actor, v_actor
    )
    RETURNING id INTO v_id;
    v_ids := array_append(v_ids, v_id);
  END LOOP;

  UPDATE public.year_end_previews
  SET status = 'stale'
  WHERE company_id = p_company_id
    AND fiscal_period_id = p_fiscal_period_id
    AND status = 'active';

  RETURN jsonb_build_object(
    'staged_ids', to_jsonb(v_ids),
    'count', cardinality(v_ids),
    'adjustment_hash', public.__year_end_adjustment_hash(p_company_id, p_fiscal_period_id)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.create_year_end_preview(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_user_id uuid,
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_period public.fiscal_periods%ROWTYPE;
  v_preview public.year_end_previews%ROWTYPE;
  v_ruleset text;
  v_blocker record;
BEGIN
  v_actor := public.__year_end_assert_actor(p_company_id, p_user_id);
  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat_ws(':', 'year-end-preview', p_company_id, p_fiscal_period_id), 0
  ));
  SELECT fp.* INTO v_period
  FROM public.fiscal_periods fp
  WHERE fp.id = p_fiscal_period_id AND fp.company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'YE_PERIOD_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  IF v_period.is_closed OR v_period.locked_at IS NOT NULL OR v_period.closing_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'YE_PERIOD_ALREADY_CLOSED' USING ERRCODE = '55000';
  END IF;
  FOR v_blocker IN
    SELECT * FROM public.year_end_db_blockers(p_company_id, p_fiscal_period_id)
  LOOP
    RAISE EXCEPTION 'YE_READINESS_BLOCKED: %', v_blocker.code USING ERRCODE = '55000';
  END LOOP;

  SELECT yr.version INTO v_ruleset
  FROM public.year_end_rulesets yr
  WHERE yr.tax_year = extract(year FROM v_period.period_end)::integer;
  IF v_ruleset IS NULL THEN
    RAISE EXCEPTION 'YE_RULESET_MISSING' USING ERRCODE = '55000';
  END IF;

  UPDATE public.year_end_previews
  SET status = 'superseded'
  WHERE company_id = p_company_id
    AND fiscal_period_id = p_fiscal_period_id
    AND status = 'active';

  INSERT INTO public.year_end_previews (
    company_id, fiscal_period_id, ledger_hash, readiness_hash,
    adjustment_hash, ruleset_version, payload, generated_by, expires_at
  ) VALUES (
    p_company_id, p_fiscal_period_id,
    public.__year_end_ledger_hash(p_company_id, p_fiscal_period_id),
    public.__year_end_readiness_hash(p_company_id, p_fiscal_period_id),
    public.__year_end_adjustment_hash(p_company_id, p_fiscal_period_id),
    v_ruleset, p_payload, v_actor, now() + interval '30 minutes'
  )
  RETURNING * INTO v_preview;

  UPDATE public.year_end_staged_adjustments
  SET status = 'included_in_preview', updated_by = v_actor, updated_at = now()
  WHERE company_id = p_company_id
    AND fiscal_period_id = p_fiscal_period_id
    AND status = 'approved';

  RETURN jsonb_build_object(
    'preview_id', v_preview.id,
    'ledger_hash', v_preview.ledger_hash,
    'readiness_hash', v_preview.readiness_hash,
    'adjustment_hash', v_preview.adjustment_hash,
    'ruleset_version', v_preview.ruleset_version,
    'generated_at', v_preview.generated_at,
    'expires_at', v_preview.expires_at,
    'payload', v_preview.payload
  );
END;
$$;

DO $$
BEGIN
  IF to_regprocedure(
    'public.__execute_year_end_closing_preview_core_20260730(uuid,uuid,uuid,text,jsonb)'
  ) IS NULL THEN
    ALTER FUNCTION public.execute_year_end_closing(uuid, uuid, uuid, text, jsonb)
      RENAME TO __execute_year_end_closing_preview_core_20260730;
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.__execute_year_end_closing_preview_core_20260730(
  uuid, uuid, uuid, text, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.__execute_year_end_closing_preview_core_20260730(
  uuid, uuid, uuid, text, jsonb
) TO service_role;

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
  v_entry_id uuid;
  v_reversal_lines jsonb;
  v_result jsonb;
  v_run_id uuid;
BEGIN
  v_actor := public.__year_end_assert_actor(p_company_id, p_user_id);
  IF p_preview_id IS NULL THEN
    RAISE EXCEPTION 'YE_PREVIEW_REQUIRED' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat_ws(':', 'year-end-execute', p_company_id, p_fiscal_period_id), 0
  ));

  SELECT yp.* INTO v_preview
  FROM public.year_end_previews yp
  WHERE yp.id = p_preview_id
    AND yp.company_id = p_company_id
    AND yp.fiscal_period_id = p_fiscal_period_id
  FOR UPDATE;
  IF NOT FOUND OR v_preview.status <> 'active' OR v_preview.expires_at <= now() THEN
    RAISE EXCEPTION 'YE_PREVIEW_STALE' USING ERRCODE = '55000';
  END IF;
  IF v_preview.ledger_hash <> public.__year_end_ledger_hash(p_company_id, p_fiscal_period_id)
     OR v_preview.readiness_hash <> public.__year_end_readiness_hash(p_company_id, p_fiscal_period_id)
     OR v_preview.adjustment_hash <> public.__year_end_adjustment_hash(p_company_id, p_fiscal_period_id) THEN
    UPDATE public.year_end_previews SET status = 'stale' WHERE id = p_preview_id;
    RAISE EXCEPTION 'YE_PREVIEW_STALE' USING ERRCODE = '55000';
  END IF;

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
      CASE WHEN v_adjustment.adjustment_group = 'accrual' THEN 'accrual' ELSE 'year_end' END,
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
        'line_description', 'Återföring: ' || coalesce(line->>'line_description', v_adjustment.description)
      ))
      INTO v_reversal_lines
      FROM jsonb_array_elements(v_adjustment.journal_lines) line;

      INSERT INTO public.year_end_scheduled_reversals (
        company_id, fiscal_period_id, adjustment_id, source_entry_id,
        reversal_date, reversal_lines, created_by
      ) VALUES (
        p_company_id, p_fiscal_period_id, v_adjustment.id, v_entry_id,
        v_adjustment.reversal_date, v_reversal_lines, v_actor
      );
    END IF;
  END LOOP;

  v_result := public.__execute_year_end_closing_preview_core_20260730(
    p_company_id, p_fiscal_period_id, v_actor, p_idempotency_key, p_revaluation
  );
  v_run_id := (v_result->>'run_id')::uuid;

  UPDATE public.year_end_previews
  SET status = 'executed', executed_at = now()
  WHERE id = p_preview_id;

  UPDATE public.year_end_runs
  SET preview_id = p_preview_id,
      ledger_hash = v_preview.ledger_hash,
      readiness_hash = v_preview.readiness_hash,
      adjustment_hash = v_preview.adjustment_hash,
      ruleset_version = v_preview.ruleset_version,
      committed_at = coalesce(committed_at, now()),
      result_payload = v_result
  WHERE id = v_run_id
    AND company_id = p_company_id
    AND fiscal_period_id = p_fiscal_period_id;

  INSERT INTO public.year_end_outbox (
    company_id, fiscal_period_id, year_end_run_id, event_type, payload
  ) VALUES (
    p_company_id, p_fiscal_period_id, v_run_id, 'period.year_closed',
    v_result || jsonb_build_object('preview_id', p_preview_id)
  )
  ON CONFLICT (year_end_run_id, event_type) DO NOTHING;

  RETURN v_result || jsonb_build_object(
    'preview_id', p_preview_id,
    'ledger_hash', v_preview.ledger_hash,
    'readiness_hash', v_preview.readiness_hash,
    'adjustment_hash', v_preview.adjustment_hash,
    'ruleset_version', v_preview.ruleset_version
  );
END;
$$;

REVOKE ALL ON FUNCTION public.execute_year_end_closing(
  uuid, uuid, uuid, text, jsonb, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.execute_year_end_closing(
  uuid, uuid, uuid, text, jsonb, uuid
) TO authenticated, service_role;

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
    SELECT 1 FROM public.year_end_runs r
    WHERE r.id = p_year_end_run_id
      AND r.company_id = p_company_id
      AND r.fiscal_period_id = p_fiscal_period_id
      AND r.status = 'closed'
  ) THEN
    RAISE EXCEPTION 'YE_RUN_NOT_COMMITTED' USING ERRCODE = '55000';
  END IF;
  INSERT INTO public.year_end_run_acknowledgements (
    company_id, fiscal_period_id, year_end_run_id, statement_version,
    statement_text, continuity_snapshot, acknowledged_by
  ) VALUES (
    p_company_id, p_fiscal_period_id, p_year_end_run_id, p_statement_version,
    p_statement_text, p_continuity_snapshot, v_actor
  )
  ON CONFLICT (year_end_run_id, acknowledged_by, statement_version)
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
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.acknowledge_year_end_run(
  uuid, uuid, uuid, uuid, text, text, jsonb
) TO authenticated, service_role;

-- Exact SIE precedence: a historical workpaper may suppress the legacy AR/AP
-- mismatch only when its import and ledger snapshot exactly match this period.
CREATE OR REPLACE FUNCTION public.year_end_db_blockers(
  p_company_id uuid,
  p_fiscal_period_id uuid
) RETURNS TABLE (code text, message text, detail_count integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period public.fiscal_periods%ROWTYPE;
  v_count integer;
  v_control record;
BEGIN
  SELECT fp.* INTO v_period
  FROM public.fiscal_periods fp
  WHERE fp.id = p_fiscal_period_id AND fp.company_id = p_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'YE_PERIOD_NOT_FOUND';
  END IF;

  RETURN QUERY
  SELECT core.code, core.message, core.detail_count
  FROM public.__year_end_db_blockers_historical_core_20260729(
    p_company_id, p_fiscal_period_id
  ) core
  WHERE core.code <> 'unfinished_sie_imports'
    AND NOT (
      core.code IN ('accounts_receivable_mismatch', 'accounts_payable_mismatch')
      AND EXISTS (
        SELECT 1
        FROM public.year_end_historical_workpapers wp
        JOIN public.sie_imports si
          ON si.id = wp.source_sie_import_id
         AND si.company_id = wp.company_id
         AND si.status = 'completed'
        CROSS JOIN LATERAL public.__year_end_workpaper_category_snapshot(
          p_company_id,
          p_fiscal_period_id,
          CASE core.code
            WHEN 'accounts_receivable_mismatch' THEN 'customer_receivables'
            ELSE 'supplier_payables'
          END
        ) snapshot
        WHERE wp.company_id = p_company_id
          AND wp.fiscal_period_id = p_fiscal_period_id
          AND wp.category = CASE core.code
            WHEN 'accounts_receivable_mismatch' THEN 'customer_receivables'
            ELSE 'supplier_payables'
          END
          AND wp.status IN (
            'automatically_reconciled', 'sie_balance_accepted',
            'external_evidence_verified', 'manually_adjusted'
          )
          AND wp.pending_sie_import_id IS NULL
          AND wp.ledger_snapshot_fingerprint = snapshot.snapshot_fingerprint
          AND abs(coalesce(wp.current_amount, 0) - snapshot.ledger_amount) < 0.01
          AND (
            si.fiscal_period_id = p_fiscal_period_id
            OR (
              si.fiscal_year_start = v_period.period_start
              AND si.fiscal_year_end = v_period.period_end
            )
          )
      )
    );

  SELECT count(*)::integer INTO v_count
  FROM public.sie_imports si
  WHERE si.company_id = p_company_id
    AND si.status IN (
      'pending', 'validating', 'staged', 'importing',
      'partial', 'mapped', 'failed'
    )
    AND (
      si.fiscal_period_id = p_fiscal_period_id
      OR (
        si.fiscal_year_start IS NOT NULL
        AND si.fiscal_year_end IS NOT NULL
        AND daterange(si.fiscal_year_start, si.fiscal_year_end, '[]')
          && daterange(v_period.period_start, v_period.period_end, '[]')
      )
    );
  IF v_count > 0 THEN
    RETURN QUERY SELECT
      'unfinished_sie_imports'::text,
      format('%s SIE-import(er) är inte slutförda.', v_count),
      v_count;
  END IF;

  FOR v_control IN
    SELECT * FROM public.year_end_control_status(p_company_id, p_fiscal_period_id)
    WHERE is_blocking
  LOOP
    RETURN QUERY SELECT
      v_control.control_code, v_control.message,
      greatest(v_control.evidence_count, 1);
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.year_end_db_blockers(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.year_end_db_blockers(uuid, uuid)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.year_end_immutable_after_commit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_TABLE_NAME = 'year_end_staged_adjustments'
     AND OLD.status IN ('posted', 'reversed') THEN
    RAISE EXCEPTION 'YE_COMMITTED_ADJUSTMENT_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME = 'year_end_previews'
     AND OLD.status = 'executed'
     AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'YE_EXECUTED_PREVIEW_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER year_end_staged_adjustments_immutable
  BEFORE UPDATE OR DELETE ON public.year_end_staged_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.year_end_immutable_after_commit();
CREATE TRIGGER year_end_previews_immutable
  BEFORE UPDATE OR DELETE ON public.year_end_previews
  FOR EACH ROW EXECUTE FUNCTION public.year_end_immutable_after_commit();

CREATE TRIGGER audit_year_end_staged_adjustments
  AFTER INSERT OR UPDATE OR DELETE ON public.year_end_staged_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();
CREATE TRIGGER audit_year_end_previews
  AFTER INSERT OR UPDATE OR DELETE ON public.year_end_previews
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();
CREATE TRIGGER audit_year_end_run_acknowledgements
  AFTER INSERT OR UPDATE OR DELETE ON public.year_end_run_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

NOTIFY pgrst, 'reload schema';
