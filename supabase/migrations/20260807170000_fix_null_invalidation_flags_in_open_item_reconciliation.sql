-- Stop NULL invalidation flags from poisoning is_reconciled.
--
-- __year_end_open_item_reconciliation_json() resolves any external AR/AP
-- reconciliation with a plain (non-aggregate) SELECT ... INTO:
--
--     SELECT er.id, ..., (inv.id IS NOT NULL), coalesce(si.status IN (...), false)
--       INTO v_external_id, ..., v_invalidated, v_external_source_invalidated
--     FROM public.year_end_external_ar_reconciliations er ...
--
-- When no external reconciliation exists — the normal case, since an external
-- register is optional — the query returns no row and PL/pgSQL sets EVERY
-- target to NULL, discarding the `:= false` initialisation the declarations
-- give v_invalidated and v_external_source_invalidated.
--
-- is_reconciled is a boolean AND-chain ending in
--     AND NOT v_invalidated AND NOT v_source_invalidated AND ...
-- so a single NULL makes the whole expression NULL. While evidence is missing
-- the chain still returns false (NULL AND false = false), which hid the defect;
-- the moment the last piece of evidence is attached and every other term is
-- true, the result flips from false to NULL instead of true.
--
-- Effect in production: a company that correctly reconstructs its AR/AP support
-- ledger and attaches evidence gets is_reconciled = NULL, so
-- year_end_control_status() never sees the control as satisfied and the year-end
-- close stays blocked with no way for the user to clear it.
--
-- Fix: coalesce the flags at their use sites. NULL means "no such invalidation
-- record exists", which is exactly `false`. This cannot change behaviour for any
-- non-NULL value, and the exposed verification_stale / source_import_invalidated
-- fields become proper booleans instead of NULL.
--
-- Everything else in the function is reproduced unchanged from 20260729161000.
--
-- pg-test: covered-by lib/core/bookkeeping/__tests__/year-end-historical-support.pg.test.ts

BEGIN;

CREATE OR REPLACE FUNCTION public.__year_end_open_item_reconciliation_json(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_as_of_date date,
  p_kind text
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_period public.fiscal_periods%ROWTYPE;
  v_category text;
  v_source_type text;
  v_snapshot record;
  v_internal numeric := 0;
  v_unconverted integer := 0;
  v_migrated numeric := 0;
  v_item_count integer := 0;
  v_external numeric := 0;
  v_external_id uuid;
  v_external_hash text;
  v_invalidated boolean := false;
  v_source_invalidated boolean := false;
  v_external_source_invalidated boolean := false;
  v_missing_evidence integer := 0;
  v_payment_overalloc integer := 0;
  v_mode text;
  v_total numeric;
  v_expected numeric;
  v_difference numeric;
  v_stale boolean := false;
BEGIN
  IF p_kind NOT IN ('ar', 'ap') THEN
    RAISE EXCEPTION 'HISTORICAL_OPEN_ITEM_INVALID_KIND'
      USING ERRCODE = '22023';
  END IF;

  SELECT fp.* INTO v_period
  FROM public.fiscal_periods fp
  WHERE fp.id = p_fiscal_period_id
    AND fp.company_id = p_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HISTORICAL_OPEN_ITEM_PERIOD_NOT_FOUND'
      USING ERRCODE = '22023';
  END IF;
  IF p_as_of_date <> v_period.period_end THEN
    RAISE EXCEPTION 'HISTORICAL_OPEN_ITEM_BALANCE_DATE_MUST_EQUAL_PERIOD_END'
      USING ERRCODE = '22023';
  END IF;

  v_category := CASE WHEN p_kind = 'ar'
    THEN 'customer_receivables' ELSE 'supplier_payables' END;
  v_source_type := CASE WHEN p_kind = 'ar'
    THEN 'invoice' ELSE 'supplier_invoice' END;

  SELECT * INTO v_snapshot
  FROM public.__year_end_control_ledger_snapshot(
    p_company_id, v_category, p_as_of_date
  );

  SELECT
    round(coalesce(sum(
      CASE
        WHEN hoi.currency = 'SEK' THEN hoi.open_amount
        WHEN hoi.exchange_rate > 0 THEN hoi.open_amount * hoi.exchange_rate
        ELSE 0
      END
    ), 0), 2),
    count(*) FILTER (
      WHERE hoi.currency <> 'SEK'
        AND (hoi.exchange_rate IS NULL OR hoi.exchange_rate <= 0)
    )::integer
  INTO v_internal, v_unconverted
  FROM public.historical_open_items_at(p_company_id, p_as_of_date) hoi
  WHERE hoi.source_type = v_source_type;

  IF p_kind = 'ar' THEN
    SELECT
      round(coalesce(sum(r.remaining_amount_sek_at_balance_date), 0), 2),
      count(*)::integer,
      coalesce(bool_or(si.status IN ('replaced', 'undone')), false)
    INTO v_migrated, v_item_count, v_source_invalidated
    FROM public.migrated_customer_receivables r
    LEFT JOIN public.sie_imports si ON si.id = r.sie_import_id
    WHERE r.company_id = p_company_id
      AND r.fiscal_period_id = p_fiscal_period_id
      AND r.balance_date = p_as_of_date
      AND r.superseded_at IS NULL;

    SELECT
      er.id,
      er.external_legacy_balance,
      er.ledger_snapshot_hash,
      (inv.id IS NOT NULL),
      coalesce(si.status IN ('replaced', 'undone'), false)
    INTO v_external_id, v_external, v_external_hash, v_invalidated,
      v_external_source_invalidated
    FROM public.year_end_external_ar_reconciliations er
    LEFT JOIN public.year_end_external_ar_reconciliation_invalidations inv
      ON inv.reconciliation_id = er.id
    LEFT JOIN public.sie_imports si ON si.id = er.source_sie_import_id
    WHERE er.company_id = p_company_id
      AND er.fiscal_period_id = p_fiscal_period_id;

    SELECT count(*)::integer INTO v_missing_evidence
    FROM public.migrated_customer_receivables r
    WHERE r.company_id = p_company_id
      AND r.fiscal_period_id = p_fiscal_period_id
      AND r.balance_date = p_as_of_date
      AND r.superseded_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.migrated_receivable_documents d
        WHERE d.receivable_id = r.id
      );

    SELECT count(*)::integer INTO v_payment_overalloc
    FROM public.migrated_customer_receivables r
    WHERE r.company_id = p_company_id
      AND r.fiscal_period_id = p_fiscal_period_id
      AND (
        SELECT coalesce(sum(p.amount_sek), 0)
        FROM public.migrated_receivable_payments p
        WHERE p.receivable_id = r.id
      ) > r.remaining_amount_sek_at_balance_date + 0.01;
  ELSE
    SELECT
      round(coalesce(sum(p.remaining_amount_sek_at_balance_date), 0), 2),
      count(*)::integer,
      coalesce(bool_or(si.status IN ('replaced', 'undone')), false)
    INTO v_migrated, v_item_count, v_source_invalidated
    FROM public.migrated_supplier_payables p
    LEFT JOIN public.sie_imports si ON si.id = p.sie_import_id
    WHERE p.company_id = p_company_id
      AND p.fiscal_period_id = p_fiscal_period_id
      AND p.balance_date = p_as_of_date
      AND p.superseded_at IS NULL;

    SELECT
      er.id,
      er.external_legacy_balance,
      er.ledger_snapshot_hash,
      (inv.id IS NOT NULL),
      coalesce(si.status IN ('replaced', 'undone'), false)
    INTO v_external_id, v_external, v_external_hash, v_invalidated,
      v_external_source_invalidated
    FROM public.year_end_external_ap_reconciliations er
    LEFT JOIN public.year_end_external_ap_reconciliation_invalidations inv
      ON inv.reconciliation_id = er.id
    LEFT JOIN public.sie_imports si ON si.id = er.source_sie_import_id
    WHERE er.company_id = p_company_id
      AND er.fiscal_period_id = p_fiscal_period_id;

    SELECT count(*)::integer INTO v_missing_evidence
    FROM public.migrated_supplier_payables p
    WHERE p.company_id = p_company_id
      AND p.fiscal_period_id = p_fiscal_period_id
      AND p.balance_date = p_as_of_date
      AND p.superseded_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.migrated_supplier_payable_documents d
        WHERE d.payable_id = p.id
      );

    SELECT count(*)::integer INTO v_payment_overalloc
    FROM public.migrated_supplier_payables p
    WHERE p.company_id = p_company_id
      AND p.fiscal_period_id = p_fiscal_period_id
      AND (
        SELECT coalesce(sum(pay.amount_sek), 0)
        FROM public.migrated_supplier_payable_payments pay
        WHERE pay.payable_id = p.id
      ) > p.remaining_amount_sek_at_balance_date + 0.01;
  END IF;

  IF v_item_count > 0 AND v_external_id IS NOT NULL THEN
    v_mode := 'conflict';
  ELSIF v_item_count > 0 THEN
    v_mode := CASE WHEN p_kind = 'ar'
      THEN 'itemized_migrated_receivables'
      ELSE 'itemized_migrated_payables' END;
  ELSIF v_external_id IS NOT NULL THEN
    v_mode := CASE WHEN p_kind = 'ar'
      THEN 'external_verified_receivables'
      ELSE 'external_verified_payables' END;
  ELSE
    v_mode := 'none';
  END IF;

  v_stale := v_external_id IS NOT NULL
    AND v_external_hash IS DISTINCT FROM v_snapshot.snapshot_hash;
  v_expected := round(v_snapshot.ledger_balance - v_internal, 2);
  v_total := round(
    v_internal
    + CASE WHEN v_external_id IS NOT NULL THEN v_external ELSE v_migrated END,
    2
  );
  v_difference := round(v_total - v_snapshot.ledger_balance, 2);

  RETURN jsonb_build_object(
    'ledger_balance', v_snapshot.ledger_balance,
    'internal_open_items', v_internal,
    'migrated_open_items', v_migrated,
    'external_verified_open_items', coalesce(v_external, 0),
    'total_subledger', v_total,
    'expected_legacy_balance', v_expected,
    'difference', v_difference,
    'reconciliation_mode', v_mode,
    'missing_evidence_count', v_missing_evidence,
    'invalid_item_count', v_unconverted,
    'overallocated_payment_count', v_payment_overalloc,
    'verification_stale', coalesce(v_stale, false) OR coalesce(v_invalidated, false),
    'source_import_invalidated',
      coalesce(v_source_invalidated, false) OR coalesce(v_external_source_invalidated, false),
    'snapshot_hash', v_snapshot.snapshot_hash,
    'is_reconciled',
      (
        (v_mode = 'none' AND abs(v_expected) < 0.01)
        OR (v_mode <> 'none' AND v_mode <> 'conflict')
      )
      AND abs(v_difference) < 0.01
      AND v_unconverted = 0
      AND v_missing_evidence = 0
      AND v_payment_overalloc = 0
      AND NOT coalesce(v_stale, false)
      AND NOT coalesce(v_invalidated, false)
      AND NOT coalesce(v_source_invalidated, false)
      AND NOT coalesce(v_external_source_invalidated, false)
  );
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
