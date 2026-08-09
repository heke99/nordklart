-- Restore the SIE precedence suppression for `imported_from_sie` workpapers.
--
-- 20260730135000_fix_sie_historical_subledger_blocker_precedence.sql suppressed
-- accounts_receivable_mismatch / accounts_payable_mismatch for ANY completed SIE
-- import, because an imported period's supporting subledger is *unknown* until
-- the user accepts the balance, reconstructs the open items or verifies an
-- external register — none of which creates a journal entry.
--
-- 20260730170000_canonical_year_end_staging_preview_execute.sql rewrote
-- year_end_db_blockers() and replaced that blanket suppression with a narrower,
-- workpaper-status-based one — but omitted 'imported_from_sie', the exact status
-- refresh_year_end_historical_workpapers() assigns when the ledger balance is
-- non-zero. The precedence fix was therefore silently undone four hours after it
-- shipped, and the system began reporting a numeric *mismatch* for a category
-- whose own year_end_control_status() row reports `difference = NULL` (unknown).
-- Two sources of truth disagreeing about the same category.
--
-- This adds 'imported_from_sie' back to the list and keeps every safety
-- condition 20260730170000 introduced, so the suppression is still far narrower
-- than the original blanket one:
--   * a completed SIE import for this period/fiscal year must exist
--   * the workpaper must have no pending SIE import
--   * its ledger_snapshot_fingerprint must still match the current snapshot
--   * its current_amount must still agree with the ledger amount (< 0.01)
--
-- The close remains blocked: the separate customer_receivables_reconciliation /
-- supplier_payables_reconciliation control still fires until the user confirms
-- the register. Only the false "mismatch" claim disappears.
--
-- Everything else in the function is reproduced unchanged from 20260730170000.
--
-- pg-test: covered-by lib/core/bookkeeping/__tests__/year-end-historical-support.pg.test.ts

BEGIN;

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
            'external_evidence_verified', 'manually_adjusted',
            'imported_from_sie'
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

COMMIT;

NOTIFY pgrst, 'reload schema';
