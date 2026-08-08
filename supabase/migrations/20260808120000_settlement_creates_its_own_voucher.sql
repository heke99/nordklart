-- =============================================================================
-- Settlement creates its own voucher (H-03)
--
-- settle_customer_invoice / settle_supplier_invoice take a draft journal entry
-- that the application created in a SEPARATE transaction beforehand and then
-- compensate by cancelling it if the settlement rolls back. That leaves a real
-- third state: process death between the two statements strands a draft voucher
-- with no payment behind it, and the compensation is best effort by definition.
--
-- The v2 functions take the entry as data (p_journal) and create it inside the
-- settlement transaction, so no economic object exists before the RPC and there
-- is nothing to compensate. The line-derivation rules stay in TypeScript — this
-- migration only persists a plan it is handed, it never decides which accounts a
-- payment hits. Everything after the voucher creation is byte-identical to v1.
--
-- v1 is left in place and still works; callers move over separately.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Shared: materialise a planned journal entry as a draft, inside the caller's
-- transaction. Not callable on its own — it is SECURITY DEFINER and assumes the
-- caller has already run require_service_role() and the company write check.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_planned_draft_entry(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_journal jsonb,
  p_allowed_source_types text[],
  p_entry_date date,
  p_source_id uuid,
  p_error_code text
)
RETURNS public.journal_entries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period public.fiscal_periods%ROWTYPE;
  v_entry public.journal_entries%ROWTYPE;
  v_source_type text;
  v_fiscal_period_id uuid;
  v_lines jsonb;
  v_missing text;
  v_debit numeric;
  v_credit numeric;
BEGIN
  IF p_journal IS NULL OR jsonb_typeof(p_journal) <> 'object' THEN
    RAISE EXCEPTION 'Journal plan is missing.'
      USING ERRCODE = '22023', DETAIL = format('{"code":"%s"}', p_error_code);
  END IF;

  v_source_type := p_journal->>'source_type';
  v_fiscal_period_id := nullif(p_journal->>'fiscal_period_id', '')::uuid;
  v_lines := p_journal->'lines';

  IF v_source_type IS NULL OR NOT (v_source_type = ANY (p_allowed_source_types))
     OR v_fiscal_period_id IS NULL
     OR (p_journal->>'entry_date')::date <> p_entry_date
     OR nullif(p_journal->>'description', '') IS NULL
     OR nullif(p_journal->>'source_id', '')::uuid IS DISTINCT FROM p_source_id
     OR v_lines IS NULL OR jsonb_typeof(v_lines) <> 'array' OR jsonb_array_length(v_lines) = 0 THEN
    RAISE EXCEPTION 'Journal plan is invalid for this settlement.'
      USING ERRCODE = '22023', DETAIL = format('{"code":"%s"}', p_error_code);
  END IF;

  -- Lock the period exactly as v1 did before touching the ledger, so a period
  -- being closed concurrently cannot slip a payment voucher in behind it.
  SELECT * INTO v_period FROM public.fiscal_periods
  WHERE id = v_fiscal_period_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND OR v_period.is_closed OR v_period.locked_at IS NOT NULL
     OR p_entry_date < v_period.period_start OR p_entry_date > v_period.period_end THEN
    RAISE EXCEPTION 'Payment period is closed or locked.'
      USING ERRCODE = 'P0001', DETAIL = '{"code":"PERIOD_LOCKED"}';
  END IF;

  -- Every account must exist in this company's chart. v1 got this from
  -- createDraftEntry's AccountsNotInChartError; keep it a hard failure rather
  -- than silently writing a line with a null account_id.
  SELECT string_agg(DISTINCT line->>'account_number', ', ') INTO v_missing
  FROM jsonb_array_elements(v_lines) AS line
  WHERE NOT EXISTS (
    SELECT 1 FROM public.chart_of_accounts coa
    WHERE coa.company_id = p_company_id AND coa.account_number = line->>'account_number'
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Accounts are not in the chart of accounts: %', v_missing
      USING ERRCODE = 'P0001', DETAIL = '{"code":"ACCOUNTS_NOT_IN_CHART"}';
  END IF;

  INSERT INTO public.journal_entries (
    company_id, user_id, fiscal_period_id, voucher_number, voucher_series,
    entry_date, description, source_type, source_id, notes, status
  ) VALUES (
    p_company_id, p_actor_user_id, v_fiscal_period_id, 0,
    coalesce(nullif(p_journal->>'voucher_series', ''), 'A'),
    p_entry_date, p_journal->>'description', v_source_type, p_source_id,
    nullif(p_journal->>'notes', ''), 'draft'
  ) RETURNING * INTO v_entry;

  INSERT INTO public.journal_entry_lines (
    journal_entry_id, account_number, account_id, debit_amount, credit_amount,
    currency, amount_in_currency, exchange_rate, line_description,
    tax_code, cost_center, project, sort_order
  )
  SELECT
    v_entry.id,
    line->>'account_number',
    coa.id,
    round(coalesce((line->>'debit_amount')::numeric, 0), 2),
    round(coalesce((line->>'credit_amount')::numeric, 0), 2),
    coalesce(nullif(line->>'currency', ''), 'SEK'),
    nullif(line->>'amount_in_currency', '')::numeric,
    nullif(line->>'exchange_rate', '')::numeric,
    nullif(line->>'line_description', ''),
    nullif(line->>'tax_code', ''),
    nullif(line->>'cost_center', ''),
    nullif(line->>'project', ''),
    (ordinality - 1)::int
  FROM jsonb_array_elements(v_lines) WITH ORDINALITY AS t(line, ordinality)
  LEFT JOIN public.chart_of_accounts coa
    ON coa.company_id = p_company_id AND coa.account_number = t.line->>'account_number';

  SELECT coalesce(sum(debit_amount), 0), coalesce(sum(credit_amount), 0)
    INTO v_debit, v_credit FROM public.journal_entry_lines WHERE journal_entry_id = v_entry.id;
  IF round(v_debit, 2) <= 0 OR round(v_debit, 2) <> round(v_credit, 2) THEN
    RAISE EXCEPTION 'Planned journal entry is not balanced.'
      USING ERRCODE = '23514', DETAIL = '{"code":"INVOICE_PAID_LINES_UNBALANCED"}';
  END IF;

  RETURN v_entry;
END;
$$;

REVOKE ALL ON FUNCTION public.create_planned_draft_entry(uuid,uuid,jsonb,text[],date,uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_planned_draft_entry(uuid,uuid,jsonb,text[],date,uuid,text)
  TO service_role;

-- -----------------------------------------------------------------------------
-- Customer settlement, v2
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.settle_customer_invoice_v2(
  p_company_id uuid,
  p_invoice_id uuid,
  p_actor_user_id uuid,
  p_payment_date date,
  p_payment_amount numeric,
  p_currency text,
  p_exchange_rate_difference numeric,
  p_bank_transaction_id uuid,
  p_idempotency_key text,
  p_payload_hash text,
  p_request_id text,
  p_payment_reference text,
  p_notes text,
  p_journal jsonb,
  p_expected_remaining_amount numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_access record;
  v_invoice public.invoices%ROWTYPE;
  v_existing public.financial_operation_idempotency%ROWTYPE;
  v_entry public.journal_entries%ROWTYPE;
  v_applied numeric;
  v_overpayment numeric;
  v_new_paid numeric;
  v_new_remaining numeric;
  v_new_status text;
  v_payment_id uuid;
  v_credit_id uuid;
  v_result jsonb;
  v_tx record;
BEGIN
  PERFORM public.require_service_role();
  IF p_actor_user_id IS NULL OR p_payment_amount IS NULL OR p_payment_amount <= 0 THEN
    RAISE EXCEPTION 'Invalid settlement input.' USING ERRCODE = '22023', DETAIL = '{"code":"VALIDATION_ERROR"}';
  END IF;
  IF nullif(trim(p_idempotency_key), '') IS NULL OR nullif(trim(p_request_id), '') IS NULL
     OR p_payload_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Missing idempotency/request provenance.' USING ERRCODE = '22023', DETAIL = '{"code":"VALIDATION_ERROR"}';
  END IF;

  SELECT * INTO v_access FROM public.resolve_company_access_for_user(p_actor_user_id, p_company_id);
  IF NOT FOUND OR NOT coalesce(v_access.can_write, false) THEN
    RAISE EXCEPTION 'Actor cannot write this company.' USING ERRCODE = '42501', DETAIL = '{"code":"COMPANY_WRITE_FORBIDDEN"}';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':customer_invoice:' || p_invoice_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':idempotency:customer_invoice_settlement:' || p_idempotency_key, 0));

  SELECT * INTO v_existing FROM public.financial_operation_idempotency
  WHERE company_id = p_company_id AND operation_type = 'customer_invoice_settlement'
    AND idempotency_key = p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_existing.payload_hash <> p_payload_hash THEN
      RAISE EXCEPTION 'Idempotency key was reused with a different payload.'
        USING ERRCODE = 'P0001', DETAIL = '{"code":"IDEMPOTENCY_KEY_REUSE"}';
    END IF;
    RETURN v_existing.result;
  END IF;

  SELECT * INTO v_invoice FROM public.invoices
  WHERE id = p_invoice_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found.' USING ERRCODE = 'P0002', DETAIL = '{"code":"INVOICE_PAID_NOT_FOUND"}';
  END IF;
  IF v_invoice.status NOT IN ('sent', 'overdue', 'partially_paid') THEN
    RAISE EXCEPTION 'Invoice is not payable.' USING ERRCODE = 'P0001', DETAIL = '{"code":"INVOICE_PAID_NOT_PAYABLE"}';
  END IF;
  IF round(coalesce(v_invoice.remaining_amount, 0), 2) <> round(coalesce(p_expected_remaining_amount, -1), 2) THEN
    RAISE EXCEPTION 'Invoice changed after preflight.' USING ERRCODE = '40001', DETAIL = '{"code":"INVOICE_PAID_RACE"}';
  END IF;
  IF upper(coalesce(p_currency, '')) <> upper(coalesce(v_invoice.currency, 'SEK')) THEN
    RAISE EXCEPTION 'Payment currency differs from invoice currency.' USING ERRCODE = '22023', DETAIL = '{"code":"PAYMENT_CURRENCY_MISMATCH"}';
  END IF;

  v_entry := public.create_planned_draft_entry(
    p_company_id, p_actor_user_id, p_journal,
    ARRAY['invoice_paid', 'invoice_cash_payment'],
    p_payment_date, p_invoice_id, 'INVOICE_PAID_BOOK_FAILED'
  );

  IF p_bank_transaction_id IS NOT NULL THEN
    SELECT id, company_id, invoice_id, supplier_invoice_id, journal_entry_id INTO v_tx
    FROM public.transactions WHERE id = p_bank_transaction_id AND company_id = p_company_id FOR UPDATE;
    IF NOT FOUND OR v_tx.supplier_invoice_id IS NOT NULL
       OR (v_tx.invoice_id IS NOT NULL AND v_tx.invoice_id <> p_invoice_id)
       OR (v_tx.journal_entry_id IS NOT NULL AND v_tx.journal_entry_id <> v_entry.id) THEN
      RAISE EXCEPTION 'Bank transaction is already allocated incompatibly.'
        USING ERRCODE = 'P0001', DETAIL = '{"code":"BANK_TRANSACTION_ALREADY_ALLOCATED"}';
    END IF;
  END IF;

  INSERT INTO public.financial_operation_idempotency
    (company_id, operation_type, idempotency_key, payload_hash, request_id, actor_user_id)
  VALUES (p_company_id, 'customer_invoice_settlement', p_idempotency_key, p_payload_hash, p_request_id, p_actor_user_id)
  RETURNING * INTO v_existing;

  v_applied := least(round(p_payment_amount, 2), round(v_invoice.remaining_amount, 2));
  v_overpayment := greatest(round(p_payment_amount - v_applied, 2), 0);
  v_new_paid := round(coalesce(v_invoice.paid_amount, 0) + v_applied, 2);
  v_new_remaining := greatest(round(v_invoice.remaining_amount - v_applied, 2), 0);
  v_new_status := CASE WHEN v_new_remaining <= 0.005 THEN 'paid' ELSE 'partially_paid' END;

  PERFORM public.commit_journal_entry(p_company_id, v_entry.id, 'atomic_customer_settlement', NULL, 'user', NULL);

  INSERT INTO public.invoice_payments (
    user_id, company_id, invoice_id, payment_date, amount, currency,
    exchange_rate, exchange_rate_difference, journal_entry_id, transaction_id,
    notes, idempotency_key, request_id, payment_reference
  ) VALUES (
    p_actor_user_id, p_company_id, p_invoice_id, p_payment_date, v_applied,
    v_invoice.currency, v_invoice.exchange_rate, coalesce(p_exchange_rate_difference, 0),
    v_entry.id, p_bank_transaction_id, p_notes, p_idempotency_key, p_request_id, p_payment_reference
  ) RETURNING id INTO v_payment_id;

  UPDATE public.invoice_payment_adjustments
    SET status = 'resolved', updated_at = now()
  WHERE company_id = p_company_id AND invoice_id = p_invoice_id
    AND adjustment_type = 'underpayment' AND status = 'open';

  IF v_overpayment > 0 THEN
    INSERT INTO public.customer_account_credits (
      user_id, company_id, customer_id, source_invoice_id, source_payment_id,
      source_transaction_id, source_journal_entry_id, amount, remaining_amount,
      currency, status, reason, notes
    ) VALUES (
      p_actor_user_id, p_company_id, v_invoice.customer_id, p_invoice_id, v_payment_id,
      p_bank_transaction_id, v_entry.id, v_overpayment, v_overpayment,
      v_invoice.currency, 'open', 'overpayment', p_notes
    ) RETURNING id INTO v_credit_id;

    INSERT INTO public.invoice_payment_adjustments (
      user_id, company_id, invoice_id, payment_id, transaction_id, customer_credit_id,
      journal_entry_id, adjustment_date, adjustment_type, amount, currency, status, notes
    ) VALUES (
      p_actor_user_id, p_company_id, p_invoice_id, v_payment_id, p_bank_transaction_id,
      v_credit_id, v_entry.id, p_payment_date, 'overpayment', v_overpayment,
      v_invoice.currency, 'posted', p_notes
    );
  ELSIF v_new_remaining > 0 THEN
    INSERT INTO public.invoice_payment_adjustments (
      user_id, company_id, invoice_id, payment_id, transaction_id, journal_entry_id,
      adjustment_date, adjustment_type, amount, currency, status, notes
    ) VALUES (
      p_actor_user_id, p_company_id, p_invoice_id, v_payment_id, p_bank_transaction_id,
      v_entry.id, p_payment_date, 'underpayment', v_new_remaining,
      v_invoice.currency, 'open', p_notes
    );
  END IF;

  UPDATE public.invoices SET
    status = v_new_status,
    paid_amount = v_new_paid,
    remaining_amount = v_new_remaining,
    paid_at = CASE WHEN v_new_status = 'paid' THEN p_payment_date::timestamptz ELSE NULL END,
    payment_journal_entry_id = v_entry.id,
    payment_resolution_status = CASE
      WHEN v_overpayment > 0 THEN 'customer_credit'
      WHEN v_new_remaining > 0 THEN 'has_difference'
      ELSE 'resolved' END,
    updated_at = now()
  WHERE id = p_invoice_id;

  IF p_bank_transaction_id IS NOT NULL THEN
    UPDATE public.transactions SET invoice_id = p_invoice_id, journal_entry_id = v_entry.id, updated_at = now()
    WHERE id = p_bank_transaction_id;
  END IF;

  v_result := jsonb_build_object(
    'invoice_id', p_invoice_id, 'payment_id', v_payment_id, 'journal_entry_id', v_entry.id,
    'customer_credit_id', v_credit_id, 'applied_amount', v_applied,
    'overpayment_amount', v_overpayment, 'paid_amount', v_new_paid,
    'remaining_amount', v_new_remaining, 'status', v_new_status,
    'paid_at', CASE WHEN v_new_status = 'paid' THEN p_payment_date::text ELSE NULL END,
    'request_id', p_request_id
  );

  INSERT INTO public.financial_outbox_events
    (company_id, event_type, aggregate_type, aggregate_id, request_id, idempotency_key, payload)
  VALUES (p_company_id, 'invoice.paid', 'invoice', p_invoice_id, p_request_id, p_idempotency_key, v_result);

  INSERT INTO public.audit_log
    (user_id, company_id, action, table_name, record_id, actor_id, actor_type, old_state, new_state, description)
  VALUES (
    p_actor_user_id, p_company_id, 'SECURITY_EVENT', 'invoices', p_invoice_id,
    p_actor_user_id, 'user', to_jsonb(v_invoice), v_result,
    'Atomic customer invoice settlement; request_id=' || p_request_id
  );

  UPDATE public.financial_operation_idempotency
  SET result = v_result, completed_at = now(), updated_at = now()
  WHERE id = v_existing.id;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.settle_customer_invoice_v2(uuid,uuid,uuid,date,numeric,text,numeric,uuid,text,text,text,text,text,jsonb,numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_customer_invoice_v2(uuid,uuid,uuid,date,numeric,text,numeric,uuid,text,text,text,text,text,jsonb,numeric)
  TO service_role;

-- -----------------------------------------------------------------------------
-- Supplier settlement, v2
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.settle_supplier_invoice_v2(
  p_company_id uuid,
  p_supplier_invoice_id uuid,
  p_actor_user_id uuid,
  p_payment_date date,
  p_payment_amount numeric,
  p_currency text,
  p_exchange_rate_difference numeric,
  p_bank_transaction_id uuid,
  p_idempotency_key text,
  p_payload_hash text,
  p_request_id text,
  p_payment_reference text,
  p_notes text,
  p_journal jsonb,
  p_expected_remaining_amount numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_access record;
  v_invoice public.supplier_invoices%ROWTYPE;
  v_existing public.financial_operation_idempotency%ROWTYPE;
  v_entry public.journal_entries%ROWTYPE;
  v_new_paid numeric;
  v_new_remaining numeric;
  v_new_status text;
  v_payment_id uuid;
  v_result jsonb;
  v_tx record;
BEGIN
  PERFORM public.require_service_role();
  IF p_actor_user_id IS NULL OR p_payment_amount IS NULL OR p_payment_amount <= 0 THEN
    RAISE EXCEPTION 'Invalid settlement input.' USING ERRCODE = '22023', DETAIL = '{"code":"VALIDATION_ERROR"}';
  END IF;
  IF nullif(trim(p_idempotency_key), '') IS NULL OR nullif(trim(p_request_id), '') IS NULL
     OR p_payload_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Missing idempotency/request provenance.' USING ERRCODE = '22023', DETAIL = '{"code":"VALIDATION_ERROR"}';
  END IF;
  SELECT * INTO v_access FROM public.resolve_company_access_for_user(p_actor_user_id, p_company_id);
  IF NOT FOUND OR NOT coalesce(v_access.can_write, false) THEN
    RAISE EXCEPTION 'Actor cannot write this company.' USING ERRCODE = '42501', DETAIL = '{"code":"COMPANY_WRITE_FORBIDDEN"}';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':supplier_invoice:' || p_supplier_invoice_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':idempotency:supplier_invoice_settlement:' || p_idempotency_key, 0));

  SELECT * INTO v_existing FROM public.financial_operation_idempotency
  WHERE company_id = p_company_id AND operation_type = 'supplier_invoice_settlement'
    AND idempotency_key = p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_existing.payload_hash <> p_payload_hash THEN
      RAISE EXCEPTION 'Idempotency key was reused with a different payload.'
        USING ERRCODE = 'P0001', DETAIL = '{"code":"IDEMPOTENCY_KEY_REUSE"}';
    END IF;
    RETURN v_existing.result;
  END IF;

  SELECT * INTO v_invoice FROM public.supplier_invoices
  WHERE id = p_supplier_invoice_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Supplier invoice not found.' USING ERRCODE = 'P0002', DETAIL = '{"code":"SI_NOT_FOUND"}';
  END IF;
  IF v_invoice.is_credit_note OR v_invoice.status NOT IN ('registered', 'approved', 'partially_paid', 'overdue') THEN
    RAISE EXCEPTION 'Supplier invoice is not payable.' USING ERRCODE = 'P0001', DETAIL = '{"code":"SI_PAID_NOT_PAYABLE"}';
  END IF;
  IF round(v_invoice.remaining_amount, 2) <> round(coalesce(p_expected_remaining_amount, -1), 2) THEN
    RAISE EXCEPTION 'Supplier invoice changed after preflight.' USING ERRCODE = '40001', DETAIL = '{"code":"SI_PAID_RACE"}';
  END IF;
  IF round(p_payment_amount, 2) > round(v_invoice.remaining_amount, 2) + 0.005 THEN
    RAISE EXCEPTION 'Supplier overpayment is not supported by this operation.' USING ERRCODE = '22023', DETAIL = '{"code":"VALIDATION_ERROR"}';
  END IF;
  IF upper(coalesce(p_currency, '')) <> upper(coalesce(v_invoice.currency, 'SEK')) THEN
    RAISE EXCEPTION 'Payment currency differs from supplier invoice currency.' USING ERRCODE = '22023', DETAIL = '{"code":"PAYMENT_CURRENCY_MISMATCH"}';
  END IF;

  v_entry := public.create_planned_draft_entry(
    p_company_id, p_actor_user_id, p_journal,
    ARRAY['supplier_invoice_paid', 'supplier_invoice_cash_payment'],
    p_payment_date, p_supplier_invoice_id, 'SI_PAID_FAILED'
  );

  IF p_bank_transaction_id IS NOT NULL THEN
    SELECT id, company_id, invoice_id, supplier_invoice_id, journal_entry_id INTO v_tx
    FROM public.transactions WHERE id = p_bank_transaction_id AND company_id = p_company_id FOR UPDATE;
    IF NOT FOUND OR v_tx.invoice_id IS NOT NULL
       OR (v_tx.supplier_invoice_id IS NOT NULL AND v_tx.supplier_invoice_id <> p_supplier_invoice_id)
       OR (v_tx.journal_entry_id IS NOT NULL AND v_tx.journal_entry_id <> v_entry.id) THEN
      RAISE EXCEPTION 'Bank transaction is already allocated incompatibly.'
        USING ERRCODE = 'P0001', DETAIL = '{"code":"BANK_TRANSACTION_ALREADY_ALLOCATED"}';
    END IF;
  END IF;

  INSERT INTO public.financial_operation_idempotency
    (company_id, operation_type, idempotency_key, payload_hash, request_id, actor_user_id)
  VALUES (p_company_id, 'supplier_invoice_settlement', p_idempotency_key, p_payload_hash, p_request_id, p_actor_user_id)
  RETURNING * INTO v_existing;

  v_new_paid := round(coalesce(v_invoice.paid_amount, 0) + p_payment_amount, 2);
  v_new_remaining := greatest(round(v_invoice.remaining_amount - p_payment_amount, 2), 0);
  v_new_status := CASE WHEN v_new_remaining <= 0.005 THEN 'paid' ELSE 'partially_paid' END;

  PERFORM public.commit_journal_entry(p_company_id, v_entry.id, 'atomic_supplier_settlement', NULL, 'user', NULL);

  INSERT INTO public.supplier_invoice_payments (
    user_id, company_id, supplier_invoice_id, payment_date, amount, currency,
    exchange_rate, exchange_rate_difference, journal_entry_id, transaction_id,
    notes, idempotency_key, request_id, payment_reference
  ) VALUES (
    p_actor_user_id, p_company_id, p_supplier_invoice_id, p_payment_date,
    round(p_payment_amount, 2), v_invoice.currency, v_invoice.exchange_rate,
    coalesce(p_exchange_rate_difference, 0), v_entry.id, p_bank_transaction_id,
    p_notes, p_idempotency_key, p_request_id, p_payment_reference
  ) RETURNING id INTO v_payment_id;

  UPDATE public.supplier_invoices SET
    status = v_new_status,
    paid_amount = v_new_paid,
    remaining_amount = v_new_remaining,
    paid_at = CASE WHEN v_new_status = 'paid' THEN p_payment_date::timestamptz ELSE NULL END,
    payment_journal_entry_id = v_entry.id,
    transaction_id = coalesce(p_bank_transaction_id, transaction_id),
    updated_at = now()
  WHERE id = p_supplier_invoice_id;

  IF p_bank_transaction_id IS NOT NULL THEN
    UPDATE public.transactions SET supplier_invoice_id = p_supplier_invoice_id, journal_entry_id = v_entry.id, updated_at = now()
    WHERE id = p_bank_transaction_id;
  END IF;

  v_result := jsonb_build_object(
    'supplier_invoice_id', p_supplier_invoice_id, 'payment_id', v_payment_id,
    'journal_entry_id', v_entry.id, 'applied_amount', round(p_payment_amount, 2),
    'paid_amount', v_new_paid, 'remaining_amount', v_new_remaining,
    'status', v_new_status, 'paid_at', CASE WHEN v_new_status = 'paid' THEN p_payment_date::text ELSE NULL END,
    'request_id', p_request_id
  );

  INSERT INTO public.financial_outbox_events
    (company_id, event_type, aggregate_type, aggregate_id, request_id, idempotency_key, payload)
  VALUES (p_company_id, 'supplier_invoice.paid', 'supplier_invoice', p_supplier_invoice_id, p_request_id, p_idempotency_key, v_result);

  INSERT INTO public.audit_log
    (user_id, company_id, action, table_name, record_id, actor_id, actor_type, old_state, new_state, description)
  VALUES (
    p_actor_user_id, p_company_id, 'SECURITY_EVENT', 'supplier_invoices', p_supplier_invoice_id,
    p_actor_user_id, 'user', to_jsonb(v_invoice), v_result,
    'Atomic supplier invoice settlement; request_id=' || p_request_id
  );

  UPDATE public.financial_operation_idempotency
  SET result = v_result, completed_at = now(), updated_at = now()
  WHERE id = v_existing.id;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.settle_supplier_invoice_v2(uuid,uuid,uuid,date,numeric,text,numeric,uuid,text,text,text,text,text,jsonb,numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_supplier_invoice_v2(uuid,uuid,uuid,date,numeric,text,numeric,uuid,text,text,text,text,text,jsonb,numeric)
  TO service_role;

NOTIFY pgrst, 'reload schema';
