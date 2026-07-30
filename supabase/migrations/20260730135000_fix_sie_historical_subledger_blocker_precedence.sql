-- Prevent the legacy internal-invoice-only AR/AP blocker from overriding the
-- canonical historical support-ledger flow for completed SIE imports.
--
-- Native Nordklart bookkeeping without a completed SIE import keeps the strict
-- legacy mismatch blockers. Imported periods are instead evaluated by
-- year_end_control_status(), where a missing historical subledger is unknown
-- until the user accepts the imported balance, reconstructs the open items, or
-- verifies an external subledger. None of those actions creates a journal entry.

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
  v_has_completed_sie boolean := false;
BEGIN
  SELECT fp.* INTO v_period
  FROM public.fiscal_periods fp
  WHERE fp.id = p_fiscal_period_id
    AND fp.company_id = p_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'YE_PERIOD_NOT_FOUND';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.sie_imports si
    WHERE si.company_id = p_company_id
      AND si.status = 'completed'
      AND (
        si.fiscal_period_id = p_fiscal_period_id
        OR (
          si.fiscal_year_start IS NOT NULL
          AND si.fiscal_year_end IS NOT NULL
          AND daterange(si.fiscal_year_start, si.fiscal_year_end, '[]')
            && daterange(v_period.period_start, v_period.period_end, '[]')
        )
      )
  ) INTO v_has_completed_sie;

  RETURN QUERY
  SELECT core.code, core.message, core.detail_count
  FROM public.__year_end_db_blockers_historical_core_20260729(
    p_company_id, p_fiscal_period_id
  ) core
  WHERE core.code <> 'unfinished_sie_imports'
    AND NOT (
      v_has_completed_sie
      AND core.code IN (
        'accounts_receivable_mismatch',
        'accounts_payable_mismatch'
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
      format(
        '%s SIE-import(er) är inte slutförda, inklusive förberedda eller misslyckade sessioner.',
        v_count
      ),
      v_count;
  END IF;

  FOR v_control IN
    SELECT *
    FROM public.year_end_control_status(p_company_id, p_fiscal_period_id)
    WHERE is_blocking
  LOOP
    RETURN QUERY SELECT
      v_control.control_code,
      v_control.message,
      greatest(v_control.evidence_count, 1);
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.year_end_db_blockers(uuid, uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.year_end_db_blockers(uuid, uuid)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
