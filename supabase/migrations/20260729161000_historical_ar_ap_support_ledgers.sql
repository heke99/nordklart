-- Historical customer/supplier subledgers around an already-booked SIE ledger.
--
-- The support tables below can document and reconcile the general ledger but
-- have no journal-posting trigger. `accounting_origin` and
-- `recognition_status` are fixed by CHECK constraints so these rows can never
-- enter the ordinary invoice accounting flows.

CREATE TABLE IF NOT EXISTS public.year_end_control_accounts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  control_category  text NOT NULL CHECK (control_category IN (
    'customer_receivables',
    'supplier_payables',
    'bank_accounts',
    'equity_accounts',
    'tax_accounts',
    'vat_accounts'
  )),
  account_number    text NOT NULL CHECK (account_number ~ '^[0-9]{4,}$'),
  active            boolean NOT NULL DEFAULT true,
  created_by        uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, control_category, account_number)
);

-- Explicit default accounts, never an implicit whole-range calculation.
INSERT INTO public.year_end_control_accounts (
  company_id, control_category, account_number
)
SELECT c.id, seed.control_category, seed.account_number
FROM public.companies c
CROSS JOIN (
  VALUES
    ('customer_receivables'::text, '1510'::text),
    ('customer_receivables'::text, '1513'::text),
    ('supplier_payables'::text, '2440'::text),
    ('bank_accounts'::text, '1930'::text),
    ('equity_accounts'::text, '2081'::text),
    ('equity_accounts'::text, '2091'::text),
    ('equity_accounts'::text, '2098'::text),
    ('equity_accounts'::text, '2099'::text),
    ('tax_accounts'::text, '2510'::text),
    ('vat_accounts'::text, '2650'::text)
) AS seed(control_category, account_number)
ON CONFLICT (company_id, control_category, account_number) DO NOTHING;

CREATE OR REPLACE FUNCTION public.seed_year_end_control_accounts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.year_end_control_accounts (
    company_id, control_category, account_number
  ) VALUES
    (NEW.id, 'customer_receivables', '1510'),
    (NEW.id, 'customer_receivables', '1513'),
    (NEW.id, 'supplier_payables', '2440'),
    (NEW.id, 'bank_accounts', '1930'),
    (NEW.id, 'equity_accounts', '2081'),
    (NEW.id, 'equity_accounts', '2091'),
    (NEW.id, 'equity_accounts', '2098'),
    (NEW.id, 'equity_accounts', '2099'),
    (NEW.id, 'tax_accounts', '2510'),
    (NEW.id, 'vat_accounts', '2650')
  ON CONFLICT (company_id, control_category, account_number) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS seed_year_end_control_accounts ON public.companies;
CREATE TRIGGER seed_year_end_control_accounts
  AFTER INSERT ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.seed_year_end_control_accounts();

INSERT INTO public.year_end_control_accounts (
  company_id, control_category, account_number
)
SELECT ca.company_id, 'bank_accounts', ca.ledger_account
FROM public.cash_accounts ca
WHERE ca.enabled
ON CONFLICT (company_id, control_category, account_number)
DO UPDATE SET active = true;

CREATE OR REPLACE FUNCTION public.sync_year_end_bank_control_account()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.year_end_control_accounts (
    company_id, control_category, account_number, active
  ) VALUES (
    NEW.company_id, 'bank_accounts', NEW.ledger_account, NEW.enabled
  )
  ON CONFLICT (company_id, control_category, account_number)
  DO UPDATE SET active = EXCLUDED.active;

  IF TG_OP = 'UPDATE'
     AND OLD.ledger_account IS DISTINCT FROM NEW.ledger_account THEN
    UPDATE public.year_end_control_accounts
    SET active = false
    WHERE company_id = OLD.company_id
      AND control_category = 'bank_accounts'
      AND account_number = OLD.ledger_account;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_year_end_bank_control_account
  ON public.cash_accounts;
CREATE TRIGGER sync_year_end_bank_control_account
  AFTER INSERT OR UPDATE OF ledger_account, enabled ON public.cash_accounts
  FOR EACH ROW EXECUTE FUNCTION public.sync_year_end_bank_control_account();

CREATE TABLE IF NOT EXISTS public.migrated_customer_receivables (
  id                                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                              uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id                        uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE RESTRICT,
  balance_date                            date NOT NULL,
  customer_id                             uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  customer_name_snapshot                  text NOT NULL,
  customer_number_snapshot                text,
  invoice_number                          text NOT NULL,
  invoice_date                            date NOT NULL,
  due_date                                date NOT NULL,
  currency                                text NOT NULL DEFAULT 'SEK' CHECK (currency ~ '^[A-Z]{3}$'),
  original_amount_currency                numeric(18,2) NOT NULL CHECK (original_amount_currency >= 0),
  paid_amount_at_balance_date_currency     numeric(18,2) NOT NULL DEFAULT 0
    CHECK (paid_amount_at_balance_date_currency >= 0),
  remaining_amount_at_balance_date_currency numeric(18,2) NOT NULL
    CHECK (remaining_amount_at_balance_date_currency >= 0),
  booked_exchange_rate                    numeric(18,8) CHECK (booked_exchange_rate > 0),
  remaining_amount_sek_at_balance_date     numeric(18,2) NOT NULL
    CHECK (remaining_amount_sek_at_balance_date >= 0),
  status_at_balance_date                  text NOT NULL,
  control_account                         text NOT NULL CHECK (control_account ~ '^[0-9]{4,}$'),
  source_type                             text NOT NULL DEFAULT 'migrated' CHECK (source_type = 'migrated'),
  accounting_origin                       text NOT NULL DEFAULT 'imported_sie'
    CHECK (accounting_origin = 'imported_sie'),
  recognition_status                      text NOT NULL DEFAULT 'already_booked'
    CHECK (recognition_status = 'already_booked'),
  sie_import_id                            uuid REFERENCES public.sie_imports(id) ON DELETE RESTRICT,
  external_reference                      text,
  comment                                 text,
  idempotency_key                         text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  payload_hash                            text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  created_by                              uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at                              timestamptz NOT NULL DEFAULT now(),
  verified_by                             uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  verified_at                             timestamptz,
  superseded_at                           timestamptz,
  superseded_by                           uuid REFERENCES public.migrated_customer_receivables(id) ON DELETE RESTRICT,
  CHECK (
    paid_amount_at_balance_date_currency
    + remaining_amount_at_balance_date_currency
    <= original_amount_currency + 0.01
  ),
  UNIQUE (company_id, fiscal_period_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS public.migrated_receivable_documents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  receivable_id         uuid NOT NULL REFERENCES public.migrated_customer_receivables(id) ON DELETE RESTRICT,
  document_id           uuid NOT NULL REFERENCES public.document_attachments(id) ON DELETE RESTRICT,
  created_by            uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (receivable_id, document_id)
);

CREATE TABLE IF NOT EXISTS public.migrated_receivable_voucher_links (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  receivable_id         uuid NOT NULL REFERENCES public.migrated_customer_receivables(id) ON DELETE RESTRICT,
  journal_entry_id      uuid NOT NULL REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  allocated_amount_sek  numeric(18,2) NOT NULL CHECK (allocated_amount_sek > 0),
  verification_method   text NOT NULL CHECK (verification_method IN (
    'exact_reference', 'exact_amount', 'manual', 'source_metadata'
  )),
  verified_by           uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  verified_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (receivable_id, journal_entry_id)
);

CREATE TABLE IF NOT EXISTS public.migrated_receivable_payments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  receivable_id         uuid NOT NULL REFERENCES public.migrated_customer_receivables(id) ON DELETE RESTRICT,
  payment_date          date NOT NULL,
  amount_currency       numeric(18,2) NOT NULL CHECK (amount_currency > 0),
  amount_sek            numeric(18,2) NOT NULL CHECK (amount_sek > 0),
  bank_transaction_id   uuid REFERENCES public.transactions(id) ON DELETE RESTRICT,
  journal_entry_id      uuid NOT NULL REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  posting_mode          text NOT NULL CHECK (posting_mode IN (
    'linked_existing_sie', 'linked_existing_bank', 'new_bank_payment'
  )),
  idempotency_key       text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  created_by            uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, idempotency_key),
  UNIQUE (bank_transaction_id),
  UNIQUE (journal_entry_id)
);

CREATE TABLE IF NOT EXISTS public.migrated_supplier_payables (
  id                                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                              uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id                        uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE RESTRICT,
  balance_date                            date NOT NULL,
  supplier_id                             uuid REFERENCES public.suppliers(id) ON DELETE SET NULL,
  supplier_name_snapshot                  text NOT NULL,
  supplier_number_snapshot                text,
  supplier_invoice_number                 text NOT NULL,
  invoice_date                            date NOT NULL,
  due_date                                date NOT NULL,
  currency                                text NOT NULL DEFAULT 'SEK' CHECK (currency ~ '^[A-Z]{3}$'),
  original_amount_currency                numeric(18,2) NOT NULL CHECK (original_amount_currency >= 0),
  paid_amount_at_balance_date_currency     numeric(18,2) NOT NULL DEFAULT 0
    CHECK (paid_amount_at_balance_date_currency >= 0),
  remaining_amount_at_balance_date_currency numeric(18,2) NOT NULL
    CHECK (remaining_amount_at_balance_date_currency >= 0),
  booked_exchange_rate                    numeric(18,8) CHECK (booked_exchange_rate > 0),
  remaining_amount_sek_at_balance_date     numeric(18,2) NOT NULL
    CHECK (remaining_amount_sek_at_balance_date >= 0),
  status_at_balance_date                  text NOT NULL,
  control_account                         text NOT NULL CHECK (control_account ~ '^[0-9]{4,}$'),
  source_type                             text NOT NULL DEFAULT 'migrated' CHECK (source_type = 'migrated'),
  accounting_origin                       text NOT NULL DEFAULT 'imported_sie'
    CHECK (accounting_origin = 'imported_sie'),
  recognition_status                      text NOT NULL DEFAULT 'already_booked'
    CHECK (recognition_status = 'already_booked'),
  sie_import_id                            uuid REFERENCES public.sie_imports(id) ON DELETE RESTRICT,
  external_reference                      text,
  comment                                 text,
  idempotency_key                         text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  payload_hash                            text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  created_by                              uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at                              timestamptz NOT NULL DEFAULT now(),
  verified_by                             uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  verified_at                             timestamptz,
  superseded_at                           timestamptz,
  superseded_by                           uuid REFERENCES public.migrated_supplier_payables(id) ON DELETE RESTRICT,
  CHECK (
    paid_amount_at_balance_date_currency
    + remaining_amount_at_balance_date_currency
    <= original_amount_currency + 0.01
  ),
  UNIQUE (company_id, fiscal_period_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS public.migrated_supplier_payable_documents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  payable_id            uuid NOT NULL REFERENCES public.migrated_supplier_payables(id) ON DELETE RESTRICT,
  document_id           uuid NOT NULL REFERENCES public.document_attachments(id) ON DELETE RESTRICT,
  created_by            uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payable_id, document_id)
);

CREATE TABLE IF NOT EXISTS public.migrated_supplier_payable_voucher_links (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  payable_id            uuid NOT NULL REFERENCES public.migrated_supplier_payables(id) ON DELETE RESTRICT,
  journal_entry_id      uuid NOT NULL REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  allocated_amount_sek  numeric(18,2) NOT NULL CHECK (allocated_amount_sek > 0),
  verification_method   text NOT NULL CHECK (verification_method IN (
    'exact_reference', 'exact_amount', 'manual', 'source_metadata'
  )),
  verified_by           uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  verified_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payable_id, journal_entry_id)
);

CREATE TABLE IF NOT EXISTS public.migrated_supplier_payable_payments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  payable_id            uuid NOT NULL REFERENCES public.migrated_supplier_payables(id) ON DELETE RESTRICT,
  payment_date          date NOT NULL,
  amount_currency       numeric(18,2) NOT NULL CHECK (amount_currency > 0),
  amount_sek            numeric(18,2) NOT NULL CHECK (amount_sek > 0),
  bank_transaction_id   uuid REFERENCES public.transactions(id) ON DELETE RESTRICT,
  journal_entry_id      uuid NOT NULL REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  posting_mode          text NOT NULL CHECK (posting_mode IN (
    'linked_existing_sie', 'linked_existing_bank', 'new_bank_payment'
  )),
  idempotency_key       text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  created_by            uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, idempotency_key),
  UNIQUE (bank_transaction_id),
  UNIQUE (journal_entry_id)
);

CREATE TABLE IF NOT EXISTS public.year_end_external_ar_reconciliations (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id         uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE RESTRICT,
  balance_date             date NOT NULL,
  ledger_balance           numeric(18,2) NOT NULL,
  internal_receivables     numeric(18,2) NOT NULL,
  expected_legacy_balance  numeric(18,2) NOT NULL,
  external_legacy_balance  numeric(18,2) NOT NULL,
  difference               numeric(18,2) NOT NULL CHECK (abs(difference) < 0.01),
  ledger_snapshot_hash     text NOT NULL CHECK (ledger_snapshot_hash ~ '^[0-9a-f]{64}$'),
  verification_method      text NOT NULL,
  comment                  text NOT NULL,
  source_sie_import_id     uuid REFERENCES public.sie_imports(id) ON DELETE RESTRICT,
  idempotency_key          text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  verified_by              uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  verified_at              timestamptz NOT NULL DEFAULT now(),
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, fiscal_period_id),
  UNIQUE (company_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS public.year_end_external_ar_reconciliation_documents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id  uuid NOT NULL REFERENCES public.year_end_external_ar_reconciliations(id) ON DELETE RESTRICT,
  company_id         uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  document_id        uuid NOT NULL REFERENCES public.document_attachments(id) ON DELETE RESTRICT,
  evidence_sha256    text NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reconciliation_id, document_id)
);

CREATE TABLE IF NOT EXISTS public.year_end_external_ar_reconciliation_invalidations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id  uuid NOT NULL UNIQUE REFERENCES public.year_end_external_ar_reconciliations(id) ON DELETE RESTRICT,
  company_id         uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  reason             text NOT NULL,
  invalidated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.year_end_external_ap_reconciliations (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id         uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE RESTRICT,
  balance_date             date NOT NULL,
  ledger_balance           numeric(18,2) NOT NULL,
  internal_payables        numeric(18,2) NOT NULL,
  expected_legacy_balance  numeric(18,2) NOT NULL,
  external_legacy_balance  numeric(18,2) NOT NULL,
  difference               numeric(18,2) NOT NULL CHECK (abs(difference) < 0.01),
  ledger_snapshot_hash     text NOT NULL CHECK (ledger_snapshot_hash ~ '^[0-9a-f]{64}$'),
  verification_method      text NOT NULL,
  comment                  text NOT NULL,
  source_sie_import_id     uuid REFERENCES public.sie_imports(id) ON DELETE RESTRICT,
  idempotency_key          text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  verified_by              uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  verified_at              timestamptz NOT NULL DEFAULT now(),
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, fiscal_period_id),
  UNIQUE (company_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS public.year_end_external_ap_reconciliation_documents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id  uuid NOT NULL REFERENCES public.year_end_external_ap_reconciliations(id) ON DELETE RESTRICT,
  company_id         uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  document_id        uuid NOT NULL REFERENCES public.document_attachments(id) ON DELETE RESTRICT,
  evidence_sha256    text NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reconciliation_id, document_id)
);

CREATE TABLE IF NOT EXISTS public.year_end_external_ap_reconciliation_invalidations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id  uuid NOT NULL UNIQUE REFERENCES public.year_end_external_ap_reconciliations(id) ON DELETE RESTRICT,
  company_id         uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  reason             text NOT NULL,
  invalidated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_migrated_receivables_period
  ON public.migrated_customer_receivables
    (company_id, fiscal_period_id, balance_date)
  WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_migrated_payables_period
  ON public.migrated_supplier_payables
    (company_id, fiscal_period_id, balance_date)
  WHERE superseded_at IS NULL;

CREATE OR REPLACE FUNCTION public.historical_support_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'HISTORICAL_SUPPORT_APPEND_ONLY'
    USING ERRCODE = '55000';
END;
$$;

-- Read access only for authenticated tenants. All writes use service-only RPCs.
DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'year_end_control_accounts',
    'migrated_customer_receivables',
    'migrated_receivable_documents',
    'migrated_receivable_voucher_links',
    'migrated_receivable_payments',
    'migrated_supplier_payables',
    'migrated_supplier_payable_documents',
    'migrated_supplier_payable_voucher_links',
    'migrated_supplier_payable_payments',
    'year_end_external_ar_reconciliations',
    'year_end_external_ar_reconciliation_documents',
    'year_end_external_ar_reconciliation_invalidations',
    'year_end_external_ap_reconciliations',
    'year_end_external_ap_reconciliation_documents',
    'year_end_external_ap_reconciliation_invalidations'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', v_table || '_select', v_table);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT USING (' ||
      'EXISTS (SELECT 1 FROM public.resolve_company_access(company_id) access WHERE access.can_read))',
      v_table || '_select',
      v_table
    );
  END LOOP;
END
$$;

-- Accepted support evidence is immutable. A correction is a new row that
-- supersedes the prior row through the controlled RPC.
DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'migrated_receivable_documents',
    'migrated_receivable_voucher_links',
    'migrated_receivable_payments',
    'migrated_supplier_payable_documents',
    'migrated_supplier_payable_voucher_links',
    'migrated_supplier_payable_payments',
    'year_end_external_ar_reconciliations',
    'year_end_external_ar_reconciliation_documents',
    'year_end_external_ar_reconciliation_invalidations',
    'year_end_external_ap_reconciliations',
    'year_end_external_ap_reconciliation_documents',
    'year_end_external_ap_reconciliation_invalidations'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', v_table || '_immutable', v_table);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I ' ||
      'FOR EACH ROW EXECUTE FUNCTION public.historical_support_immutable()',
      v_table || '_immutable',
      v_table
    );
  END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION public.__year_end_control_ledger_snapshot(
  p_company_id uuid,
  p_control_category text,
  p_as_of_date date
) RETURNS TABLE (
  ledger_balance numeric,
  snapshot_hash text,
  ledger_line_count integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  WITH ledger_rows AS (
    SELECT
      jel.id,
      je.id AS journal_entry_id,
      je.entry_date,
      jel.account_number,
      round(jel.debit_amount, 2) AS debit_amount,
      round(jel.credit_amount, 2) AS credit_amount
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    JOIN public.year_end_control_accounts ca
      ON ca.company_id = p_company_id
     AND ca.control_category = p_control_category
     AND ca.account_number = jel.account_number
     AND ca.active
    WHERE je.company_id = p_company_id
      AND je.entry_date <= p_as_of_date
      AND je.status IN ('posted', 'reversed')
  ),
  aggregated AS (
    SELECT
      round(coalesce(sum(
        CASE
          WHEN p_control_category IN (
            'supplier_payables', 'equity_accounts', 'tax_accounts', 'vat_accounts'
          )
            THEN credit_amount - debit_amount
          ELSE debit_amount - credit_amount
        END
      ), 0), 2) AS balance,
      count(*)::integer AS line_count,
      coalesce(string_agg(
        concat_ws(
          '|',
          id::text,
          journal_entry_id::text,
          entry_date::text,
          account_number,
          debit_amount::text,
          credit_amount::text
        ),
        E'\n' ORDER BY entry_date, journal_entry_id, id
      ), '') AS canonical_rows
    FROM ledger_rows
  )
  SELECT
    aggregated.balance,
    encode(
      digest(
        convert_to(
          concat_ws(
            '|',
            p_company_id::text,
            p_control_category,
            p_as_of_date::text,
            aggregated.line_count::text,
            aggregated.canonical_rows
          ),
          'UTF8'
        ),
        'sha256'::text
      ),
      'hex'::text
    ),
    aggregated.line_count
  FROM aggregated;
$$;

REVOKE ALL ON FUNCTION public.__year_end_control_ledger_snapshot(uuid, text, date)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.__year_end_control_ledger_snapshot(uuid, text, date)
  TO service_role;

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
    'verification_stale', v_stale OR v_invalidated,
    'source_import_invalidated',
      v_source_invalidated OR v_external_source_invalidated,
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
      AND NOT v_stale
      AND NOT v_invalidated
      AND NOT v_source_invalidated
      AND NOT v_external_source_invalidated
  );
END;
$$;

REVOKE ALL ON FUNCTION public.__year_end_open_item_reconciliation_json(
  uuid, uuid, date, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.__year_end_open_item_reconciliation_json(
  uuid, uuid, date, text
) TO service_role;

CREATE OR REPLACE FUNCTION public.customer_receivables_reconciliation_at(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_as_of_date date
) RETURNS TABLE (
  ledger_balance numeric,
  internal_receivables numeric,
  migrated_receivables numeric,
  external_verified_receivables numeric,
  total_subledger numeric,
  expected_legacy_balance numeric,
  difference numeric,
  reconciliation_mode text,
  missing_evidence_count integer,
  invalid_item_count integer,
  overallocated_payment_count integer,
  verification_stale boolean,
  source_import_invalidated boolean,
  is_reconciled boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    (j->>'ledger_balance')::numeric,
    (j->>'internal_open_items')::numeric,
    (j->>'migrated_open_items')::numeric,
    (j->>'external_verified_open_items')::numeric,
    (j->>'total_subledger')::numeric,
    (j->>'expected_legacy_balance')::numeric,
    (j->>'difference')::numeric,
    j->>'reconciliation_mode',
    (j->>'missing_evidence_count')::integer,
    (j->>'invalid_item_count')::integer,
    (j->>'overallocated_payment_count')::integer,
    (j->>'verification_stale')::boolean,
    (j->>'source_import_invalidated')::boolean,
    (j->>'is_reconciled')::boolean
  FROM (
    SELECT public.__year_end_open_item_reconciliation_json(
      p_company_id, p_fiscal_period_id, p_as_of_date, 'ar'
    ) AS j
  ) status;
$$;

CREATE OR REPLACE FUNCTION public.supplier_payables_reconciliation_at(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_as_of_date date
) RETURNS TABLE (
  ledger_balance numeric,
  internal_payables numeric,
  migrated_payables numeric,
  external_verified_payables numeric,
  total_subledger numeric,
  expected_legacy_balance numeric,
  difference numeric,
  reconciliation_mode text,
  missing_evidence_count integer,
  invalid_item_count integer,
  overallocated_payment_count integer,
  verification_stale boolean,
  source_import_invalidated boolean,
  is_reconciled boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    (j->>'ledger_balance')::numeric,
    (j->>'internal_open_items')::numeric,
    (j->>'migrated_open_items')::numeric,
    (j->>'external_verified_open_items')::numeric,
    (j->>'total_subledger')::numeric,
    (j->>'expected_legacy_balance')::numeric,
    (j->>'difference')::numeric,
    j->>'reconciliation_mode',
    (j->>'missing_evidence_count')::integer,
    (j->>'invalid_item_count')::integer,
    (j->>'overallocated_payment_count')::integer,
    (j->>'verification_stale')::boolean,
    (j->>'source_import_invalidated')::boolean,
    (j->>'is_reconciled')::boolean
  FROM (
    SELECT public.__year_end_open_item_reconciliation_json(
      p_company_id, p_fiscal_period_id, p_as_of_date, 'ap'
    ) AS j
  ) status;
$$;

REVOKE ALL ON FUNCTION public.customer_receivables_reconciliation_at(
  uuid, uuid, date
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.supplier_payables_reconciliation_at(
  uuid, uuid, date
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_receivables_reconciliation_at(
  uuid, uuid, date
) TO service_role;
GRANT EXECUTE ON FUNCTION public.supplier_payables_reconciliation_at(
  uuid, uuid, date
) TO service_role;

CREATE OR REPLACE FUNCTION public.record_migrated_open_item(
  p_kind text,
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_user_id uuid,
  p_payload jsonb,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_role text := coalesce(auth.role(), current_user::text);
  v_period public.fiscal_periods%ROWTYPE;
  v_remaining numeric;
  v_original numeric;
  v_paid numeric;
  v_currency text;
  v_rate numeric;
  v_remaining_sek numeric;
  v_id uuid;
  v_payload_hash text;
  v_existing_hash text;
BEGIN
  IF v_role NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'HISTORICAL_OPEN_ITEM_SERVICE_ONLY'
      USING ERRCODE = '42501';
  END IF;
  IF p_kind NOT IN ('ar', 'ap')
     OR p_idempotency_key IS NULL
     OR length(p_idempotency_key) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'HISTORICAL_OPEN_ITEM_INVALID_ARGUMENT'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat_ws(':', 'historical-open-item', p_company_id, p_fiscal_period_id, p_kind),
    0
  ));

  SELECT fp.* INTO v_period
  FROM public.fiscal_periods fp
  WHERE fp.id = p_fiscal_period_id
    AND fp.company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND OR v_period.is_closed OR v_period.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'HISTORICAL_OPEN_ITEM_PERIOD_NOT_OPEN'
      USING ERRCODE = '55000';
  END IF;

  IF (
    p_kind = 'ar'
    AND EXISTS (
      SELECT 1 FROM public.year_end_external_ar_reconciliations er
      WHERE er.company_id = p_company_id
        AND er.fiscal_period_id = p_fiscal_period_id
    )
  ) OR (
    p_kind = 'ap'
    AND EXISTS (
      SELECT 1 FROM public.year_end_external_ap_reconciliations er
      WHERE er.company_id = p_company_id
        AND er.fiscal_period_id = p_fiscal_period_id
    )
  ) THEN
    RAISE EXCEPTION 'HISTORICAL_OPEN_ITEM_MODE_CONFLICT'
      USING ERRCODE = '23514';
  END IF;

  v_currency := upper(coalesce(nullif(p_payload->>'currency', ''), 'SEK'));
  v_original := round((p_payload->>'original_amount_currency')::numeric, 2);
  v_paid := round(coalesce((p_payload->>'paid_amount_currency')::numeric, 0), 2);
  v_remaining := round((p_payload->>'remaining_amount_currency')::numeric, 2);
  v_rate := CASE
    WHEN v_currency = 'SEK' THEN 1
    ELSE (p_payload->>'booked_exchange_rate')::numeric
  END;
  v_remaining_sek := round(v_remaining * v_rate, 2);
  IF v_original < 0 OR v_paid < 0 OR v_remaining < 0
     OR v_paid + v_remaining > v_original + 0.01
     OR v_rate <= 0 THEN
    RAISE EXCEPTION 'HISTORICAL_OPEN_ITEM_INVALID_AMOUNT'
      USING ERRCODE = '23514';
  END IF;
  v_payload_hash := encode(digest(
    convert_to(
      jsonb_build_object(
        'kind', p_kind,
        'company_id', p_company_id,
        'fiscal_period_id', p_fiscal_period_id,
        'payload', p_payload,
        'currency', v_currency,
        'original', v_original,
        'paid', v_paid,
        'remaining', v_remaining,
        'rate', v_rate,
        'remaining_sek', v_remaining_sek
      )::text,
      'UTF8'
    ),
    'sha256'::text
  ), 'hex'::text);

  IF p_kind = 'ar' THEN
    INSERT INTO public.migrated_customer_receivables (
      company_id, fiscal_period_id, balance_date,
      customer_name_snapshot, customer_number_snapshot,
      invoice_number, invoice_date, due_date, currency,
      original_amount_currency, paid_amount_at_balance_date_currency,
      remaining_amount_at_balance_date_currency, booked_exchange_rate,
      remaining_amount_sek_at_balance_date, status_at_balance_date,
      control_account, sie_import_id, external_reference, comment,
      idempotency_key, payload_hash, created_by, verified_by, verified_at
    ) VALUES (
      p_company_id, p_fiscal_period_id, v_period.period_end,
      p_payload->>'counterparty_name', p_payload->>'counterparty_number',
      p_payload->>'invoice_number', (p_payload->>'invoice_date')::date,
      (p_payload->>'due_date')::date, v_currency,
      v_original, v_paid, v_remaining, v_rate, v_remaining_sek,
      coalesce(p_payload->>'status_at_balance_date', 'open'),
      coalesce(nullif(p_payload->>'control_account', ''), '1510'),
      nullif(p_payload->>'sie_import_id', '')::uuid,
      p_payload->>'external_reference', p_payload->>'comment',
      p_idempotency_key, v_payload_hash, p_user_id, p_user_id, now()
    )
    ON CONFLICT (company_id, fiscal_period_id, idempotency_key)
      DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      SELECT r.id, r.payload_hash INTO v_id, v_existing_hash
      FROM public.migrated_customer_receivables r
      WHERE r.company_id = p_company_id
        AND r.fiscal_period_id = p_fiscal_period_id
        AND r.idempotency_key = p_idempotency_key;
    END IF;
  ELSE
    INSERT INTO public.migrated_supplier_payables (
      company_id, fiscal_period_id, balance_date,
      supplier_name_snapshot, supplier_number_snapshot,
      supplier_invoice_number, invoice_date, due_date, currency,
      original_amount_currency, paid_amount_at_balance_date_currency,
      remaining_amount_at_balance_date_currency, booked_exchange_rate,
      remaining_amount_sek_at_balance_date, status_at_balance_date,
      control_account, sie_import_id, external_reference, comment,
      idempotency_key, payload_hash, created_by, verified_by, verified_at
    ) VALUES (
      p_company_id, p_fiscal_period_id, v_period.period_end,
      p_payload->>'counterparty_name', p_payload->>'counterparty_number',
      p_payload->>'invoice_number', (p_payload->>'invoice_date')::date,
      (p_payload->>'due_date')::date, v_currency,
      v_original, v_paid, v_remaining, v_rate, v_remaining_sek,
      coalesce(p_payload->>'status_at_balance_date', 'open'),
      coalesce(nullif(p_payload->>'control_account', ''), '2440'),
      nullif(p_payload->>'sie_import_id', '')::uuid,
      p_payload->>'external_reference', p_payload->>'comment',
      p_idempotency_key, v_payload_hash, p_user_id, p_user_id, now()
    )
    ON CONFLICT (company_id, fiscal_period_id, idempotency_key)
      DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      SELECT p.id, p.payload_hash INTO v_id, v_existing_hash
      FROM public.migrated_supplier_payables p
      WHERE p.company_id = p_company_id
        AND p.fiscal_period_id = p_fiscal_period_id
        AND p.idempotency_key = p_idempotency_key;
    END IF;
  END IF;

  IF v_existing_hash IS NOT NULL AND v_existing_hash <> v_payload_hash THEN
    RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'
      USING ERRCODE = '23505';
  END IF;

  IF v_existing_hash IS NULL THEN
    INSERT INTO public.audit_log (
    user_id, company_id, action, table_name, record_id, actor_id,
    new_state, description
  ) VALUES (
    p_user_id, p_company_id, 'SECURITY_EVENT',
    CASE WHEN p_kind = 'ar'
      THEN 'migrated_customer_receivables'
      ELSE 'migrated_supplier_payables' END,
    v_id, p_user_id,
    jsonb_build_object(
      'fiscal_period_id', p_fiscal_period_id,
      'balance_date', v_period.period_end,
      'remaining_amount_sek', v_remaining_sek,
      'accounting_origin', 'imported_sie',
      'recognition_status', 'already_booked'
    ),
    'Historisk stödregisterpost registrerad utan ny bokföringsverifikation.'
    );
  END IF;

  RETURN jsonb_build_object(
    'id', v_id,
    'remaining_amount_sek', v_remaining_sek,
    'accounting_origin', 'imported_sie',
    'recognition_status', 'already_booked',
    'journal_entry_created', false,
    'idempotent', v_existing_hash IS NOT NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_migrated_open_item(
  text, uuid, uuid, uuid, jsonb, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_migrated_open_item(
  text, uuid, uuid, uuid, jsonb, text
) TO service_role;

CREATE OR REPLACE FUNCTION public.attach_migrated_open_item_document(
  p_kind text,
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_item_id uuid,
  p_document_id uuid,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text := coalesce(auth.role(), current_user::text);
  v_link_id uuid;
BEGIN
  IF v_role NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'HISTORICAL_OPEN_ITEM_SERVICE_ONLY'
      USING ERRCODE = '42501';
  END IF;
  IF p_kind = 'ar' THEN
    INSERT INTO public.migrated_receivable_documents (
      company_id, receivable_id, document_id, created_by
    )
    SELECT p_company_id, r.id, p_document_id, p_user_id
    FROM public.migrated_customer_receivables r
    JOIN public.document_attachments d
      ON d.id = p_document_id AND d.company_id = p_company_id
    WHERE r.id = p_item_id
      AND r.company_id = p_company_id
      AND r.fiscal_period_id = p_fiscal_period_id
      AND r.superseded_at IS NULL
    ON CONFLICT (receivable_id, document_id) DO NOTHING
    RETURNING id INTO v_link_id;
  ELSIF p_kind = 'ap' THEN
    INSERT INTO public.migrated_supplier_payable_documents (
      company_id, payable_id, document_id, created_by
    )
    SELECT p_company_id, p.id, p_document_id, p_user_id
    FROM public.migrated_supplier_payables p
    JOIN public.document_attachments d
      ON d.id = p_document_id AND d.company_id = p_company_id
    WHERE p.id = p_item_id
      AND p.company_id = p_company_id
      AND p.fiscal_period_id = p_fiscal_period_id
      AND p.superseded_at IS NULL
    ON CONFLICT (payable_id, document_id) DO NOTHING
    RETURNING id INTO v_link_id;
  ELSE
    RAISE EXCEPTION 'HISTORICAL_OPEN_ITEM_INVALID_KIND'
      USING ERRCODE = '22023';
  END IF;
  IF v_link_id IS NULL THEN
    RAISE EXCEPTION 'HISTORICAL_OPEN_ITEM_OR_DOCUMENT_NOT_FOUND'
      USING ERRCODE = '23503';
  END IF;

  INSERT INTO public.audit_log (
    user_id, company_id, action, table_name, record_id, actor_id,
    new_state, description
  ) VALUES (
    p_user_id, p_company_id, 'SECURITY_EVENT',
    CASE WHEN p_kind = 'ar'
      THEN 'migrated_receivable_documents'
      ELSE 'migrated_supplier_payable_documents' END,
    v_link_id, p_user_id,
    jsonb_build_object(
      'fiscal_period_id', p_fiscal_period_id,
      'item_id', p_item_id,
      'document_id', p_document_id
    ),
    'Underlag kopplat till historisk stödregisterpost.'
  );
  RETURN jsonb_build_object('id', v_link_id);
END;
$$;

REVOKE ALL ON FUNCTION public.attach_migrated_open_item_document(
  text, uuid, uuid, uuid, uuid, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attach_migrated_open_item_document(
  text, uuid, uuid, uuid, uuid, uuid
) TO service_role;

CREATE OR REPLACE FUNCTION public.enforce_historical_open_item_mode()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_TABLE_NAME = 'migrated_customer_receivables' THEN
    IF EXISTS (
      SELECT 1
      FROM public.year_end_external_ar_reconciliations er
      WHERE er.company_id = NEW.company_id
        AND er.fiscal_period_id = NEW.fiscal_period_id
    ) THEN
      RAISE EXCEPTION 'HISTORICAL_OPEN_ITEM_MODE_CONFLICT'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'year_end_external_ar_reconciliations' THEN
    IF EXISTS (
      SELECT 1
      FROM public.migrated_customer_receivables r
      WHERE r.company_id = NEW.company_id
        AND r.fiscal_period_id = NEW.fiscal_period_id
        AND r.superseded_at IS NULL
    ) THEN
      RAISE EXCEPTION 'HISTORICAL_OPEN_ITEM_MODE_CONFLICT'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'migrated_supplier_payables' THEN
    IF EXISTS (
      SELECT 1
      FROM public.year_end_external_ap_reconciliations er
      WHERE er.company_id = NEW.company_id
        AND er.fiscal_period_id = NEW.fiscal_period_id
    ) THEN
      RAISE EXCEPTION 'HISTORICAL_OPEN_ITEM_MODE_CONFLICT'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'year_end_external_ap_reconciliations' THEN
    IF EXISTS (
      SELECT 1
      FROM public.migrated_supplier_payables p
      WHERE p.company_id = NEW.company_id
        AND p.fiscal_period_id = NEW.fiscal_period_id
        AND p.superseded_at IS NULL
    ) THEN
      RAISE EXCEPTION 'HISTORICAL_OPEN_ITEM_MODE_CONFLICT'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS migrated_customer_receivables_mode
  ON public.migrated_customer_receivables;
CREATE TRIGGER migrated_customer_receivables_mode
  BEFORE INSERT ON public.migrated_customer_receivables
  FOR EACH ROW EXECUTE FUNCTION public.enforce_historical_open_item_mode();
DROP TRIGGER IF EXISTS year_end_external_ar_mode
  ON public.year_end_external_ar_reconciliations;
CREATE TRIGGER year_end_external_ar_mode
  BEFORE INSERT ON public.year_end_external_ar_reconciliations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_historical_open_item_mode();
DROP TRIGGER IF EXISTS migrated_supplier_payables_mode
  ON public.migrated_supplier_payables;
CREATE TRIGGER migrated_supplier_payables_mode
  BEFORE INSERT ON public.migrated_supplier_payables
  FOR EACH ROW EXECUTE FUNCTION public.enforce_historical_open_item_mode();
DROP TRIGGER IF EXISTS year_end_external_ap_mode
  ON public.year_end_external_ap_reconciliations;
CREATE TRIGGER year_end_external_ap_mode
  BEFORE INSERT ON public.year_end_external_ap_reconciliations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_historical_open_item_mode();

CREATE OR REPLACE FUNCTION public.record_external_open_item_reconciliation(
  p_kind text,
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_user_id uuid,
  p_external_legacy_balance numeric,
  p_document_id uuid,
  p_verification_method text,
  p_comment text,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text := coalesce(auth.role(), current_user::text);
  v_period public.fiscal_periods%ROWTYPE;
  v_document public.document_attachments%ROWTYPE;
  v_status jsonb;
  v_expected numeric;
  v_difference numeric;
  v_source_import_id uuid;
  v_id uuid;
  v_existing_id uuid;
  v_existing_key text;
  v_existing_balance numeric;
BEGIN
  IF v_role NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'HISTORICAL_EXTERNAL_RECONCILIATION_SERVICE_ONLY'
      USING ERRCODE = '42501';
  END IF;
  IF p_kind NOT IN ('ar', 'ap')
     OR p_idempotency_key IS NULL
     OR length(p_idempotency_key) NOT BETWEEN 8 AND 128
     OR length(btrim(coalesce(p_verification_method, ''))) < 3
     OR length(btrim(coalesce(p_comment, ''))) < 3 THEN
    RAISE EXCEPTION 'HISTORICAL_EXTERNAL_RECONCILIATION_INVALID_ARGUMENT'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat_ws(':', 'external-open-item', p_company_id, p_fiscal_period_id, p_kind),
    0
  ));

  SELECT fp.* INTO v_period
  FROM public.fiscal_periods fp
  WHERE fp.id = p_fiscal_period_id
    AND fp.company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND OR v_period.is_closed OR v_period.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'HISTORICAL_EXTERNAL_RECONCILIATION_PERIOD_NOT_OPEN'
      USING ERRCODE = '55000';
  END IF;

  SELECT da.* INTO v_document
  FROM public.document_attachments da
  WHERE da.id = p_document_id
    AND da.company_id = p_company_id
  FOR SHARE;
  IF NOT FOUND
     OR v_document.file_size_bytes IS NULL
     OR v_document.file_size_bytes <= 0
     OR v_document.sha256_hash !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'HISTORICAL_EXTERNAL_RECONCILIATION_EVIDENCE_INVALID'
      USING ERRCODE = '23514';
  END IF;

  IF p_kind = 'ar' THEN
    SELECT er.id, er.idempotency_key, er.external_legacy_balance
      INTO v_existing_id, v_existing_key, v_existing_balance
    FROM public.year_end_external_ar_reconciliations er
    WHERE er.company_id = p_company_id
      AND er.fiscal_period_id = p_fiscal_period_id;
  ELSE
    SELECT er.id, er.idempotency_key, er.external_legacy_balance
      INTO v_existing_id, v_existing_key, v_existing_balance
    FROM public.year_end_external_ap_reconciliations er
    WHERE er.company_id = p_company_id
      AND er.fiscal_period_id = p_fiscal_period_id;
  END IF;

  IF v_existing_id IS NOT NULL THEN
    IF v_existing_key = p_idempotency_key
       AND v_existing_balance = round(p_external_legacy_balance, 2) THEN
      RETURN jsonb_build_object('id', v_existing_id, 'idempotent', true);
    END IF;
    RAISE EXCEPTION 'HISTORICAL_EXTERNAL_RECONCILIATION_ALREADY_EXISTS'
      USING ERRCODE = '23505';
  END IF;

  v_status := public.__year_end_open_item_reconciliation_json(
    p_company_id,
    p_fiscal_period_id,
    v_period.period_end,
    p_kind
  );
  v_expected := (v_status->>'expected_legacy_balance')::numeric;
  v_difference := round(p_external_legacy_balance - v_expected, 2);
  IF abs(v_difference) >= 0.01 THEN
    RAISE EXCEPTION
      'HISTORICAL_EXTERNAL_RECONCILIATION_DIFFERENCE: external=% expected=% difference=%',
      round(p_external_legacy_balance, 2),
      v_expected,
      v_difference
      USING ERRCODE = '23514';
  END IF;

  SELECT si.id INTO v_source_import_id
  FROM public.sie_imports si
  WHERE si.company_id = p_company_id
    AND si.status = 'completed'
    AND daterange(si.fiscal_year_start, si.fiscal_year_end, '[]')
      && daterange(v_period.period_start, v_period.period_end, '[]')
  ORDER BY si.imported_at DESC NULLS LAST, si.created_at DESC
  LIMIT 1;

  IF p_kind = 'ar' THEN
    INSERT INTO public.year_end_external_ar_reconciliations (
      company_id, fiscal_period_id, balance_date,
      ledger_balance, internal_receivables, expected_legacy_balance,
      external_legacy_balance, difference, ledger_snapshot_hash,
      verification_method, comment, source_sie_import_id,
      idempotency_key, verified_by
    ) VALUES (
      p_company_id, p_fiscal_period_id, v_period.period_end,
      (v_status->>'ledger_balance')::numeric,
      (v_status->>'internal_open_items')::numeric,
      v_expected, round(p_external_legacy_balance, 2), v_difference,
      v_status->>'snapshot_hash', p_verification_method, p_comment,
      v_source_import_id, p_idempotency_key, p_user_id
    ) RETURNING id INTO v_id;

    INSERT INTO public.year_end_external_ar_reconciliation_documents (
      reconciliation_id, company_id, document_id, evidence_sha256
    ) VALUES (
      v_id, p_company_id, p_document_id, lower(v_document.sha256_hash)
    );
  ELSE
    INSERT INTO public.year_end_external_ap_reconciliations (
      company_id, fiscal_period_id, balance_date,
      ledger_balance, internal_payables, expected_legacy_balance,
      external_legacy_balance, difference, ledger_snapshot_hash,
      verification_method, comment, source_sie_import_id,
      idempotency_key, verified_by
    ) VALUES (
      p_company_id, p_fiscal_period_id, v_period.period_end,
      (v_status->>'ledger_balance')::numeric,
      (v_status->>'internal_open_items')::numeric,
      v_expected, round(p_external_legacy_balance, 2), v_difference,
      v_status->>'snapshot_hash', p_verification_method, p_comment,
      v_source_import_id, p_idempotency_key, p_user_id
    ) RETURNING id INTO v_id;

    INSERT INTO public.year_end_external_ap_reconciliation_documents (
      reconciliation_id, company_id, document_id, evidence_sha256
    ) VALUES (
      v_id, p_company_id, p_document_id, lower(v_document.sha256_hash)
    );
  END IF;

  INSERT INTO public.audit_log (
    user_id, company_id, action, table_name, record_id, actor_id,
    new_state, description
  ) VALUES (
    p_user_id, p_company_id, 'SECURITY_EVENT',
    CASE WHEN p_kind = 'ar'
      THEN 'year_end_external_ar_reconciliations'
      ELSE 'year_end_external_ap_reconciliations' END,
    v_id, p_user_id,
    jsonb_build_object(
      'fiscal_period_id', p_fiscal_period_id,
      'balance_date', v_period.period_end,
      'ledger_balance', (v_status->>'ledger_balance')::numeric,
      'expected_legacy_balance', v_expected,
      'external_legacy_balance', round(p_external_legacy_balance, 2),
      'difference', v_difference,
      'document_id', p_document_id
    ),
    'Extern historisk reskontra verifierad mot serverberäknad huvudbok.'
  );

  RETURN jsonb_build_object(
    'id', v_id,
    'difference', v_difference,
    'idempotent', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_external_open_item_reconciliation(
  text, uuid, uuid, uuid, numeric, uuid, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_external_open_item_reconciliation(
  text, uuid, uuid, uuid, numeric, uuid, text, text, text
) TO service_role;

NOTIFY pgrst, 'reload schema';
