-- Year-end period access and atomic fiscal-year creation.
--
-- Fixes the pre-period gap in the one-off year-end flow: a company may have an
-- active year-end purchase but no fiscal_periods row yet. Period listing and
-- creation must therefore be authorized by the year-end product, not by
-- bookkeeping.core. The service-only RPC below performs access resolution,
-- entitlement validation, locking, continuity checks, one-off binding,
-- project state creation and audit logging in one transaction.
--
-- Existing economic engines are reused. No parallel ledger/period model is
-- introduced; year_end_projects is extended to represent the pre-import case.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Consolidate year_end_projects as the canonical one-off case state.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.year_end_projects
  ALTER COLUMN fiscal_period_id DROP NOT NULL;

ALTER TABLE public.year_end_projects
  ADD COLUMN IF NOT EXISTS period_start date,
  ADD COLUMN IF NOT EXISTS period_end date,
  ADD COLUMN IF NOT EXISTS legal_form text,
  ADD COLUMN IF NOT EXISTS purchased_at timestamptz,
  ADD COLUMN IF NOT EXISTS activated_at timestamptz,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assigned_accountant_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_system text,
  ADD COLUMN IF NOT EXISTS sie_import_id uuid REFERENCES public.sie_imports(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS readiness_status text,
  ADD COLUMN IF NOT EXISTS year_end_run_id uuid REFERENCES public.year_end_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS annual_report_version_id uuid,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

UPDATE public.year_end_projects yep
SET period_start = COALESCE(
      yep.period_start,
      (SELECT fp.period_start FROM public.fiscal_periods fp WHERE fp.id = yep.fiscal_period_id)
    ),
    period_end = COALESCE(
      yep.period_end,
      (SELECT fp.period_end FROM public.fiscal_periods fp WHERE fp.id = yep.fiscal_period_id)
    ),
    created_by = COALESCE(yep.created_by, yep.started_by),
    legal_form = COALESCE(
      yep.legal_form,
      (SELECT c.entity_type FROM public.companies c WHERE c.id = yep.company_id)
    ),
    purchased_at = COALESCE(
      yep.purchased_at,
      (SELECT otp.paid_at FROM public.one_time_purchases otp WHERE otp.id = yep.purchase_id)
    ),
    activated_at = COALESCE(
      yep.activated_at,
      (SELECT otp.access_starts_at FROM public.one_time_purchases otp WHERE otp.id = yep.purchase_id)
    ),
    expires_at = COALESCE(
      yep.expires_at,
      (SELECT otp.access_expires_at FROM public.one_time_purchases otp WHERE otp.id = yep.purchase_id)
    );

ALTER TABLE public.year_end_projects
  DROP CONSTRAINT IF EXISTS year_end_projects_status_check;

ALTER TABLE public.year_end_projects
  ADD CONSTRAINT year_end_projects_status_check CHECK (status IN (
    -- Canonical one-off/year-end workflow.
    'draft', 'awaiting_company_details', 'awaiting_fiscal_year',
    'awaiting_import', 'import_validating', 'import_failed', 'imported',
    'reconciliation_required', 'ready_for_year_end', 'closing',
    'closing_failed', 'closed', 'annual_report_draft',
    'annual_report_ready', 'completed', 'cancelled',
    -- Legacy states retained while callers migrate to the canonical machine.
    'in_progress', 'ready_for_review', 'approved', 'locked', 'archived'
  ));

ALTER TABLE public.year_end_projects
  DROP CONSTRAINT IF EXISTS year_end_projects_period_range_check;
ALTER TABLE public.year_end_projects
  ADD CONSTRAINT year_end_projects_period_range_check CHECK (
    (period_start IS NULL AND period_end IS NULL)
    OR (period_start IS NOT NULL AND period_end IS NOT NULL AND period_start <= period_end)
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT purchase_id
    FROM public.year_end_projects
    WHERE purchase_id IS NOT NULL
    GROUP BY purchase_id
    HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS year_end_projects_purchase_unique
      ON public.year_end_projects(purchase_id)
      WHERE purchase_id IS NOT NULL;
  ELSE
    -- Preserve legacy rows without destructive consolidation. The atomic RPC
    -- reuses an existing project and never creates an additional duplicate.
    CREATE INDEX IF NOT EXISTS year_end_projects_purchase_lookup_idx
      ON public.year_end_projects(purchase_id)
      WHERE purchase_id IS NOT NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS year_end_projects_case_status_idx
  ON public.year_end_projects(company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS year_end_projects_unassigned_period_idx
  ON public.year_end_projects(company_id, created_at DESC)
  WHERE fiscal_period_id IS NULL AND status NOT IN ('completed', 'cancelled', 'archived');

CREATE OR REPLACE FUNCTION public.enforce_year_end_project_status_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD.status = 'draft' AND NEW.status IN ('awaiting_company_details','awaiting_fiscal_year','awaiting_import','in_progress','cancelled','archived'))
    OR (OLD.status = 'awaiting_company_details' AND NEW.status IN ('awaiting_fiscal_year','awaiting_import','cancelled'))
    OR (OLD.status = 'awaiting_fiscal_year' AND NEW.status IN ('awaiting_import','cancelled'))
    OR (OLD.status = 'awaiting_import' AND NEW.status IN ('import_validating','cancelled'))
    OR (OLD.status = 'import_validating' AND NEW.status IN ('imported','import_failed'))
    OR (OLD.status = 'import_failed' AND NEW.status IN ('awaiting_import','import_validating','cancelled'))
    OR (OLD.status = 'imported' AND NEW.status IN ('reconciliation_required','ready_for_year_end','cancelled'))
    OR (OLD.status = 'reconciliation_required' AND NEW.status IN ('imported','ready_for_year_end','cancelled'))
    OR (OLD.status = 'ready_for_year_end' AND NEW.status IN ('reconciliation_required','closing','cancelled'))
    OR (OLD.status = 'closing' AND NEW.status IN ('closed','closing_failed'))
    OR (OLD.status = 'closing_failed' AND NEW.status IN ('closing','reconciliation_required','cancelled'))
    OR (OLD.status = 'closed' AND NEW.status IN ('annual_report_draft','completed'))
    OR (OLD.status = 'annual_report_draft' AND NEW.status IN ('closed','annual_report_ready'))
    OR (OLD.status = 'annual_report_ready' AND NEW.status IN ('annual_report_draft','completed'))
    OR (OLD.status = 'completed' AND NEW.status = 'archived')
    OR (OLD.status = 'in_progress' AND NEW.status IN ('ready_for_review','approved','completed','locked','archived','awaiting_import','reconciliation_required','ready_for_year_end'))
    OR (OLD.status = 'ready_for_review' AND NEW.status IN ('in_progress','approved','archived','ready_for_year_end'))
    OR (OLD.status = 'approved' AND NEW.status IN ('completed','locked','archived','closing'))
    OR (OLD.status = 'locked' AND NEW.status IN ('completed','archived'))
  ) THEN
    RAISE EXCEPTION 'INVALID_YEAR_END_CASE_TRANSITION: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'cancelled' AND NEW.cancelled_at IS NULL THEN
    NEW.cancelled_at := now();
  END IF;
  IF NEW.status = 'completed' AND NEW.completed_at IS NULL THEN
    NEW.completed_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_year_end_project_status_transition ON public.year_end_projects;
CREATE TRIGGER enforce_year_end_project_status_transition
  BEFORE UPDATE OF status ON public.year_end_projects
  FOR EACH ROW EXECUTE FUNCTION public.enforce_year_end_project_status_transition();

-- Create a pre-period case for active purchases that do not yet have one.
INSERT INTO public.year_end_projects (
  company_id, fiscal_period_id, purchase_id, status, framework,
  source, requires_purchase, access_source, period_start, period_end,
  legal_form, purchased_at, activated_at, expires_at, created_by, metadata
)
SELECT
  otp.company_id,
  otp.fiscal_period_id,
  otp.id,
  CASE WHEN otp.fiscal_period_id IS NULL THEN 'awaiting_fiscal_year' ELSE 'awaiting_import' END,
  c.accounting_framework,
  'one_time_purchase',
  true,
  'one_time_purchase',
  fp.period_start,
  fp.period_end,
  c.entity_type,
  otp.paid_at,
  COALESCE(otp.access_starts_at, otp.paid_at),
  otp.access_expires_at,
  otp.created_by,
  jsonb_build_object('created_by_migration', '20260720120000')
FROM public.one_time_purchases otp
JOIN public.companies c ON c.id = otp.company_id
LEFT JOIN public.fiscal_periods fp ON fp.id = otp.fiscal_period_id
WHERE otp.purchase_type = 'year_end'
  AND otp.status IN ('paid','active','fulfilled')
  AND (otp.access_starts_at IS NULL OR otp.access_starts_at <= now())
  AND (otp.permanent_access OR otp.access_expires_at IS NULL OR otp.access_expires_at > now())
  AND NOT EXISTS (
    SELECT 1 FROM public.year_end_projects yep WHERE yep.purchase_id = otp.id
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Service-only, atomic and idempotent fiscal-year creation.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_fiscal_year_atomic_internal(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_name text,
  p_period_start date,
  p_period_end date,
  p_request_id text DEFAULT NULL
)
RETURNS SETOF public.fiscal_periods
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_access record;
  v_period public.fiscal_periods%ROWTYPE;
  v_previous public.fiscal_periods%ROWTYPE;
  v_next public.fiscal_periods%ROWTYPE;
  v_purchase public.one_time_purchases%ROWTYPE;
  v_project_id uuid;
  v_has_feature boolean := false;
  v_is_platform boolean := false;
  v_can_operate boolean := false;
  v_locked_through date;
  v_existing_exact boolean := false;
BEGIN
  IF p_company_id IS NULL OR p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'PERMISSION_DENIED: company and actor are required' USING ERRCODE = '42501';
  END IF;
  IF p_name IS NULL OR btrim(p_name) = ''
     OR p_period_start IS NULL OR p_period_end IS NULL
     OR p_period_end < p_period_start
     OR p_period_end >= (p_period_start + interval '18 months')::date THEN
    RAISE EXCEPTION 'INVALID_FISCAL_YEAR_RANGE' USING ERRCODE = '22007';
  END IF;

  -- One lock serializes exact duplicates, overlapping ranges and purchase
  -- binding for the company. The existing company-scoped EXCLUDE constraint
  -- remains the final invariant guard.
  PERFORM pg_advisory_xact_lock(hashtextextended('fiscal-year:' || p_company_id::text, 0));

  IF NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.id = p_company_id AND c.archived_at IS NULL) THEN
    RAISE EXCEPTION 'INVALID_COMPANY_ID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_access
  FROM public.resolve_company_access_for_user(p_actor_user_id, p_company_id)
  LIMIT 1;

  IF NOT FOUND OR NOT COALESCE(v_access.can_read, false) THEN
    RAISE EXCEPTION 'PERMISSION_DENIED' USING ERRCODE = '42501';
  END IF;

  v_is_platform := COALESCE(v_access.can_manage_platform, false)
                   AND v_access.effective_role = 'platform_admin';
  v_can_operate := COALESCE(v_access.can_write, false)
    OR v_access.effective_role IN ('company_owner','company_admin','accountant','client_user');

  IF NOT v_is_platform AND NOT v_can_operate THEN
    RAISE EXCEPTION 'PERMISSION_DENIED' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(cfa.allowed, false)
  INTO v_has_feature
  FROM public.company_feature_access(p_company_id, 'year_end.projects') cfa
  LIMIT 1;

  SELECT * INTO v_period
  FROM public.fiscal_periods fp
  WHERE fp.company_id = p_company_id
    AND fp.period_start = p_period_start
    AND fp.period_end = p_period_end
  FOR UPDATE;
  v_existing_exact := FOUND;

  -- A period-scoped one-off purchase is the commercial authority when the
  -- company has no subscription/manual year-end feature. An unassigned
  -- purchase can be bound exactly once; an assigned purchase only permits an
  -- idempotent replay for its existing period.
  IF NOT v_is_platform AND NOT COALESCE(v_has_feature, false) THEN
    SELECT * INTO v_purchase
    FROM public.one_time_purchases otp
    WHERE otp.company_id = p_company_id
      AND otp.purchase_type = 'year_end'
      AND otp.status IN ('paid','active','fulfilled')
      AND (otp.access_starts_at IS NULL OR otp.access_starts_at <= now())
      AND (otp.permanent_access OR otp.access_expires_at IS NULL OR otp.access_expires_at > now())
      AND (
        otp.fiscal_period_id IS NULL
        OR (v_existing_exact AND otp.fiscal_period_id = v_period.id)
      )
    ORDER BY (otp.fiscal_period_id IS NOT NULL) DESC, otp.created_at ASC
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
      IF EXISTS (
        SELECT 1 FROM public.one_time_purchases otp
        WHERE otp.company_id = p_company_id
          AND otp.purchase_type = 'year_end'
          AND otp.status IN ('paid','active','fulfilled','expired')
      ) THEN
        RAISE EXCEPTION 'ONE_OFF_YEAR_END_NOT_ACTIVE' USING ERRCODE = '42501';
      END IF;
      RAISE EXCEPTION 'YEAR_END_ENTITLEMENT_REQUIRED' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NOT v_existing_exact THEN
    IF EXISTS (
      SELECT 1 FROM public.fiscal_periods fp
      WHERE fp.company_id = p_company_id
        AND daterange(fp.period_start, fp.period_end, '[]')
          && daterange(p_period_start, p_period_end, '[]')
    ) THEN
      RAISE EXCEPTION 'FISCAL_YEAR_OVERLAP' USING ERRCODE = '23P01';
    END IF;

    SELECT * INTO v_previous
    FROM public.fiscal_periods fp
    WHERE fp.company_id = p_company_id
      AND fp.period_end < p_period_start
    ORDER BY fp.period_end DESC
    LIMIT 1
    FOR UPDATE;

    SELECT * INTO v_next
    FROM public.fiscal_periods fp
    WHERE fp.company_id = p_company_id
      AND fp.period_start > p_period_end
    ORDER BY fp.period_start ASC
    LIMIT 1
    FOR UPDATE;

    IF v_previous.id IS NOT NULL AND p_period_start <> v_previous.period_end + 1 THEN
      RAISE EXCEPTION 'FISCAL_YEAR_NOT_CONTIGUOUS' USING ERRCODE = '22023';
    END IF;
    IF v_next.id IS NOT NULL AND p_period_end <> v_next.period_start - 1 THEN
      RAISE EXCEPTION 'FISCAL_YEAR_NOT_CONTIGUOUS' USING ERRCODE = '22023';
    END IF;

    IF v_previous.id IS NOT NULL
       AND NOT v_previous.is_closed
       AND v_previous.locked_at IS NULL THEN
      SELECT cs.bookkeeping_locked_through INTO v_locked_through
      FROM public.company_settings cs
      WHERE cs.company_id = p_company_id
      LIMIT 1;

      IF v_locked_through IS NULL OR v_locked_through < v_previous.period_end THEN
        RAISE EXCEPTION 'PERIOD_CREATE_BLOCKED_BY_OPEN_PERIODS: %',
          jsonb_build_array(jsonb_build_object(
            'id', v_previous.id,
            'name', v_previous.name,
            'period_start', v_previous.period_start,
            'period_end', v_previous.period_end
          ))::text
          USING ERRCODE = '55000';
      END IF;
    END IF;

    INSERT INTO public.fiscal_periods (
      company_id, user_id, name, period_start, period_end, previous_period_id
    ) VALUES (
      p_company_id, p_actor_user_id, btrim(p_name), p_period_start, p_period_end, v_previous.id
    )
    RETURNING * INTO v_period;

    IF v_next.id IS NOT NULL AND v_next.previous_period_id IS DISTINCT FROM v_period.id THEN
      UPDATE public.fiscal_periods
      SET previous_period_id = v_period.id,
          updated_at = now()
      WHERE id = v_next.id AND company_id = p_company_id;
    END IF;
  END IF;

  IF v_purchase.id IS NOT NULL THEN
    UPDATE public.one_time_purchases
    SET fiscal_period_id = v_period.id,
        status = CASE WHEN status = 'paid' THEN 'active' ELSE status END,
        access_starts_at = COALESCE(access_starts_at, now()),
        updated_at = now()
    WHERE id = v_purchase.id;

    SELECT yep.id INTO v_project_id
    FROM public.year_end_projects yep
    WHERE yep.purchase_id = v_purchase.id
    FOR UPDATE;

    IF v_project_id IS NULL THEN
      INSERT INTO public.year_end_projects (
        company_id, fiscal_period_id, purchase_id, status, framework,
        source, requires_purchase, access_source, period_start, period_end,
        legal_form, purchased_at, activated_at, expires_at, created_by, metadata
      )
      SELECT
        p_company_id, v_period.id, v_purchase.id, 'awaiting_import', c.accounting_framework,
        'one_time_purchase', true, 'one_time_purchase',
        v_period.period_start, v_period.period_end, c.entity_type,
        v_purchase.paid_at, COALESCE(v_purchase.access_starts_at, now()),
        v_purchase.access_expires_at, p_actor_user_id,
        jsonb_build_object('request_id', p_request_id, 'created_by_rpc', 'create_fiscal_year_atomic_internal')
      FROM public.companies c WHERE c.id = p_company_id
      ON CONFLICT (company_id, fiscal_period_id) DO UPDATE
      SET purchase_id = COALESCE(public.year_end_projects.purchase_id, EXCLUDED.purchase_id),
          period_start = EXCLUDED.period_start,
          period_end = EXCLUDED.period_end,
          updated_at = now()
      RETURNING id INTO v_project_id;
    ELSE
      UPDATE public.year_end_projects
      SET fiscal_period_id = v_period.id,
          period_start = v_period.period_start,
          period_end = v_period.period_end,
          status = CASE
            WHEN status IN ('draft','awaiting_company_details','awaiting_fiscal_year') THEN 'awaiting_import'
            ELSE status
          END,
          activated_at = COALESCE(activated_at, now()),
          updated_at = now()
      WHERE id = v_project_id;
    END IF;

    INSERT INTO public.year_end_purchase_access (
      company_id, one_time_purchase_id, year_end_project_id, fiscal_period_id,
      access_status, permanent_access, access_starts_at, access_expires_at,
      created_by, metadata
    ) VALUES (
      p_company_id, v_purchase.id, v_project_id, v_period.id,
      'active', v_purchase.permanent_access,
      COALESCE(v_purchase.access_starts_at, now()), v_purchase.access_expires_at,
      p_actor_user_id, jsonb_build_object('request_id', p_request_id)
    )
    ON CONFLICT (company_id, year_end_project_id, one_time_purchase_id)
    DO UPDATE SET
      fiscal_period_id = EXCLUDED.fiscal_period_id,
      access_status = 'active',
      permanent_access = EXCLUDED.permanent_access,
      access_starts_at = EXCLUDED.access_starts_at,
      access_expires_at = EXCLUDED.access_expires_at,
      updated_at = now();
  ELSE
    -- Subscription/manual/platform flows use the same project table without
    -- fabricating a purchase row.
    INSERT INTO public.year_end_projects (
      company_id, fiscal_period_id, status, framework, source, requires_purchase,
      access_source, period_start, period_end, legal_form, created_by, metadata
    )
    SELECT
      p_company_id, v_period.id, 'draft', c.accounting_framework,
      CASE WHEN v_is_platform THEN 'api' ELSE 'bookkeeping_module' END,
      false,
      CASE WHEN v_is_platform THEN 'manual_override' ELSE 'subscription' END,
      v_period.period_start, v_period.period_end, c.entity_type, p_actor_user_id,
      jsonb_build_object('request_id', p_request_id, 'created_by_rpc', 'create_fiscal_year_atomic_internal')
    FROM public.companies c WHERE c.id = p_company_id
    ON CONFLICT (company_id, fiscal_period_id) DO NOTHING;
  END IF;

  INSERT INTO public.audit_log (
    user_id, actor_id, company_id, action, table_name, record_id, description, new_state
  ) VALUES (
    p_actor_user_id, p_actor_user_id, p_company_id, 'SECURITY_EVENT',
    'fiscal_periods', v_period.id,
    CASE WHEN v_existing_exact
      THEN 'Idempotent återläsning av räkenskapsår i bokslutsflödet.'
      ELSE 'Räkenskapsår skapades atomiskt i bokslutsflödet.'
    END,
    jsonb_build_object(
      'operation', 'year_end.fiscal_year.create',
      'request_id', p_request_id,
      'period_start', v_period.period_start,
      'period_end', v_period.period_end,
      'idempotent', v_existing_exact,
      'access_source', CASE
        WHEN v_is_platform THEN 'platform_admin'
        WHEN v_purchase.id IS NOT NULL THEN 'one_time_purchase'
        ELSE 'feature_entitlement'
      END
    )
  );

  RETURN NEXT v_period;
  RETURN;
EXCEPTION
  WHEN exclusion_violation THEN
    RAISE EXCEPTION 'FISCAL_YEAR_OVERLAP' USING ERRCODE = '23P01';
END;
$$;

REVOKE ALL ON FUNCTION public.create_fiscal_year_atomic_internal(uuid, uuid, text, date, date, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_fiscal_year_atomic_internal(uuid, uuid, text, date, date, text) FROM anon;
REVOKE ALL ON FUNCTION public.create_fiscal_year_atomic_internal(uuid, uuid, text, date, date, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_fiscal_year_atomic_internal(uuid, uuid, text, date, date, text) TO service_role;

NOTIFY pgrst, 'reload schema';
