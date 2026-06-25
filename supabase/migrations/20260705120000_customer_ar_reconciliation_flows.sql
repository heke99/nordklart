-- Customer AR reconciliation, overpayment/customer-credit and dispute lifecycle.
-- Adds production-safe primitives for partial payments, overpayments, payment differences,
-- disputed invoices and collection/written-off states without breaking existing invoices.

-- -----------------------------------------------------------------------------
-- 1. Invoice lifecycle fields
-- -----------------------------------------------------------------------------
ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS invoices_status_check;

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_status_check CHECK (
    status IN (
      'draft', 'sent', 'paid', 'partially_paid', 'overdue', 'cancelled', 'credited',
      'disputed', 'collection_ready', 'written_off'
    )
  );

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS disputed_at timestamptz,
  ADD COLUMN IF NOT EXISTS dispute_reason text,
  ADD COLUMN IF NOT EXISTS collection_ready_at timestamptz,
  ADD COLUMN IF NOT EXISTS written_off_at timestamptz,
  ADD COLUMN IF NOT EXISTS payment_resolution_status text DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS payment_resolution_notes text;

ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS invoices_payment_resolution_status_check;

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_payment_resolution_status_check CHECK (
    payment_resolution_status IS NULL OR
    payment_resolution_status IN (
      'open', 'has_difference', 'customer_credit', 'resolved', 'written_off', 'collection'
    )
  );

UPDATE public.invoices
SET payment_resolution_status = 'open'
WHERE payment_resolution_status IS NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_ar_open_status
  ON public.invoices (company_id, status, due_date)
  WHERE status IN ('sent', 'partially_paid', 'overdue', 'disputed', 'collection_ready');

-- -----------------------------------------------------------------------------
-- 2. Customer credit / overpayment ledger
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.customer_account_credits (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  source_invoice_id uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  source_payment_id uuid REFERENCES public.invoice_payments(id) ON DELETE SET NULL,
  source_transaction_id uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
  source_journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  remaining_amount numeric(14,2) NOT NULL CHECK (remaining_amount >= 0),
  currency text NOT NULL DEFAULT 'SEK',
  status text NOT NULL DEFAULT 'open' CHECK (
    status IN ('open', 'partially_applied', 'applied', 'refunded', 'written_off', 'void')
  ),
  reason text NOT NULL DEFAULT 'overpayment' CHECK (
    reason IN ('overpayment', 'prepayment', 'refund_due', 'manual_adjustment')
  ),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_account_credits_company_customer
  ON public.customer_account_credits (company_id, customer_id, status);
CREATE INDEX IF NOT EXISTS idx_customer_account_credits_source_invoice
  ON public.customer_account_credits (source_invoice_id);
CREATE INDEX IF NOT EXISTS idx_customer_account_credits_source_payment
  ON public.customer_account_credits (source_payment_id);

ALTER TABLE public.customer_account_credits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS customer_account_credits_select ON public.customer_account_credits;
CREATE POLICY customer_account_credits_select ON public.customer_account_credits
  FOR SELECT USING (
    company_id IN (SELECT company_id FROM public.company_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS customer_account_credits_insert ON public.customer_account_credits;
CREATE POLICY customer_account_credits_insert ON public.customer_account_credits
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
    AND company_id IN (SELECT company_id FROM public.company_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS customer_account_credits_update ON public.customer_account_credits;
CREATE POLICY customer_account_credits_update ON public.customer_account_credits
  FOR UPDATE USING (
    company_id IN (SELECT company_id FROM public.company_members WHERE user_id = auth.uid())
  ) WITH CHECK (
    company_id IN (SELECT company_id FROM public.company_members WHERE user_id = auth.uid())
  );

DROP TRIGGER IF EXISTS customer_account_credits_updated_at ON public.customer_account_credits;
CREATE TRIGGER customer_account_credits_updated_at
  BEFORE UPDATE ON public.customer_account_credits
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- -----------------------------------------------------------------------------
-- 3. Payment adjustment / discrepancy ledger
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.invoice_payment_adjustments (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  payment_id uuid REFERENCES public.invoice_payments(id) ON DELETE SET NULL,
  transaction_id uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
  customer_credit_id uuid REFERENCES public.customer_account_credits(id) ON DELETE SET NULL,
  journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  adjustment_date date NOT NULL DEFAULT CURRENT_DATE,
  adjustment_type text NOT NULL CHECK (
    adjustment_type IN (
      'underpayment', 'overpayment', 'rounding', 'discount', 'bank_fee',
      'write_off', 'credit_note_offset', 'refund', 'collection_escalation', 'dispute'
    )
  ),
  amount numeric(14,2) NOT NULL,
  currency text NOT NULL DEFAULT 'SEK',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'posted', 'void')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoice_payment_adjustments_invoice
  ON public.invoice_payment_adjustments (company_id, invoice_id, adjustment_type, status);
CREATE INDEX IF NOT EXISTS idx_invoice_payment_adjustments_payment
  ON public.invoice_payment_adjustments (payment_id);
CREATE INDEX IF NOT EXISTS idx_invoice_payment_adjustments_credit
  ON public.invoice_payment_adjustments (customer_credit_id);

ALTER TABLE public.invoice_payment_adjustments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS invoice_payment_adjustments_select ON public.invoice_payment_adjustments;
CREATE POLICY invoice_payment_adjustments_select ON public.invoice_payment_adjustments
  FOR SELECT USING (
    company_id IN (SELECT company_id FROM public.company_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS invoice_payment_adjustments_insert ON public.invoice_payment_adjustments;
CREATE POLICY invoice_payment_adjustments_insert ON public.invoice_payment_adjustments
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
    AND company_id IN (SELECT company_id FROM public.company_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS invoice_payment_adjustments_update ON public.invoice_payment_adjustments;
CREATE POLICY invoice_payment_adjustments_update ON public.invoice_payment_adjustments
  FOR UPDATE USING (
    company_id IN (SELECT company_id FROM public.company_members WHERE user_id = auth.uid())
  ) WITH CHECK (
    company_id IN (SELECT company_id FROM public.company_members WHERE user_id = auth.uid())
  );

DROP TRIGGER IF EXISTS invoice_payment_adjustments_updated_at ON public.invoice_payment_adjustments;
CREATE TRIGGER invoice_payment_adjustments_updated_at
  BEFORE UPDATE ON public.invoice_payment_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Guard adjustment rows against cross-tenant drift.
CREATE OR REPLACE FUNCTION public.enforce_invoice_payment_adjustment_company_consistency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_invoice_company_id uuid;
  v_payment_company_id uuid;
  v_credit_company_id uuid;
BEGIN
  SELECT company_id INTO v_invoice_company_id FROM public.invoices WHERE id = NEW.invoice_id;
  IF v_invoice_company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'invoice_payment_adjustments.company_id (%) does not match invoices.company_id (%) for invoice %',
      NEW.company_id, v_invoice_company_id, NEW.invoice_id;
  END IF;

  IF NEW.payment_id IS NOT NULL THEN
    SELECT company_id INTO v_payment_company_id FROM public.invoice_payments WHERE id = NEW.payment_id;
    IF v_payment_company_id IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION 'invoice_payment_adjustments.company_id (%) does not match invoice_payments.company_id (%) for payment %',
        NEW.company_id, v_payment_company_id, NEW.payment_id;
    END IF;
  END IF;

  IF NEW.customer_credit_id IS NOT NULL THEN
    SELECT company_id INTO v_credit_company_id FROM public.customer_account_credits WHERE id = NEW.customer_credit_id;
    IF v_credit_company_id IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION 'invoice_payment_adjustments.company_id (%) does not match customer_account_credits.company_id (%) for credit %',
        NEW.company_id, v_credit_company_id, NEW.customer_credit_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_invoice_payment_adjustment_company_consistency ON public.invoice_payment_adjustments;
CREATE TRIGGER enforce_invoice_payment_adjustment_company_consistency
  BEFORE INSERT OR UPDATE OF company_id, invoice_id, payment_id, customer_credit_id
  ON public.invoice_payment_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_invoice_payment_adjustment_company_consistency();

-- -----------------------------------------------------------------------------
-- 4. AR balance view: open receivables + open customer credits.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.customer_ar_balances AS
WITH open_invoices AS (
  SELECT
    company_id,
    customer_id,
    currency,
    SUM(COALESCE(remaining_amount, total - COALESCE(paid_amount, 0))) AS open_receivable_amount
  FROM public.invoices
  WHERE status IN ('sent', 'partially_paid', 'overdue', 'disputed', 'collection_ready')
    AND COALESCE(remaining_amount, total - COALESCE(paid_amount, 0)) > 0
  GROUP BY company_id, customer_id, currency
),
open_credits AS (
  SELECT
    company_id,
    customer_id,
    currency,
    SUM(remaining_amount) AS open_credit_amount
  FROM public.customer_account_credits
  WHERE status IN ('open', 'partially_applied')
    AND remaining_amount > 0
  GROUP BY company_id, customer_id, currency
)
SELECT
  COALESCE(i.company_id, c.company_id) AS company_id,
  COALESCE(i.customer_id, c.customer_id) AS customer_id,
  COALESCE(i.currency, c.currency) AS currency,
  COALESCE(i.open_receivable_amount, 0) AS open_receivable_amount,
  COALESCE(c.open_credit_amount, 0) AS open_credit_amount,
  COALESCE(i.open_receivable_amount, 0) - COALESCE(c.open_credit_amount, 0) AS net_ar_amount
FROM open_invoices i
FULL OUTER JOIN open_credits c
  ON c.company_id = i.company_id
 AND c.customer_id IS NOT DISTINCT FROM i.customer_id
 AND c.currency = i.currency;

-- -----------------------------------------------------------------------------
-- 5. BAS account defaults for overpayment / rounding / write-off.
-- -----------------------------------------------------------------------------
INSERT INTO public.chart_of_accounts (
  user_id, company_id, account_number, account_name, account_type, normal_balance,
  account_class, account_group, is_active, is_system_account
)
SELECT c.created_by, c.id, account_number, account_name, account_type, normal_balance,
       bas_class, bas_group, true, true
FROM public.companies c
CROSS JOIN (VALUES
  ('2420', 'Förskott från kunder / kundtillgodohavande', 'liability', 'credit', 2, '24'),
  ('3740', 'Öres- och kronutjämning', 'revenue', 'credit', 3, '37'),
  ('6351', 'Konstaterade förluster på kundfordringar', 'expense', 'debit', 6, '63')
) AS seed(account_number, account_name, account_type, normal_balance, bas_class, bas_group)
ON CONFLICT (company_id, account_number) DO NOTHING;
