-- Production hardening: atomic AR/AP settlements, posted-entry immutability,
-- durable financial outbox/idempotency and complete one-time Stripe lifecycle.
-- Forward-only: no economic data is rewritten by this migration.

-- =============================================================================
-- 1. Canonical financial operation idempotency and durable outbox
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.financial_operation_idempotency (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  operation_type text NOT NULL,
  idempotency_key text NOT NULL,
  payload_hash text NOT NULL,
  request_id text NOT NULL,
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  result jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT financial_operation_idempotency_key_nonempty CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 200),
  CONSTRAINT financial_operation_payload_hash_format CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT financial_operation_unique UNIQUE (company_id, operation_type, idempotency_key)
);

CREATE INDEX IF NOT EXISTS financial_operation_idempotency_request_idx
  ON public.financial_operation_idempotency (request_id);

CREATE TABLE IF NOT EXISTS public.financial_outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  request_id text NOT NULL,
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivered', 'failed', 'dead_letter')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT financial_outbox_event_unique UNIQUE (company_id, event_type, idempotency_key)
);

CREATE INDEX IF NOT EXISTS financial_outbox_pending_idx
  ON public.financial_outbox_events (status, available_at, created_at)
  WHERE status IN ('pending', 'failed');

ALTER TABLE public.financial_operation_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_outbox_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.financial_operation_idempotency FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.financial_outbox_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.financial_operation_idempotency TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.financial_outbox_events TO service_role;

-- Explicit payment provenance and a dedicated customer payment JE link. The
-- old invoices.journal_entry_id remains the invoice-registration JE.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS payment_journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL;
ALTER TABLE public.invoice_payments
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS request_id text,
  ADD COLUMN IF NOT EXISTS payment_reference text;
ALTER TABLE public.supplier_invoice_payments
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS request_id text,
  ADD COLUMN IF NOT EXISTS payment_reference text;

CREATE UNIQUE INDEX IF NOT EXISTS invoice_payments_company_idempotency_uidx
  ON public.invoice_payments (company_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS supplier_invoice_payments_company_idempotency_uidx
  ON public.supplier_invoice_payments (company_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
-- Existing production data may already contain duplicates. Do not make the
-- migration fail or silently choose a winner. Create uniqueness only when the
-- existing set is clean; a locking trigger below prevents every new duplicate
-- across both customer and supplier payment tables.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.invoice_payments
    WHERE transaction_id IS NOT NULL
    GROUP BY company_id, transaction_id HAVING count(*) > 1
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS invoice_payments_bank_tx_unique
      ON public.invoice_payments (company_id, transaction_id)
      WHERE transaction_id IS NOT NULL';
  ELSE
    EXECUTE 'CREATE INDEX IF NOT EXISTS invoice_payments_bank_tx_review_idx
      ON public.invoice_payments (company_id, transaction_id)
      WHERE transaction_id IS NOT NULL';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.supplier_invoice_payments
    WHERE transaction_id IS NOT NULL
    GROUP BY company_id, transaction_id HAVING count(*) > 1
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS supplier_invoice_payments_bank_tx_unique
      ON public.supplier_invoice_payments (company_id, transaction_id)
      WHERE transaction_id IS NOT NULL';
  ELSE
    EXECUTE 'CREATE INDEX IF NOT EXISTS supplier_invoice_payments_bank_tx_review_idx
      ON public.supplier_invoice_payments (company_id, transaction_id)
      WHERE transaction_id IS NOT NULL';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_single_bank_payment_allocation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.transaction_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- A common locked parent row serializes customer-vs-supplier races that two
  -- independent unique indexes cannot see.
  PERFORM 1
  FROM public.transactions t
  WHERE t.id = NEW.transaction_id AND t.company_id = NEW.company_id
  FOR UPDATE;

  IF TG_TABLE_NAME = 'invoice_payments' THEN
    IF EXISTS (
      SELECT 1 FROM public.invoice_payments ip
      WHERE ip.company_id = NEW.company_id
        AND ip.transaction_id = NEW.transaction_id
        AND ip.id IS DISTINCT FROM NEW.id
    ) OR EXISTS (
      SELECT 1 FROM public.supplier_invoice_payments sip
      WHERE sip.company_id = NEW.company_id
        AND sip.transaction_id = NEW.transaction_id
    ) THEN
      RAISE EXCEPTION 'Bank transaction is already allocated to a payment.'
        USING ERRCODE = '23505', DETAIL = '{"code":"BANK_TRANSACTION_ALREADY_ALLOCATED"}';
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1 FROM public.supplier_invoice_payments sip
      WHERE sip.company_id = NEW.company_id
        AND sip.transaction_id = NEW.transaction_id
        AND sip.id IS DISTINCT FROM NEW.id
    ) OR EXISTS (
      SELECT 1 FROM public.invoice_payments ip
      WHERE ip.company_id = NEW.company_id
        AND ip.transaction_id = NEW.transaction_id
    ) THEN
      RAISE EXCEPTION 'Bank transaction is already allocated to a payment.'
        USING ERRCODE = '23505', DETAIL = '{"code":"BANK_TRANSACTION_ALREADY_ALLOCATED"}';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_single_bank_payment_allocation_customer ON public.invoice_payments;
CREATE TRIGGER enforce_single_bank_payment_allocation_customer
  BEFORE INSERT OR UPDATE OF transaction_id, company_id ON public.invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_single_bank_payment_allocation();

DROP TRIGGER IF EXISTS enforce_single_bank_payment_allocation_supplier ON public.supplier_invoice_payments;
CREATE TRIGGER enforce_single_bank_payment_allocation_supplier
  BEFORE INSERT OR UPDATE OF transaction_id, company_id ON public.supplier_invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_single_bank_payment_allocation();

-- =============================================================================
-- 2. Posted entries may only transition to reversed, never cancelled
-- =============================================================================
CREATE OR REPLACE FUNCTION public.enforce_journal_entry_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('nordklart.allow_delete', true) = 'true' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Cannot delete journal entries (id: %, status: %).', OLD.id, OLD.status
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'draft' AND NEW.status IN ('draft', 'posted', 'cancelled') THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'posted' AND NEW.status = 'reversed' THEN
    IF NEW.reversed_by_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM public.journal_entries reversal
      WHERE reversal.id = NEW.reversed_by_id
        AND reversal.company_id = OLD.company_id
        AND reversal.reverses_id = OLD.id
        AND reversal.status = 'posted'
    ) THEN
      RAISE EXCEPTION 'A posted entry can only be reversed by a posted, mutually linked correction entry.'
        USING ERRCODE = '55000', DETAIL = '{"code":"REVERSAL_LINK_REQUIRED"}';
    END IF;
    IF NEW.description IS DISTINCT FROM OLD.description
       OR NEW.entry_date IS DISTINCT FROM OLD.entry_date
       OR NEW.fiscal_period_id IS DISTINCT FROM OLD.fiscal_period_id
       OR NEW.voucher_number IS DISTINCT FROM OLD.voucher_number
       OR NEW.voucher_series IS DISTINCT FROM OLD.voucher_series
       OR NEW.commit_method IS DISTINCT FROM OLD.commit_method
       OR NEW.rubric_version IS DISTINCT FROM OLD.rubric_version
       OR NEW.source_voucher_series IS DISTINCT FROM OLD.source_voucher_series
       OR NEW.source_voucher_number IS DISTINCT FROM OLD.source_voucher_number THEN
      RAISE EXCEPTION 'Cannot modify fields of a posted entry during reversal (id: %)', OLD.id
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'reversed' AND NEW.status = 'posted'
     AND current_setting('nordklart.allow_delete', true) = 'true' THEN
    IF (to_jsonb(NEW) - 'status' - 'updated_at') <> (to_jsonb(OLD) - 'status' - 'updated_at') THEN
      RAISE EXCEPTION 'Cannot modify fields during controlled un-reversal (id: %)', OLD.id
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = NEW.status
     AND OLD.status IN ('posted', 'reversed', 'cancelled')
     AND (to_jsonb(NEW) - 'notes' - 'updated_at') = (to_jsonb(OLD) - 'notes' - 'updated_at') THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'posted' AND NEW.status = 'cancelled' THEN
    RAISE EXCEPTION 'Posted journal entries must be corrected through a linked reversal.'
      USING ERRCODE = '55000', DETAIL = '{"code":"POSTED_ENTRY_REQUIRES_REVERSAL"}';
  END IF;

  RAISE EXCEPTION 'Cannot modify a % journal entry (id: %). Committed entries are immutable.', OLD.status, OLD.id
    USING ERRCODE = '55000';
END;
$function$;

-- Read-only inventory for controlled review. No automatic repair is performed.
-- Harden the existing canonical posting function as well. The function is
-- SECURITY DEFINER and therefore must never inherit a caller-controlled path.
ALTER FUNCTION public.commit_journal_entry(uuid,uuid,text,text,text,text)
  SET search_path = public, pg_temp;

CREATE OR REPLACE VIEW public.cancelled_committed_journal_entry_inventory AS
SELECT
  je.company_id,
  je.id AS journal_entry_id,
  je.fiscal_period_id,
  je.voucher_series,
  je.voucher_number,
  je.entry_date,
  je.source_type,
  je.source_id,
  je.user_id,
  je.created_at,
  je.updated_at,
  CASE
    WHEN je.voucher_number = 0 THEN 'draft_with_cancelled_status'
    WHEN je.reverses_id IS NOT NULL OR je.reversed_by_id IS NOT NULL THEN 'linked_reversal_requires_review'
    WHEN je.source_type IN ('import', 'sie_import') THEN 'imported_committed_cancelled_requires_review'
    ELSE 'business_event_excluded_without_reversal'
  END AS classification
FROM public.journal_entries je
WHERE je.status = 'cancelled'
  AND (je.voucher_number > 0 OR je.committed_at IS NOT NULL);

REVOKE ALL ON public.cancelled_committed_journal_entry_inventory FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.cancelled_committed_journal_entry_inventory TO service_role;

-- =============================================================================
-- 3. Idempotency lookup used before staging a new draft journal entry
-- =============================================================================
CREATE OR REPLACE FUNCTION public.get_financial_operation_result(
  p_company_id uuid,
  p_operation_type text,
  p_idempotency_key text,
  p_payload_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.financial_operation_idempotency%ROWTYPE;
BEGIN
  PERFORM public.require_service_role();
  SELECT * INTO v_row
  FROM public.financial_operation_idempotency
  WHERE company_id = p_company_id
    AND operation_type = p_operation_type
    AND idempotency_key = p_idempotency_key;

  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_row.payload_hash <> p_payload_hash THEN
    RAISE EXCEPTION 'Idempotency key was reused with a different payload.'
      USING ERRCODE = 'P0001', DETAIL = '{"code":"IDEMPOTENCY_KEY_REUSE"}';
  END IF;
  RETURN v_row.result;
END;
$$;

-- =============================================================================
-- 4. Atomic customer invoice settlement
-- =============================================================================
CREATE OR REPLACE FUNCTION public.settle_customer_invoice(
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
  p_draft_journal_entry_id uuid,
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
  v_period public.fiscal_periods%ROWTYPE;
  v_draft public.journal_entries%ROWTYPE;
  v_debit numeric;
  v_credit numeric;
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

  SELECT * INTO v_draft FROM public.journal_entries
  WHERE id = p_draft_journal_entry_id AND company_id = p_company_id AND user_id = p_actor_user_id
    AND status = 'draft' AND source_id = p_invoice_id
    AND source_type IN ('invoice_paid', 'invoice_cash_payment') FOR UPDATE;
  IF NOT FOUND OR v_draft.entry_date <> p_payment_date THEN
    RAISE EXCEPTION 'Canonical draft journal entry is missing or invalid.'
      USING ERRCODE = 'P0001', DETAIL = '{"code":"INVOICE_PAID_BOOK_FAILED"}';
  END IF;

  SELECT * INTO v_period FROM public.fiscal_periods
  WHERE id = v_draft.fiscal_period_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND OR v_period.is_closed OR v_period.locked_at IS NOT NULL
     OR p_payment_date < v_period.period_start OR p_payment_date > v_period.period_end THEN
    RAISE EXCEPTION 'Payment period is closed or locked.' USING ERRCODE = 'P0001', DETAIL = '{"code":"PERIOD_LOCKED"}';
  END IF;

  SELECT coalesce(sum(debit_amount), 0), coalesce(sum(credit_amount), 0)
    INTO v_debit, v_credit FROM public.journal_entry_lines WHERE journal_entry_id = v_draft.id;
  IF round(v_debit, 2) <= 0 OR round(v_debit, 2) <> round(v_credit, 2) THEN
    RAISE EXCEPTION 'Draft journal entry is not balanced.' USING ERRCODE = '23514', DETAIL = '{"code":"INVOICE_PAID_LINES_UNBALANCED"}';
  END IF;

  IF p_bank_transaction_id IS NOT NULL THEN
    SELECT id, company_id, invoice_id, supplier_invoice_id, journal_entry_id INTO v_tx
    FROM public.transactions WHERE id = p_bank_transaction_id AND company_id = p_company_id FOR UPDATE;
    IF NOT FOUND OR v_tx.supplier_invoice_id IS NOT NULL
       OR (v_tx.invoice_id IS NOT NULL AND v_tx.invoice_id <> p_invoice_id)
       OR (v_tx.journal_entry_id IS NOT NULL AND v_tx.journal_entry_id <> v_draft.id) THEN
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

  PERFORM public.commit_journal_entry(p_company_id, v_draft.id, 'atomic_customer_settlement', NULL, 'user', NULL);

  INSERT INTO public.invoice_payments (
    user_id, company_id, invoice_id, payment_date, amount, currency,
    exchange_rate, exchange_rate_difference, journal_entry_id, transaction_id,
    notes, idempotency_key, request_id, payment_reference
  ) VALUES (
    p_actor_user_id, p_company_id, p_invoice_id, p_payment_date, v_applied,
    v_invoice.currency, v_invoice.exchange_rate, coalesce(p_exchange_rate_difference, 0),
    v_draft.id, p_bank_transaction_id, p_notes, p_idempotency_key, p_request_id, p_payment_reference
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
      p_bank_transaction_id, v_draft.id, v_overpayment, v_overpayment,
      v_invoice.currency, 'open', 'overpayment', p_notes
    ) RETURNING id INTO v_credit_id;

    INSERT INTO public.invoice_payment_adjustments (
      user_id, company_id, invoice_id, payment_id, transaction_id, customer_credit_id,
      journal_entry_id, adjustment_date, adjustment_type, amount, currency, status, notes
    ) VALUES (
      p_actor_user_id, p_company_id, p_invoice_id, v_payment_id, p_bank_transaction_id,
      v_credit_id, v_draft.id, p_payment_date, 'overpayment', v_overpayment,
      v_invoice.currency, 'posted', p_notes
    );
  ELSIF v_new_remaining > 0 THEN
    INSERT INTO public.invoice_payment_adjustments (
      user_id, company_id, invoice_id, payment_id, transaction_id, journal_entry_id,
      adjustment_date, adjustment_type, amount, currency, status, notes
    ) VALUES (
      p_actor_user_id, p_company_id, p_invoice_id, v_payment_id, p_bank_transaction_id,
      v_draft.id, p_payment_date, 'underpayment', v_new_remaining,
      v_invoice.currency, 'open', p_notes
    );
  END IF;

  UPDATE public.invoices SET
    status = v_new_status,
    paid_amount = v_new_paid,
    remaining_amount = v_new_remaining,
    paid_at = CASE WHEN v_new_status = 'paid' THEN p_payment_date::timestamptz ELSE NULL END,
    payment_journal_entry_id = v_draft.id,
    payment_resolution_status = CASE
      WHEN v_overpayment > 0 THEN 'customer_credit'
      WHEN v_new_remaining > 0 THEN 'has_difference'
      ELSE 'resolved' END,
    updated_at = now()
  WHERE id = p_invoice_id;

  IF p_bank_transaction_id IS NOT NULL THEN
    UPDATE public.transactions SET invoice_id = p_invoice_id, journal_entry_id = v_draft.id, updated_at = now()
    WHERE id = p_bank_transaction_id;
  END IF;

  v_result := jsonb_build_object(
    'invoice_id', p_invoice_id, 'payment_id', v_payment_id, 'journal_entry_id', v_draft.id,
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

-- =============================================================================
-- 5. Atomic supplier invoice settlement
-- =============================================================================
CREATE OR REPLACE FUNCTION public.settle_supplier_invoice(
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
  p_draft_journal_entry_id uuid,
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
  v_period public.fiscal_periods%ROWTYPE;
  v_draft public.journal_entries%ROWTYPE;
  v_debit numeric;
  v_credit numeric;
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

  SELECT * INTO v_draft FROM public.journal_entries
  WHERE id = p_draft_journal_entry_id AND company_id = p_company_id AND user_id = p_actor_user_id
    AND status = 'draft' AND source_id = p_supplier_invoice_id
    AND source_type IN ('supplier_invoice_paid', 'supplier_invoice_cash_payment') FOR UPDATE;
  IF NOT FOUND OR v_draft.entry_date <> p_payment_date THEN
    RAISE EXCEPTION 'Canonical draft journal entry is missing or invalid.' USING ERRCODE = 'P0001', DETAIL = '{"code":"SI_PAID_FAILED"}';
  END IF;

  SELECT * INTO v_period FROM public.fiscal_periods
  WHERE id = v_draft.fiscal_period_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND OR v_period.is_closed OR v_period.locked_at IS NOT NULL
     OR p_payment_date < v_period.period_start OR p_payment_date > v_period.period_end THEN
    RAISE EXCEPTION 'Payment period is closed or locked.' USING ERRCODE = 'P0001', DETAIL = '{"code":"PERIOD_LOCKED"}';
  END IF;

  SELECT coalesce(sum(debit_amount), 0), coalesce(sum(credit_amount), 0)
    INTO v_debit, v_credit FROM public.journal_entry_lines WHERE journal_entry_id = v_draft.id;
  IF round(v_debit, 2) <= 0 OR round(v_debit, 2) <> round(v_credit, 2) THEN
    RAISE EXCEPTION 'Draft journal entry is not balanced.' USING ERRCODE = '23514', DETAIL = '{"code":"INVOICE_PAID_LINES_UNBALANCED"}';
  END IF;

  IF p_bank_transaction_id IS NOT NULL THEN
    SELECT id, company_id, invoice_id, supplier_invoice_id, journal_entry_id INTO v_tx
    FROM public.transactions WHERE id = p_bank_transaction_id AND company_id = p_company_id FOR UPDATE;
    IF NOT FOUND OR v_tx.invoice_id IS NOT NULL
       OR (v_tx.supplier_invoice_id IS NOT NULL AND v_tx.supplier_invoice_id <> p_supplier_invoice_id)
       OR (v_tx.journal_entry_id IS NOT NULL AND v_tx.journal_entry_id <> v_draft.id) THEN
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

  PERFORM public.commit_journal_entry(p_company_id, v_draft.id, 'atomic_supplier_settlement', NULL, 'user', NULL);

  INSERT INTO public.supplier_invoice_payments (
    user_id, company_id, supplier_invoice_id, payment_date, amount, currency,
    exchange_rate, exchange_rate_difference, journal_entry_id, transaction_id,
    notes, idempotency_key, request_id, payment_reference
  ) VALUES (
    p_actor_user_id, p_company_id, p_supplier_invoice_id, p_payment_date,
    round(p_payment_amount, 2), v_invoice.currency, v_invoice.exchange_rate,
    coalesce(p_exchange_rate_difference, 0), v_draft.id, p_bank_transaction_id,
    p_notes, p_idempotency_key, p_request_id, p_payment_reference
  ) RETURNING id INTO v_payment_id;

  UPDATE public.supplier_invoices SET
    status = v_new_status,
    paid_amount = v_new_paid,
    remaining_amount = v_new_remaining,
    paid_at = CASE WHEN v_new_status = 'paid' THEN p_payment_date::timestamptz ELSE NULL END,
    payment_journal_entry_id = v_draft.id,
    transaction_id = coalesce(p_bank_transaction_id, transaction_id),
    updated_at = now()
  WHERE id = p_supplier_invoice_id;

  IF p_bank_transaction_id IS NOT NULL THEN
    UPDATE public.transactions SET supplier_invoice_id = p_supplier_invoice_id, journal_entry_id = v_draft.id, updated_at = now()
    WHERE id = p_bank_transaction_id;
  END IF;

  v_result := jsonb_build_object(
    'supplier_invoice_id', p_supplier_invoice_id, 'payment_id', v_payment_id,
    'journal_entry_id', v_draft.id, 'applied_amount', round(p_payment_amount, 2),
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

-- =============================================================================
-- 6. Stripe one-time payment lifecycle (async, refund, dispute, out-of-order)
-- =============================================================================
ALTER TABLE public.billing_checkout_sessions
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text,
  ADD COLUMN IF NOT EXISTS stripe_charge_id text,
  ADD COLUMN IF NOT EXISTS payment_status text,
  ADD COLUMN IF NOT EXISTS gross_paid_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refunded_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_stripe_event_id text,
  ADD COLUMN IF NOT EXISTS last_stripe_event_created_at timestamptz;

ALTER TABLE public.one_time_purchases
  ADD COLUMN IF NOT EXISTS stripe_checkout_session_id text,
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text,
  ADD COLUMN IF NOT EXISTS stripe_charge_id text,
  ADD COLUMN IF NOT EXISTS latest_refund_id text,
  ADD COLUMN IF NOT EXISTS gross_paid_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refunded_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_status text,
  ADD COLUMN IF NOT EXISTS access_revoked_at timestamptz,
  ADD COLUMN IF NOT EXISTS revocation_reason text,
  ADD COLUMN IF NOT EXISTS last_stripe_event_id text,
  ADD COLUMN IF NOT EXISTS last_stripe_event_created_at timestamptz;

UPDATE public.one_time_purchases
SET stripe_checkout_session_id = metadata->>'stripe_checkout_session_id'
WHERE stripe_checkout_session_id IS NULL AND metadata ? 'stripe_checkout_session_id';

CREATE UNIQUE INDEX IF NOT EXISTS one_time_purchases_stripe_checkout_uidx
  ON public.one_time_purchases (stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS one_time_purchases_payment_intent_idx
  ON public.one_time_purchases (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS one_time_purchases_charge_idx
  ON public.one_time_purchases (stripe_charge_id)
  WHERE stripe_charge_id IS NOT NULL;

-- Per-refund state is required because Stripe sends refund.created/updated/failed
-- independently and the amount on a refund object is not the charge's cumulative
-- refunded amount. Summing successful refund rows prevents two partial refunds
-- from being collapsed by GREATEST().
CREATE TABLE IF NOT EXISTS public.stripe_one_time_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id uuid NOT NULL REFERENCES public.one_time_purchases(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  stripe_refund_id text NOT NULL UNIQUE,
  stripe_charge_id text,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  status text NOT NULL,
  last_event_id text NOT NULL,
  last_event_created_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stripe_one_time_refunds_purchase_idx
  ON public.stripe_one_time_refunds (purchase_id, status);

CREATE TABLE IF NOT EXISTS public.stripe_one_time_event_applications (
  stripe_event_id text PRIMARY KEY,
  event_type text NOT NULL,
  purchase_id uuid NOT NULL REFERENCES public.one_time_purchases(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  event_created_at timestamptz NOT NULL,
  result jsonb,
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stripe_one_time_event_applications_purchase_idx
  ON public.stripe_one_time_event_applications (purchase_id, event_created_at DESC);

ALTER TABLE public.stripe_one_time_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_one_time_event_applications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.stripe_one_time_refunds FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.stripe_one_time_event_applications FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.stripe_one_time_refunds TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.stripe_one_time_event_applications TO service_role;

CREATE OR REPLACE FUNCTION public.stripe_apply_one_time_purchase_event(
  p_stripe_event_id text,
  p_event_type text,
  p_event_created_at timestamptz,
  p_checkout_session_id text DEFAULT NULL,
  p_payment_intent_id text DEFAULT NULL,
  p_charge_id text DEFAULT NULL,
  p_refund_id text DEFAULT NULL,
  p_payment_status text DEFAULT NULL,
  p_gross_paid_minor bigint DEFAULT NULL,
  p_refunded_minor bigint DEFAULT NULL,
  p_currency text DEFAULT NULL,
  p_dispute_status text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_checkout public.billing_checkout_sessions%ROWTYPE;
  v_purchase public.one_time_purchases%ROWTYPE;
  v_existing_result jsonb;
  v_claimed_event boolean := false;
  v_is_stale boolean := false;
  v_full_refund boolean := false;
  v_successful_refunds bigint := 0;
  v_effective_refunded bigint := 0;
  v_effective_gross bigint := 0;
  v_result jsonb;
BEGIN
  PERFORM public.require_service_role();
  IF nullif(trim(p_stripe_event_id), '') IS NULL OR nullif(trim(p_event_type), '') IS NULL THEN
    RAISE EXCEPTION 'Stripe event provenance is required.'
      USING ERRCODE = '22023', DETAIL = '{"code":"STRIPE_EVENT_INVALID"}';
  END IF;

  SELECT * INTO v_checkout FROM public.billing_checkout_sessions
  WHERE (p_checkout_session_id IS NOT NULL AND stripe_checkout_session_id = p_checkout_session_id)
     OR (p_payment_intent_id IS NOT NULL AND stripe_payment_intent_id = p_payment_intent_id)
     OR (p_charge_id IS NOT NULL AND stripe_charge_id = p_charge_id)
  ORDER BY created_at DESC LIMIT 1 FOR UPDATE;

  IF FOUND THEN
    v_is_stale := v_checkout.last_stripe_event_created_at IS NOT NULL
      AND p_event_created_at IS NOT NULL
      AND p_event_created_at < v_checkout.last_stripe_event_created_at;

    UPDATE public.billing_checkout_sessions SET
      stripe_payment_intent_id = coalesce(nullif(p_payment_intent_id, ''), stripe_payment_intent_id),
      stripe_charge_id = coalesce(nullif(p_charge_id, ''), stripe_charge_id),
      payment_status = CASE WHEN v_is_stale THEN payment_status ELSE coalesce(nullif(p_payment_status, ''), payment_status) END,
      gross_paid_minor = greatest(gross_paid_minor, coalesce(p_gross_paid_minor, 0)),
      refunded_minor = CASE
        WHEN p_refund_id IS NULL THEN greatest(refunded_minor, coalesce(p_refunded_minor, 0))
        ELSE refunded_minor
      END,
      status = CASE
        WHEN NOT v_is_stale AND p_event_type = 'checkout.session.async_payment_failed' THEN 'failed'
        WHEN NOT v_is_stale
          AND p_event_type IN ('checkout.session.async_payment_succeeded', 'checkout.session.completed')
          AND coalesce(p_payment_status, '') IN ('paid', 'no_payment_required') THEN 'completed'
        ELSE status END,
      last_stripe_event_id = CASE WHEN v_is_stale THEN last_stripe_event_id ELSE p_stripe_event_id END,
      last_stripe_event_created_at = CASE WHEN v_is_stale THEN last_stripe_event_created_at ELSE coalesce(p_event_created_at, now()) END,
      updated_at = now()
    WHERE id = v_checkout.id RETURNING * INTO v_checkout;
  END IF;

  SELECT * INTO v_purchase FROM public.one_time_purchases
  WHERE (p_checkout_session_id IS NOT NULL AND stripe_checkout_session_id = p_checkout_session_id)
     OR (p_payment_intent_id IS NOT NULL AND stripe_payment_intent_id = p_payment_intent_id)
     OR (p_charge_id IS NOT NULL AND stripe_charge_id = p_charge_id)
     OR (v_checkout.id IS NOT NULL AND company_id = v_checkout.company_id
         AND fiscal_period_id IS NOT DISTINCT FROM v_checkout.fiscal_period_id
         AND purchase_type = 'year_end')
  ORDER BY created_at DESC LIMIT 1 FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'purchase_not_found');
  END IF;

  INSERT INTO public.stripe_one_time_event_applications
    (stripe_event_id, event_type, purchase_id, company_id, event_created_at)
  VALUES
    (p_stripe_event_id, p_event_type, v_purchase.id, v_purchase.company_id, coalesce(p_event_created_at, now()))
  ON CONFLICT (stripe_event_id) DO NOTHING
  RETURNING true INTO v_claimed_event;

  IF NOT coalesce(v_claimed_event, false) THEN
    SELECT result INTO v_existing_result
    FROM public.stripe_one_time_event_applications
    WHERE stripe_event_id = p_stripe_event_id;
    RETURN coalesce(v_existing_result, jsonb_build_object(
      'applied', false,
      'duplicate', true,
      'purchase_id', v_purchase.id
    ));
  END IF;

  IF p_refund_id IS NOT NULL AND p_refunded_minor IS NOT NULL THEN
    INSERT INTO public.stripe_one_time_refunds
      (purchase_id, company_id, stripe_refund_id, stripe_charge_id, amount_minor, status, last_event_id, last_event_created_at)
    VALUES
      (v_purchase.id, v_purchase.company_id, p_refund_id, p_charge_id,
       greatest(p_refunded_minor, 0), coalesce(nullif(p_payment_status, ''), 'unknown'),
       p_stripe_event_id, coalesce(p_event_created_at, now()))
    ON CONFLICT (stripe_refund_id) DO UPDATE SET
      amount_minor = EXCLUDED.amount_minor,
      status = EXCLUDED.status,
      stripe_charge_id = coalesce(EXCLUDED.stripe_charge_id, public.stripe_one_time_refunds.stripe_charge_id),
      last_event_id = EXCLUDED.last_event_id,
      last_event_created_at = EXCLUDED.last_event_created_at,
      updated_at = now()
    WHERE EXCLUDED.last_event_created_at >= public.stripe_one_time_refunds.last_event_created_at;
  END IF;

  SELECT coalesce(sum(amount_minor) FILTER (WHERE status = 'succeeded'), 0)
  INTO v_successful_refunds
  FROM public.stripe_one_time_refunds
  WHERE purchase_id = v_purchase.id;

  v_effective_refunded := greatest(
    v_purchase.refunded_minor,
    v_successful_refunds,
    CASE WHEN p_refund_id IS NULL THEN coalesce(p_refunded_minor, 0) ELSE 0 END
  );
  v_effective_gross := greatest(v_purchase.gross_paid_minor, coalesce(p_gross_paid_minor, 0));
  v_full_refund := v_effective_gross > 0 AND v_effective_refunded >= v_effective_gross;
  v_is_stale := v_purchase.last_stripe_event_created_at IS NOT NULL
    AND p_event_created_at IS NOT NULL
    AND p_event_created_at < v_purchase.last_stripe_event_created_at;

  UPDATE public.one_time_purchases SET
    stripe_checkout_session_id = coalesce(nullif(p_checkout_session_id, ''), stripe_checkout_session_id),
    stripe_payment_intent_id = coalesce(nullif(p_payment_intent_id, ''), stripe_payment_intent_id),
    stripe_charge_id = coalesce(nullif(p_charge_id, ''), stripe_charge_id),
    latest_refund_id = coalesce(nullif(p_refund_id, ''), latest_refund_id),
    gross_paid_minor = v_effective_gross,
    refunded_minor = v_effective_refunded,
    payment_status = CASE WHEN v_is_stale THEN payment_status ELSE coalesce(nullif(p_payment_status, ''), payment_status) END,
    status = CASE
      WHEN p_event_type = 'charge.dispute.created' THEN 'cancelled'
      WHEN p_event_type = 'charge.dispute.closed' AND coalesce(p_dispute_status, '') IN ('won', 'warning_closed')
        AND NOT v_full_refund THEN CASE WHEN access_starts_at IS NOT NULL THEN 'active' ELSE 'paid' END
      WHEN p_event_type = 'charge.dispute.closed' AND coalesce(p_dispute_status, '') NOT IN ('won', 'warning_closed') THEN 'cancelled'
      WHEN v_full_refund THEN 'refunded'
      ELSE status END,
    access_revoked_at = CASE
      WHEN p_event_type = 'charge.dispute.created' OR v_full_refund
        OR (p_event_type = 'charge.dispute.closed' AND coalesce(p_dispute_status, '') NOT IN ('won', 'warning_closed'))
        THEN coalesce(access_revoked_at, now())
      WHEN p_event_type = 'charge.dispute.closed' AND coalesce(p_dispute_status, '') IN ('won', 'warning_closed') AND NOT v_full_refund
        THEN NULL
      ELSE access_revoked_at END,
    revocation_reason = CASE
      WHEN p_event_type = 'charge.dispute.created' THEN 'stripe_dispute_open'
      WHEN p_event_type = 'charge.dispute.closed' AND coalesce(p_dispute_status, '') NOT IN ('won', 'warning_closed') THEN 'stripe_dispute_lost'
      WHEN v_full_refund THEN 'stripe_full_refund'
      WHEN p_event_type = 'charge.dispute.closed' AND coalesce(p_dispute_status, '') IN ('won', 'warning_closed') AND NOT v_full_refund THEN NULL
      ELSE revocation_reason END,
    metadata = metadata || jsonb_build_object(
      'stripe_partial_refund_policy', 'access_retained_until_full_refund',
      'last_stripe_event_type', p_event_type,
      'last_stripe_event_id', p_stripe_event_id,
      'last_stripe_currency', upper(coalesce(p_currency, currency))
    ),
    last_stripe_event_id = CASE WHEN v_is_stale THEN last_stripe_event_id ELSE p_stripe_event_id END,
    last_stripe_event_created_at = CASE WHEN v_is_stale THEN last_stripe_event_created_at ELSE coalesce(p_event_created_at, now()) END,
    updated_at = now()
  WHERE id = v_purchase.id RETURNING * INTO v_purchase;

  IF v_checkout.id IS NOT NULL THEN
    UPDATE public.billing_checkout_sessions
    SET refunded_minor = v_effective_refunded, updated_at = now()
    WHERE id = v_checkout.id;
  END IF;

  v_result := jsonb_build_object(
    'applied', true, 'purchase_id', v_purchase.id, 'company_id', v_purchase.company_id,
    'status', v_purchase.status, 'payment_status', v_purchase.payment_status,
    'gross_paid_minor', v_purchase.gross_paid_minor, 'refunded_minor', v_purchase.refunded_minor,
    'access_revoked_at', v_purchase.access_revoked_at, 'revocation_reason', v_purchase.revocation_reason,
    'stale_event', v_is_stale
  );

  UPDATE public.stripe_one_time_event_applications
  SET result = v_result
  WHERE stripe_event_id = p_stripe_event_id;

  INSERT INTO public.billing_events (company_id, event_type, source_table, source_id, currency, metadata)
  VALUES (v_purchase.company_id, p_event_type, 'one_time_purchases', v_purchase.id,
    upper(coalesce(p_currency, v_purchase.currency)), v_result || jsonb_build_object('stripe_event_id', p_stripe_event_id));
  RETURN v_result;
END;
$$;

-- =============================================================================
-- 7. Period-bound canonical year-end capability
-- =============================================================================
CREATE OR REPLACE FUNCTION public.resolve_year_end_period_capability_for_user(
  p_user_id uuid,
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_require_write boolean DEFAULT false
)
RETURNS TABLE (
  allowed boolean,
  code text,
  access_source text,
  access_source_id uuid,
  effective_role text,
  purchase_id uuid,
  feature_access boolean,
  one_time_access boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_access record;
  v_feature record;
  v_period_company uuid;
  v_purchase_id uuid;
  v_is_platform_admin boolean := false;
BEGIN
  PERFORM public.require_service_role();

  SELECT company_id
  INTO v_period_company
  FROM public.fiscal_periods
  WHERE id = p_fiscal_period_id;

  IF v_period_company IS DISTINCT FROM p_company_id THEN
    RETURN QUERY SELECT
      false, 'YEAR_END_PERIOD_FORBIDDEN', NULL::text, NULL::uuid,
      NULL::text, NULL::uuid, false, false;
    RETURN;
  END IF;

  SELECT *
  INTO v_access
  FROM public.resolve_company_access_for_user(p_user_id, p_company_id)
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT
      false, 'YEAR_END_COMPANY_ACCESS_FORBIDDEN', NULL::text, NULL::uuid,
      NULL::text, NULL::uuid, false, false;
    RETURN;
  END IF;

  IF NOT coalesce(v_access.can_read, false) THEN
    RETURN QUERY SELECT
      false, 'YEAR_END_COMPANY_ACCESS_FORBIDDEN', NULL::text, NULL::uuid,
      v_access.effective_role, NULL::uuid, false, false;
    RETURN;
  END IF;

  v_is_platform_admin := coalesce(v_access.can_manage_platform, false)
    AND v_access.effective_role = 'platform_admin';

  IF p_require_write AND NOT coalesce(v_access.can_write, false) AND NOT v_is_platform_admin THEN
    RETURN QUERY SELECT
      false, 'YEAR_END_COMPANY_WRITE_FORBIDDEN', NULL::text, NULL::uuid,
      v_access.effective_role, NULL::uuid, false, false;
    RETURN;
  END IF;

  -- The canonical feature resolver covers subscriptions, manual entitlements
  -- and commercial/full-access grants. Do not reconstruct plan semantics here.
  SELECT *
  INTO v_feature
  FROM public.company_feature_access(p_company_id, 'year_end.projects')
  LIMIT 1;

  SELECT otp.id
  INTO v_purchase_id
  FROM public.one_time_purchases otp
  WHERE otp.company_id = p_company_id
    AND otp.fiscal_period_id = p_fiscal_period_id
    AND otp.purchase_type = 'year_end'
    AND otp.status IN ('paid', 'active', 'fulfilled')
    AND otp.paid_at IS NOT NULL
    AND otp.access_revoked_at IS NULL
    AND (otp.access_starts_at IS NULL OR otp.access_starts_at <= now())
    AND (otp.permanent_access OR otp.access_expires_at IS NULL OR otp.access_expires_at > now())
  ORDER BY coalesce(otp.paid_at, otp.created_at) DESC
  LIMIT 1;

  IF v_is_platform_admin THEN
    RETURN QUERY SELECT
      true, 'YEAR_END_PERIOD_OPERATE_ALLOWED', 'platform_admin_bypass'::text,
      NULL::uuid, v_access.effective_role, v_purchase_id,
      coalesce(v_feature.allowed, false), (v_purchase_id IS NOT NULL);
    RETURN;
  END IF;

  IF coalesce(v_feature.allowed, false) THEN
    RETURN QUERY SELECT
      true, 'YEAR_END_PERIOD_OPERATE_ALLOWED', 'feature_entitlement'::text,
      v_feature.source_id, v_access.effective_role, v_purchase_id,
      true, (v_purchase_id IS NOT NULL);
    RETURN;
  END IF;

  IF v_purchase_id IS NOT NULL THEN
    RETURN QUERY SELECT
      true, 'YEAR_END_PERIOD_OPERATE_ALLOWED', 'one_time_purchase'::text,
      v_purchase_id, v_access.effective_role, v_purchase_id,
      false, true;
    RETURN;
  END IF;

  RETURN QUERY SELECT
    false, 'YEAR_END_PERIOD_PURCHASE_REQUIRED', NULL::text, NULL::uuid,
    v_access.effective_role, NULL::uuid, false, false;
END;
$$;

-- =============================================================================
-- 8. Read-only discrepancy reports and audited, unambiguous repairs
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.financial_repair_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  repair_type text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('dry_run', 'apply')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(trim(reason)) >= 8),
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.financial_repair_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.financial_repair_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.financial_repair_runs TO service_role;

CREATE OR REPLACE VIEW public.customer_subledger_discrepancies_v1 AS
WITH payment_totals AS (
  SELECT
    ip.company_id,
    ip.invoice_id,
    count(*) AS payment_row_count,
    coalesce(sum(ip.amount), 0)::numeric AS payment_rows_total,
    coalesce(sum(ip.amount) FILTER (WHERE je.status = 'posted'), 0)::numeric AS posted_payment_rows_total,
    count(*) FILTER (WHERE je.id IS NULL OR je.status <> 'posted') AS nonposted_payment_rows,
    greatest(
      count(*) FILTER (WHERE ip.transaction_id IS NOT NULL)
      - count(DISTINCT ip.transaction_id) FILTER (WHERE ip.transaction_id IS NOT NULL),
      0
    ) AS duplicate_bank_links,
    max(ip.payment_date) AS last_payment_date
  FROM public.invoice_payments ip
  LEFT JOIN public.journal_entries je ON je.id = ip.journal_entry_id
  GROUP BY ip.company_id, ip.invoice_id
), registration_ledger AS (
  SELECT
    i.id AS invoice_id,
    coalesce(sum(jel.debit_amount - jel.credit_amount)
      FILTER (WHERE jel.account_number IN ('1510', '1513')), 0)::numeric AS registration_ar_net,
    max(je.status) AS registration_entry_status
  FROM public.invoices i
  LEFT JOIN public.journal_entries je ON je.id = i.journal_entry_id
  LEFT JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
  GROUP BY i.id
), settlement_ledger AS (
  SELECT
    ip.invoice_id,
    coalesce(sum(jel.debit_amount - jel.credit_amount)
      FILTER (WHERE jel.account_number IN ('1510', '1513') AND je.status = 'posted'), 0)::numeric AS settlement_ar_net
  FROM public.invoice_payments ip
  LEFT JOIN public.journal_entries je ON je.id = ip.journal_entry_id
  LEFT JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
  GROUP BY ip.invoice_id
), credit_totals AS (
  SELECT
    source_invoice_id AS invoice_id,
    coalesce(sum(remaining_amount) FILTER (WHERE status IN ('open', 'partially_applied')), 0)::numeric AS open_customer_credit
  FROM public.customer_account_credits
  WHERE source_invoice_id IS NOT NULL
  GROUP BY source_invoice_id
)
SELECT
  i.company_id,
  i.id AS invoice_id,
  i.invoice_number,
  i.status,
  i.currency,
  i.total::numeric AS invoice_total,
  coalesce(i.paid_amount, 0)::numeric AS stored_paid_amount,
  i.remaining_amount::numeric AS stored_remaining_amount,
  coalesce(pt.payment_row_count, 0) AS payment_row_count,
  coalesce(pt.payment_rows_total, 0)::numeric AS payment_rows_total,
  coalesce(pt.posted_payment_rows_total, 0)::numeric AS posted_payment_rows_total,
  coalesce(pt.nonposted_payment_rows, 0) AS nonposted_payment_rows,
  coalesce(pt.duplicate_bank_links, 0) AS duplicate_bank_links,
  coalesce(ct.open_customer_credit, 0)::numeric AS open_customer_credit,
  rl.registration_entry_status,
  coalesce(rl.registration_ar_net, 0)::numeric AS registration_ar_net,
  coalesce(sl.settlement_ar_net, 0)::numeric AS settlement_ar_net,
  round(coalesce(i.paid_amount, 0) - coalesce(pt.payment_rows_total, 0), 2) AS paid_field_delta,
  round(i.remaining_amount - greatest(i.total - coalesce(pt.payment_rows_total, 0), 0), 2) AS remaining_field_delta,
  CASE
    WHEN coalesce(pt.duplicate_bank_links, 0) > 0 THEN 'duplicate_bank_allocation'
    WHEN coalesce(pt.nonposted_payment_rows, 0) > 0 THEN 'allocation_without_posted_entry'
    WHEN i.status = 'paid' AND i.remaining_amount > 0.005 THEN 'paid_with_remaining_balance'
    WHEN i.status <> 'paid' AND i.remaining_amount <= 0.005 AND coalesce(pt.payment_row_count, 0) > 0 THEN 'fully_allocated_but_not_paid'
    WHEN coalesce(pt.payment_rows_total, 0) > i.total + 0.005 THEN 'payment_rows_exceed_invoice_total'
    WHEN abs(coalesce(i.paid_amount, 0) - coalesce(pt.payment_rows_total, 0)) > 0.005
      OR abs(i.remaining_amount - greatest(i.total - coalesce(pt.payment_rows_total, 0), 0)) > 0.005
      THEN 'stale_invoice_fields'
    WHEN rl.registration_entry_status = 'cancelled' THEN 'cancelled_registration_without_reversal_review'
    ELSE 'ok'
  END AS classification,
  pt.last_payment_date
FROM public.invoices i
LEFT JOIN payment_totals pt ON pt.company_id = i.company_id AND pt.invoice_id = i.id
LEFT JOIN registration_ledger rl ON rl.invoice_id = i.id
LEFT JOIN settlement_ledger sl ON sl.invoice_id = i.id
LEFT JOIN credit_totals ct ON ct.invoice_id = i.id
WHERE coalesce(i.document_type, 'invoice') = 'invoice';

CREATE OR REPLACE VIEW public.supplier_subledger_discrepancies_v1 AS
WITH payment_totals AS (
  SELECT
    sip.company_id,
    sip.supplier_invoice_id,
    count(*) AS payment_row_count,
    coalesce(sum(sip.amount), 0)::numeric AS payment_rows_total,
    coalesce(sum(sip.amount) FILTER (WHERE je.status = 'posted'), 0)::numeric AS posted_payment_rows_total,
    count(*) FILTER (WHERE je.id IS NULL OR je.status <> 'posted') AS nonposted_payment_rows,
    greatest(
      count(*) FILTER (WHERE sip.transaction_id IS NOT NULL)
      - count(DISTINCT sip.transaction_id) FILTER (WHERE sip.transaction_id IS NOT NULL),
      0
    ) AS duplicate_bank_links,
    max(sip.payment_date) AS last_payment_date
  FROM public.supplier_invoice_payments sip
  LEFT JOIN public.journal_entries je ON je.id = sip.journal_entry_id
  GROUP BY sip.company_id, sip.supplier_invoice_id
), registration_ledger AS (
  SELECT
    si.id AS supplier_invoice_id,
    coalesce(sum(jel.credit_amount - jel.debit_amount)
      FILTER (WHERE jel.account_number = '2440'), 0)::numeric AS registration_ap_net,
    max(je.status) AS registration_entry_status
  FROM public.supplier_invoices si
  LEFT JOIN public.journal_entries je ON je.id = si.registration_journal_entry_id
  LEFT JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
  GROUP BY si.id
), settlement_ledger AS (
  SELECT
    sip.supplier_invoice_id,
    coalesce(sum(jel.credit_amount - jel.debit_amount)
      FILTER (WHERE jel.account_number = '2440' AND je.status = 'posted'), 0)::numeric AS settlement_ap_net
  FROM public.supplier_invoice_payments sip
  LEFT JOIN public.journal_entries je ON je.id = sip.journal_entry_id
  LEFT JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
  GROUP BY sip.supplier_invoice_id
)
SELECT
  si.company_id,
  si.id AS supplier_invoice_id,
  si.supplier_invoice_number,
  si.status,
  si.currency,
  si.total::numeric AS invoice_total,
  coalesce(si.paid_amount, 0)::numeric AS stored_paid_amount,
  si.remaining_amount::numeric AS stored_remaining_amount,
  coalesce(pt.payment_row_count, 0) AS payment_row_count,
  coalesce(pt.payment_rows_total, 0)::numeric AS payment_rows_total,
  coalesce(pt.posted_payment_rows_total, 0)::numeric AS posted_payment_rows_total,
  coalesce(pt.nonposted_payment_rows, 0) AS nonposted_payment_rows,
  coalesce(pt.duplicate_bank_links, 0) AS duplicate_bank_links,
  rl.registration_entry_status,
  coalesce(rl.registration_ap_net, 0)::numeric AS registration_ap_net,
  coalesce(sl.settlement_ap_net, 0)::numeric AS settlement_ap_net,
  round(coalesce(si.paid_amount, 0) - coalesce(pt.payment_rows_total, 0), 2) AS paid_field_delta,
  round(si.remaining_amount - greatest(si.total - coalesce(pt.payment_rows_total, 0), 0), 2) AS remaining_field_delta,
  CASE
    WHEN coalesce(pt.duplicate_bank_links, 0) > 0 THEN 'duplicate_bank_allocation'
    WHEN coalesce(pt.nonposted_payment_rows, 0) > 0 THEN 'allocation_without_posted_entry'
    WHEN si.status = 'paid' AND si.remaining_amount > 0.005 THEN 'paid_with_remaining_balance'
    WHEN si.status <> 'paid' AND si.remaining_amount <= 0.005 AND coalesce(pt.payment_row_count, 0) > 0 THEN 'fully_allocated_but_not_paid'
    WHEN coalesce(pt.payment_rows_total, 0) > si.total + 0.005 THEN 'payment_rows_exceed_invoice_total'
    WHEN abs(coalesce(si.paid_amount, 0) - coalesce(pt.payment_rows_total, 0)) > 0.005
      OR abs(si.remaining_amount - greatest(si.total - coalesce(pt.payment_rows_total, 0), 0)) > 0.005
      THEN 'stale_invoice_fields'
    WHEN rl.registration_entry_status = 'cancelled' THEN 'cancelled_registration_without_reversal_review'
    ELSE 'ok'
  END AS classification,
  pt.last_payment_date
FROM public.supplier_invoices si
LEFT JOIN payment_totals pt ON pt.company_id = si.company_id AND pt.supplier_invoice_id = si.id
LEFT JOIN registration_ledger rl ON rl.supplier_invoice_id = si.id
LEFT JOIN settlement_ledger sl ON sl.supplier_invoice_id = si.id
WHERE NOT coalesce(si.is_credit_note, false);

REVOKE ALL ON public.customer_subledger_discrepancies_v1 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.supplier_subledger_discrepancies_v1 FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.customer_subledger_discrepancies_v1 TO service_role;
GRANT SELECT ON public.supplier_subledger_discrepancies_v1 TO service_role;

CREATE OR REPLACE VIEW public.bank_payment_allocation_discrepancies_v1 AS
WITH allocations AS (
  SELECT company_id, transaction_id, 'customer'::text AS allocation_type,
         id AS payment_id, invoice_id AS document_id
  FROM public.invoice_payments
  WHERE transaction_id IS NOT NULL
  UNION ALL
  SELECT company_id, transaction_id, 'supplier'::text AS allocation_type,
         id AS payment_id, supplier_invoice_id AS document_id
  FROM public.supplier_invoice_payments
  WHERE transaction_id IS NOT NULL
)
SELECT
  company_id,
  transaction_id,
  count(*) AS allocation_count,
  count(*) FILTER (WHERE allocation_type = 'customer') AS customer_allocations,
  count(*) FILTER (WHERE allocation_type = 'supplier') AS supplier_allocations,
  jsonb_agg(jsonb_build_object(
    'allocation_type', allocation_type,
    'payment_id', payment_id,
    'document_id', document_id
  ) ORDER BY allocation_type, payment_id) AS allocations,
  CASE
    WHEN count(*) FILTER (WHERE allocation_type = 'customer') > 0
     AND count(*) FILTER (WHERE allocation_type = 'supplier') > 0
      THEN 'cross_subledger_duplicate'
    ELSE 'duplicate_within_subledger'
  END AS classification
FROM allocations
GROUP BY company_id, transaction_id
HAVING count(*) > 1;

REVOKE ALL ON public.bank_payment_allocation_discrepancies_v1 FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.bank_payment_allocation_discrepancies_v1 TO service_role;

CREATE OR REPLACE FUNCTION public.run_financial_subledger_repair(
  p_actor_user_id uuid,
  p_company_id uuid,
  p_reason text,
  p_apply boolean DEFAULT false,
  p_batch_size integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_access record;
  v_run_id uuid;
  v_customer_count integer := 0;
  v_supplier_count integer := 0;
  v_error_state text;
  v_result jsonb;
BEGIN
  PERFORM public.require_service_role();
  IF p_actor_user_id IS NULL OR length(trim(coalesce(p_reason, ''))) < 8 THEN
    RAISE EXCEPTION 'A real actor and repair reason are required.'
      USING ERRCODE = '22023', DETAIL = '{"code":"REPAIR_PROVENANCE_REQUIRED"}';
  END IF;
  IF p_batch_size < 1 OR p_batch_size > 1000 THEN
    RAISE EXCEPTION 'Invalid repair batch size.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_access FROM public.resolve_company_access_for_user(p_actor_user_id, p_company_id);
  IF NOT FOUND OR NOT coalesce(v_access.can_write, false) THEN
    RAISE EXCEPTION 'Actor cannot repair this company.'
      USING ERRCODE = '42501', DETAIL = '{"code":"COMPANY_WRITE_FORBIDDEN"}';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':financial_subledger_repair', 0));
  INSERT INTO public.financial_repair_runs
    (company_id, repair_type, mode, actor_user_id, reason)
  VALUES
    (p_company_id, 'stale_invoice_aggregates', CASE WHEN p_apply THEN 'apply' ELSE 'dry_run' END,
     p_actor_user_id, trim(p_reason))
  RETURNING id INTO v_run_id;

  -- The inner block is a savepoint. Any economic repair failure rolls back the
  -- candidate updates while the outer run row can still be marked failed and
  -- audited safely.
  BEGIN
    DROP TABLE IF EXISTS pg_temp.repair_customer_candidates;
    DROP TABLE IF EXISTS pg_temp.repair_supplier_candidates;

    CREATE TEMP TABLE repair_customer_candidates ON COMMIT DROP AS
    SELECT *
    FROM public.customer_subledger_discrepancies_v1
    WHERE company_id = p_company_id
      AND classification = 'stale_invoice_fields'
      AND nonposted_payment_rows = 0
      AND duplicate_bank_links = 0
      AND payment_rows_total <= invoice_total + 0.005
    ORDER BY invoice_id
    LIMIT p_batch_size;

    CREATE TEMP TABLE repair_supplier_candidates ON COMMIT DROP AS
    SELECT *
    FROM public.supplier_subledger_discrepancies_v1
    WHERE company_id = p_company_id
      AND classification = 'stale_invoice_fields'
      AND nonposted_payment_rows = 0
      AND duplicate_bank_links = 0
      AND payment_rows_total <= invoice_total + 0.005
    ORDER BY supplier_invoice_id
    LIMIT p_batch_size;

    SELECT count(*) INTO v_customer_count FROM repair_customer_candidates;
    SELECT count(*) INTO v_supplier_count FROM repair_supplier_candidates;

    IF p_apply THEN
      UPDATE public.invoices i SET
        paid_amount = c.payment_rows_total,
        remaining_amount = greatest(c.invoice_total - c.payment_rows_total, 0),
        status = CASE
          WHEN greatest(c.invoice_total - c.payment_rows_total, 0) <= 0.005 THEN 'paid'
          WHEN c.payment_rows_total > 0 THEN 'partially_paid'
          ELSE i.status END,
        paid_at = CASE
          WHEN greatest(c.invoice_total - c.payment_rows_total, 0) <= 0.005
            THEN coalesce(i.paid_at, c.last_payment_date::timestamptz)
          ELSE NULL END,
        updated_at = now()
      FROM repair_customer_candidates c
      WHERE i.company_id = p_company_id AND i.id = c.invoice_id;

      UPDATE public.supplier_invoices si SET
        paid_amount = c.payment_rows_total,
        remaining_amount = greatest(c.invoice_total - c.payment_rows_total, 0),
        status = CASE
          WHEN greatest(c.invoice_total - c.payment_rows_total, 0) <= 0.005 THEN 'paid'
          WHEN c.payment_rows_total > 0 THEN 'partially_paid'
          ELSE si.status END,
        paid_at = CASE
          WHEN greatest(c.invoice_total - c.payment_rows_total, 0) <= 0.005
            THEN coalesce(si.paid_at, c.last_payment_date::timestamptz)
          ELSE NULL END,
        updated_at = now()
      FROM repair_supplier_candidates c
      WHERE si.company_id = p_company_id AND si.id = c.supplier_invoice_id;
    END IF;

    v_result := jsonb_build_object(
      'repair_run_id', v_run_id,
      'status', 'completed',
      'mode', CASE WHEN p_apply THEN 'apply' ELSE 'dry_run' END,
      'customer_candidates', v_customer_count,
      'supplier_candidates', v_supplier_count,
      'customer_ids', coalesce((SELECT jsonb_agg(invoice_id ORDER BY invoice_id) FROM repair_customer_candidates), '[]'::jsonb),
      'supplier_ids', coalesce((SELECT jsonb_agg(supplier_invoice_id ORDER BY supplier_invoice_id) FROM repair_supplier_candidates), '[]'::jsonb)
    );

    UPDATE public.financial_repair_runs SET
      status = 'completed',
      checkpoint = jsonb_build_object(
        'last_customer_invoice_id', (SELECT invoice_id FROM repair_customer_candidates ORDER BY invoice_id DESC LIMIT 1),
        'last_supplier_invoice_id', (SELECT supplier_invoice_id FROM repair_supplier_candidates ORDER BY supplier_invoice_id DESC LIMIT 1)
      ),
      summary = v_result,
      completed_at = now()
    WHERE id = v_run_id;

    INSERT INTO public.audit_log
      (user_id, company_id, action, table_name, record_id, actor_id, actor_type, new_state, description)
    VALUES
      (p_actor_user_id, p_company_id, 'SECURITY_EVENT', 'financial_repair_runs', v_run_id,
       p_actor_user_id, 'user', v_result,
       'Financial subledger repair ' || CASE WHEN p_apply THEN 'applied' ELSE 'dry-run' END || '; reason=' || trim(p_reason));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error_state = RETURNED_SQLSTATE;
    v_result := jsonb_build_object(
      'repair_run_id', v_run_id,
      'status', 'failed',
      'mode', CASE WHEN p_apply THEN 'apply' ELSE 'dry_run' END,
      'code', 'FINANCIAL_REPAIR_FAILED',
      'sqlstate', v_error_state
    );

    UPDATE public.financial_repair_runs SET
      status = 'failed',
      summary = v_result,
      completed_at = now()
    WHERE id = v_run_id;

    INSERT INTO public.audit_log
      (user_id, company_id, action, table_name, record_id, actor_id, actor_type, new_state, description)
    VALUES
      (p_actor_user_id, p_company_id, 'SECURITY_EVENT', 'financial_repair_runs', v_run_id,
       p_actor_user_id, 'user', v_result,
       'Financial subledger repair failed safely; reason=' || trim(p_reason));

    RETURN v_result;
  END;

  RETURN v_result;
END;
$$;


REVOKE ALL ON FUNCTION public.get_financial_operation_result(uuid,text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_customer_invoice(uuid,uuid,uuid,date,numeric,text,numeric,uuid,text,text,text,text,text,uuid,numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_supplier_invoice(uuid,uuid,uuid,date,numeric,text,numeric,uuid,text,text,text,text,text,uuid,numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stripe_apply_one_time_purchase_event(text,text,timestamptz,text,text,text,text,text,bigint,bigint,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_year_end_period_capability_for_user(uuid,uuid,uuid,boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.run_financial_subledger_repair(uuid,uuid,text,boolean,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_financial_operation_result(uuid,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_customer_invoice(uuid,uuid,uuid,date,numeric,text,numeric,uuid,text,text,text,text,text,uuid,numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_supplier_invoice(uuid,uuid,uuid,date,numeric,text,numeric,uuid,text,text,text,text,text,uuid,numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.stripe_apply_one_time_purchase_event(text,text,timestamptz,text,text,text,text,text,bigint,bigint,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_year_end_period_capability_for_user(uuid,uuid,uuid,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.run_financial_subledger_repair(uuid,uuid,text,boolean,integer) TO service_role;

NOTIFY pgrst, 'reload schema';
