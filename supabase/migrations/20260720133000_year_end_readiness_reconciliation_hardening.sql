-- Year-end readiness hardening: make the transaction-internal blocker function
-- enforce the same strict reconciliation invariants as the UI.
--
-- This migration deliberately wraps the existing canonical blocker function
-- instead of creating a second readiness engine. The prior implementation is
-- retained as a private core and every new check is appended to its result.

DO $$
BEGIN
  IF to_regprocedure('public.__year_end_db_blockers_core_20260720(uuid,uuid)') IS NULL THEN
    EXECUTE 'ALTER FUNCTION public.year_end_db_blockers(uuid, uuid) RENAME TO __year_end_db_blockers_core_20260720';
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.__year_end_db_blockers_core_20260720(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.__year_end_db_blockers_core_20260720(uuid, uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.year_end_db_blockers(
  p_company_id uuid,
  p_fiscal_period_id uuid
) RETURNS TABLE (code text, message text, detail_count integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_period public.fiscal_periods%ROWTYPE;
  v_cash record;
  v_count integer;
  v_bank_total numeric;
  v_gl_movement numeric;
  v_difference numeric;
  v_ar_open numeric;
  v_ap_open numeric;
  v_ar_gl numeric;
  v_ap_gl numeric;
  v_missing_fx integer;
BEGIN
  -- Preserve every existing canonical readiness check first.
  RETURN QUERY
  SELECT core.code, core.message, core.detail_count
  FROM public.__year_end_db_blockers_core_20260720(
    p_company_id,
    p_fiscal_period_id
  ) core;

  SELECT fp.* INTO v_period
  FROM public.fiscal_periods fp
  WHERE fp.id = p_fiscal_period_id
    AND fp.company_id = p_company_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Required canonical company facts. No legal-form or framework fallback is
  -- allowed in an economic close.
  IF EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = p_company_id
      AND (
        nullif(btrim(c.name), '') IS NULL
        OR nullif(regexp_replace(coalesce(c.org_number, ''), '[^0-9]', '', 'g'), '') IS NULL
        OR c.entity_type IS NULL
        OR c.accounting_framework IS NULL
      )
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.company_settings cs
    WHERE cs.company_id = p_company_id
      AND cs.accounting_method IN ('accrual', 'cash')
  ) THEN
    RETURN QUERY SELECT
      'company_details_incomplete'::text,
      'Företagsuppgifter, juridisk form, regelverk eller bokföringsmetod saknas.'::text,
      1;
  END IF;

  -- A running sync means not all bank pages/transactions are known yet.
  SELECT count(*)::integer INTO v_count
  FROM public.bank_sync_runs bsr
  WHERE bsr.company_id = p_company_id
    AND bsr.status = 'running';
  IF v_count > 0 THEN
    RETURN QUERY SELECT
      'bank_sync_in_progress'::text,
      format('%s banksynkronisering(ar) pågår. Vänta tills alla sidor och transaktioner har behandlats.', v_count),
      v_count;
  END IF;

  -- Partial/failed/pending bank files must be explicitly resolved. Otherwise a
  -- close could succeed while an original bank statement is only half loaded.
  SELECT count(*)::integer INTO v_count
  FROM public.bank_file_imports bfi
  WHERE bfi.company_id = p_company_id
    AND bfi.status IN ('pending', 'processing', 'partial', 'failed');
  IF v_count > 0 THEN
    RETURN QUERY SELECT
      'bank_import_incomplete'::text,
      format('%s bankfilimport(er) är inte fullständigt slutförda.', v_count),
      v_count;
  END IF;

  -- Reconcile every enabled cash account. If the company predates the
  -- cash_accounts table, use the canonical 1930/SEK fallback exactly once.
  FOR v_cash IN
    SELECT ca.id, ca.currency, ca.ledger_account, ca.is_primary
    FROM public.cash_accounts ca
    WHERE ca.company_id = p_company_id
      AND ca.enabled
    UNION ALL
    SELECT null::uuid, 'SEK'::text, '1930'::text, true
    WHERE NOT EXISTS (
      SELECT 1 FROM public.cash_accounts ca2
      WHERE ca2.company_id = p_company_id AND ca2.enabled
    )
  LOOP
    SELECT count(*)::integer INTO v_count
    FROM public.transactions t
    WHERE t.company_id = p_company_id
      AND t.date BETWEEN v_period.period_start AND v_period.period_end
      AND coalesce(t.is_ignored, false) = false
      AND t.journal_entry_id IS NULL
      AND (
        (v_cash.id IS NULL AND coalesce(t.currency, 'SEK') = v_cash.currency)
        OR t.cash_account_id = v_cash.id
        OR (
          v_cash.id IS NOT NULL
          AND v_cash.is_primary
          AND t.cash_account_id IS NULL
          AND coalesce(t.currency, 'SEK') = v_cash.currency
        )
      );
    IF v_count > 0 THEN
      RETURN QUERY SELECT
        'bank_unmatched_transactions'::text,
        format('%s omatchade bankrader finns för konto %s.', v_count, v_cash.ledger_account),
        v_count;
    END IF;

    SELECT count(*)::integer INTO v_count
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.company_id = p_company_id
      AND je.entry_date BETWEEN v_period.period_start AND v_period.period_end
      AND je.status = 'posted'
      AND je.source_type IS DISTINCT FROM 'opening_balance'
      AND je.source_type IS DISTINCT FROM 'storno'
      AND je.source_type IS DISTINCT FROM 'correction'
      AND jel.account_number = v_cash.ledger_account
      AND NOT EXISTS (
        SELECT 1
        FROM public.transactions t
        WHERE t.company_id = p_company_id
          AND t.journal_entry_id = je.id
      );
    IF v_count > 0 THEN
      RETURN QUERY SELECT
        'bank_unmatched_gl_lines'::text,
        format('%s omatchade huvudboksrader finns på konto %s.', v_count, v_cash.ledger_account),
        v_count;
    END IF;

    SELECT round(coalesce(sum(t.amount), 0), 2) INTO v_bank_total
    FROM public.transactions t
    LEFT JOIN public.journal_entries linked_je
      ON linked_je.id = t.journal_entry_id
     AND linked_je.company_id = p_company_id
    WHERE t.company_id = p_company_id
      AND t.date BETWEEN v_period.period_start AND v_period.period_end
      AND (t.journal_entry_id IS NULL OR linked_je.status IS DISTINCT FROM 'reversed')
      AND (
        (v_cash.id IS NULL AND coalesce(t.currency, 'SEK') = v_cash.currency)
        OR t.cash_account_id = v_cash.id
        OR (
          v_cash.id IS NOT NULL
          AND v_cash.is_primary
          AND t.cash_account_id IS NULL
          AND coalesce(t.currency, 'SEK') = v_cash.currency
        )
      );

    SELECT round(coalesce(sum(jel.debit_amount - jel.credit_amount), 0), 2)
      INTO v_gl_movement
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.company_id = p_company_id
      AND je.entry_date BETWEEN v_period.period_start AND v_period.period_end
      AND je.status = 'posted'
      AND je.source_type IS DISTINCT FROM 'opening_balance'
      AND je.source_type IS DISTINCT FROM 'storno'
      AND je.source_type IS DISTINCT FROM 'correction'
      AND jel.account_number = v_cash.ledger_account;

    v_difference := round(coalesce(v_bank_total, 0) - coalesce(v_gl_movement, 0), 2);
    IF abs(v_difference) >= 0.01 THEN
      RETURN QUERY SELECT
        'bank_reconciliation_difference'::text,
        format('Bankavstämningen för konto %s har differensen %s kr.', v_cash.ledger_account, v_difference),
        0;
    END IF;
  END LOOP;

  -- An unresolved matching decision is a conflict even when net difference is
  -- zero. Two offsetting unresolved rows can therefore never pass readiness.
  SELECT count(*)::integer INTO v_count
  FROM public.transactions t
  WHERE t.company_id = p_company_id
    AND t.date BETWEEN v_period.period_start AND v_period.period_end
    AND t.journal_entry_id IS NULL
    AND coalesce(t.is_ignored, false) = false
    AND t.automation_status IN ('needs_review', 'failed');
  IF v_count > 0 THEN
    RETURN QUERY SELECT
      'bank_matching_conflicts'::text,
      format('%s bankmatchning(ar) kräver granskning eller har misslyckats.', v_count),
      v_count;
  END IF;

  -- Registered/approved AP documents dated in the year must have a posted
  -- registration voucher before close.
  SELECT count(*)::integer INTO v_count
  FROM public.supplier_invoices si
  WHERE si.company_id = p_company_id
    AND si.invoice_date <= v_period.period_end
    AND si.status IN ('registered', 'approved', 'partially_paid', 'overdue', 'disputed')
    AND si.registration_journal_entry_id IS NULL;
  IF v_count > 0 THEN
    RETURN QUERY SELECT
      'unbooked_supplier_invoices'::text,
      format('%s leverantörsfaktura/-or saknar bokförd registreringsverifikation.', v_count),
      v_count;
  END IF;

  -- Due accrual installments through balance date must be posted. A failed or
  -- pending due installment is not a warning; it changes the financial result.
  SELECT count(*)::integer INTO v_count
  FROM public.accrual_schedule_installments asi
  WHERE asi.company_id = p_company_id
    AND asi.period_month <= date_trunc('month', v_period.period_end)::date
    AND asi.status = 'pending';
  IF v_count > 0 THEN
    RETURN QUERY SELECT
      'accrual_installments_pending'::text,
      format('%s periodiseringspost(er) till och med balansdagen är inte bokförda.', v_count),
      v_count;
  END IF;

  -- AR/AP must use the same historical-open-item function as FX and aging.
  -- Missing FX rates fail closed instead of fabricating SEK zeroes.
  SELECT count(*)::integer INTO v_missing_fx
  FROM public.historical_open_items_at(p_company_id, v_period.period_end) hoi
  WHERE hoi.currency <> 'SEK'
    AND (hoi.exchange_rate IS NULL OR hoi.exchange_rate <= 0);
  IF v_missing_fx > 0 THEN
    RETURN QUERY SELECT
      'subledger_exchange_rate_missing'::text,
      format('%s öppna valutareskontraposter saknar verifierbar ursprungskurs.', v_missing_fx),
      v_missing_fx;
  END IF;

  SELECT
    round(coalesce(sum(
      CASE WHEN hoi.source_type = 'invoice'
        THEN hoi.open_amount * CASE WHEN hoi.currency = 'SEK' THEN 1 ELSE hoi.exchange_rate END
        ELSE 0 END
    ), 0), 2),
    round(coalesce(sum(
      CASE WHEN hoi.source_type = 'supplier_invoice'
        THEN hoi.open_amount * CASE WHEN hoi.currency = 'SEK' THEN 1 ELSE hoi.exchange_rate END
        ELSE 0 END
    ), 0), 2)
  INTO v_ar_open, v_ap_open
  FROM public.historical_open_items_at(p_company_id, v_period.period_end) hoi;

  SELECT
    round(coalesce(sum(CASE WHEN jel.account_number = '1510'
      THEN jel.debit_amount - jel.credit_amount ELSE 0 END), 0), 2),
    round(coalesce(sum(CASE WHEN jel.account_number = '2440'
      THEN jel.credit_amount - jel.debit_amount ELSE 0 END), 0), 2)
  INTO v_ar_gl, v_ap_gl
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  WHERE je.company_id = p_company_id
    AND je.entry_date <= v_period.period_end
    AND je.status IN ('posted', 'reversed')
    AND jel.account_number IN ('1510', '2440');

  IF abs(coalesce(v_ar_open, 0) - coalesce(v_ar_gl, 0)) >= 0.01 THEN
    RETURN QUERY SELECT
      'accounts_receivable_mismatch'::text,
      format('Kundreskontra (%s kr) stämmer inte mot konto 1510 (%s kr).', v_ar_open, v_ar_gl),
      0;
  END IF;

  IF abs(coalesce(v_ap_open, 0) - coalesce(v_ap_gl, 0)) >= 0.01 THEN
    RETURN QUERY SELECT
      'accounts_payable_mismatch'::text,
      format('Leverantörsreskontra (%s kr) stämmer inte mot konto 2440 (%s kr).', v_ap_open, v_ap_gl),
      0;
  END IF;

  RETURN;
EXCEPTION
  WHEN OTHERS THEN
    -- Fail closed. The caller sees a database error and execute_year_end_closing
    -- aborts its transaction; no check may degrade to an empty/green result.
    RAISE;
END;
$$;

REVOKE ALL ON FUNCTION public.year_end_db_blockers(uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.year_end_db_blockers(uuid, uuid)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
