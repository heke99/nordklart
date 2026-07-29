-- Manual cash/bank reconciliation for year-end cases without a bank feed.
--
-- A SIE-only or one-off year-end customer can have a complete ledger but no
-- bank transactions in Nordklart. The ordinary bank matcher can never turn
-- that state green because there is no bank-side dataset to match against.
-- This migration adds a controlled alternative:
--
--   * the user supplies the actual closing balance and an archived statement;
--   * PostgreSQL calculates the ledger balance itself and accepts only zero
--     difference;
--   * the verification and its evidence are append-only;
--   * a later ledger posting invalidates the verification automatically;
--   * year_end_db_blockers() uses the same canonical status as the UI and the
--     transaction-internal execute_year_end_closing() check.
--
-- Manual verification is deliberately unavailable when a bank feed or bank
-- transactions exist for the account/period. Those cases must use the strict
-- transaction-to-ledger matcher and cannot bypass unresolved rows.
--
-- pg-test: covered-by
-- lib/core/bookkeeping/__tests__/year-end-readiness-reconciliation.pg.test.ts

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Append-only verification evidence and append-only invalidations.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.year_end_manual_cash_reconciliations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id      uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE CASCADE,
  cash_account_id       uuid REFERENCES public.cash_accounts(id) ON DELETE RESTRICT,
  ledger_account        text NOT NULL CHECK (ledger_account ~ '^[0-9]{4,}$'),
  currency              text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  balance_date          date NOT NULL,
  statement_balance     numeric(18,2) NOT NULL,
  ledger_balance        numeric(18,2) NOT NULL,
  difference            numeric(18,2) NOT NULL CHECK (abs(difference) < 0.01),
  ledger_snapshot_hash  text NOT NULL CHECK (ledger_snapshot_hash ~ '^[0-9a-f]{64}$'),
  ledger_line_count     integer NOT NULL CHECK (ledger_line_count >= 0),
  evidence_document_id  uuid NOT NULL UNIQUE
    REFERENCES public.document_attachments(id) ON DELETE RESTRICT,
  evidence_sha256       text NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-fA-F]{64}$'),
  evidence_file_name    text NOT NULL CHECK (length(btrim(evidence_file_name)) > 0),
  evidence_mime_type    text,
  evidence_size_bytes   bigint CHECK (evidence_size_bytes IS NULL OR evidence_size_bytes > 0),
  idempotency_key       text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  attestation           text NOT NULL,
  verified_by           uuid NOT NULL,
  verified_at           timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, fiscal_period_id, ledger_account, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_year_end_manual_cash_reconciliations_period
  ON public.year_end_manual_cash_reconciliations
    (company_id, fiscal_period_id, ledger_account, verified_at DESC);

CREATE TABLE IF NOT EXISTS public.year_end_manual_cash_reconciliation_invalidations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id     uuid NOT NULL UNIQUE
    REFERENCES public.year_end_manual_cash_reconciliations(id) ON DELETE RESTRICT,
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id      uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE CASCADE,
  invalidated_by_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  reason                text NOT NULL,
  invalidated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_year_end_manual_cash_invalidations_period
  ON public.year_end_manual_cash_reconciliation_invalidations
    (company_id, fiscal_period_id, invalidated_at DESC);

ALTER TABLE public.year_end_manual_cash_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.year_end_manual_cash_reconciliation_invalidations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS year_end_manual_cash_reconciliations_select
  ON public.year_end_manual_cash_reconciliations;
CREATE POLICY year_end_manual_cash_reconciliations_select
  ON public.year_end_manual_cash_reconciliations
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

DROP POLICY IF EXISTS year_end_manual_cash_invalidations_select
  ON public.year_end_manual_cash_reconciliation_invalidations;
CREATE POLICY year_end_manual_cash_invalidations_select
  ON public.year_end_manual_cash_reconciliation_invalidations
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

-- No client INSERT/UPDATE/DELETE policies. Creation goes through the
-- service-only RPC below and both tables are physically append-only.
CREATE OR REPLACE FUNCTION public.year_end_manual_cash_evidence_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'YEAR_END_MANUAL_RECONCILIATION_IMMUTABLE'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS year_end_manual_cash_reconciliations_no_update
  ON public.year_end_manual_cash_reconciliations;
CREATE TRIGGER year_end_manual_cash_reconciliations_no_update
  BEFORE UPDATE OR DELETE ON public.year_end_manual_cash_reconciliations
  FOR EACH ROW EXECUTE FUNCTION public.year_end_manual_cash_evidence_immutable();

DROP TRIGGER IF EXISTS year_end_manual_cash_invalidations_no_update
  ON public.year_end_manual_cash_reconciliation_invalidations;
CREATE TRIGGER year_end_manual_cash_invalidations_no_update
  BEFORE UPDATE OR DELETE ON public.year_end_manual_cash_reconciliation_invalidations
  FOR EACH ROW EXECUTE FUNCTION public.year_end_manual_cash_evidence_immutable();

-- Once a document is evidence for an accepted reconciliation, neither its
-- metadata nor its storage identity may be mutated or deleted. A new statement
-- produces a new document and a new verification row.
CREATE OR REPLACE FUNCTION public.protect_year_end_manual_cash_document()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.year_end_manual_cash_reconciliations r
    WHERE r.evidence_document_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'YEAR_END_MANUAL_RECONCILIATION_DOCUMENT_IMMUTABLE'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_year_end_manual_cash_document
  ON public.document_attachments;
CREATE TRIGGER protect_year_end_manual_cash_document
  BEFORE UPDATE OR DELETE ON public.document_attachments
  FOR EACH ROW EXECUTE FUNCTION public.protect_year_end_manual_cash_document();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Canonical, deterministic ledger snapshot.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.__year_end_cash_ledger_snapshot(
  p_company_id uuid,
  p_ledger_account text,
  p_balance_date date
) RETURNS TABLE (
  ledger_balance numeric,
  snapshot_hash text,
  ledger_line_count integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
-- Supabase installs pgcrypto in the extensions schema. Keep both public and
-- extensions visible so digest() resolves correctly regardless of where the
-- extension is installed.
SET search_path = public, extensions, pg_temp
AS $$
  WITH rows AS (
    SELECT
      jel.id,
      je.id AS journal_entry_id,
      je.entry_date,
      je.status,
      round(jel.debit_amount, 2) AS debit_amount,
      round(jel.credit_amount, 2) AS credit_amount
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.company_id = p_company_id
      AND je.entry_date <= p_balance_date
      AND je.status IN ('posted', 'reversed')
      AND jel.account_number = p_ledger_account
  ),
  aggregate AS (
    SELECT
      round(coalesce(sum(debit_amount - credit_amount), 0), 2) AS balance,
      count(*)::integer AS line_count,
      coalesce(
        string_agg(
          concat_ws(
            '|',
            id::text,
            journal_entry_id::text,
            entry_date::text,
            status,
            debit_amount::text,
            credit_amount::text
          ),
          E'\n' ORDER BY entry_date, journal_entry_id, id
        ),
        ''
      ) AS canonical_rows
    FROM rows
  )
  SELECT
    aggregate.balance,
    encode(
      digest(
        convert_to(
          concat_ws(
            '|',
            p_company_id::text,
            p_ledger_account,
            p_balance_date::text,
            aggregate.line_count::text,
            aggregate.canonical_rows
          ),
          'UTF8'
        ),
        'sha256'::text
      ),
      'hex'::text
    ),
    aggregate.line_count
  FROM aggregate;
$$;

REVOKE ALL ON FUNCTION public.__year_end_cash_ledger_snapshot(uuid, text, date)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.__year_end_cash_ledger_snapshot(uuid, text, date)
  TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Service-only creation RPC. It never trusts a browser-calculated balance.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.record_year_end_manual_cash_reconciliation(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_user_id uuid,
  p_cash_account_id uuid,
  p_statement_balance numeric,
  p_evidence_document_id uuid,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text := coalesce(auth.role(), current_user::text);
  v_period public.fiscal_periods%ROWTYPE;
  v_cash public.cash_accounts%ROWTYPE;
  v_ledger_account text;
  v_currency text;
  v_account_name text;
  v_bank_connection_id uuid;
  v_source text;
  v_is_primary boolean;
  v_transaction_count integer;
  v_snapshot record;
  v_document public.document_attachments%ROWTYPE;
  v_difference numeric;
  v_existing public.year_end_manual_cash_reconciliations%ROWTYPE;
  v_row public.year_end_manual_cash_reconciliations%ROWTYPE;
  v_attestation constant text :=
    'Jag intygar att det uppladdade underlaget visar faktiskt saldo på balansdagen och att saldot har jämförts mot Nordklarts serverberäknade huvudbok.';
BEGIN
  IF v_role NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'YEAR_END_MANUAL_RECONCILIATION_SERVICE_ONLY'
      USING ERRCODE = '42501';
  END IF;
  IF p_company_id IS NULL OR p_fiscal_period_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'YEAR_END_MANUAL_RECONCILIATION_INVALID_CONTEXT'
      USING ERRCODE = '22023';
  END IF;
  IF p_statement_balance IS NULL
     OR p_statement_balance <> round(p_statement_balance, 2) THEN
    RAISE EXCEPTION 'YEAR_END_MANUAL_RECONCILIATION_INVALID_BALANCE'
      USING ERRCODE = '22003';
  END IF;
  IF p_idempotency_key IS NULL
     OR length(p_idempotency_key) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'YEAR_END_MANUAL_RECONCILIATION_INVALID_IDEMPOTENCY_KEY'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      concat_ws(
        ':',
        'year-end-manual-cash',
        p_company_id::text,
        p_fiscal_period_id::text,
        coalesce(p_cash_account_id::text, 'fallback')
      ),
      0
    )
  );

  SELECT fp.* INTO v_period
  FROM public.fiscal_periods fp
  WHERE fp.id = p_fiscal_period_id
    AND fp.company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'YEAR_END_MANUAL_RECONCILIATION_PERIOD_NOT_FOUND'
      USING ERRCODE = '22023';
  END IF;
  IF v_period.is_closed OR v_period.locked_at IS NOT NULL
     OR v_period.closing_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'YEAR_END_MANUAL_RECONCILIATION_PERIOD_CLOSED'
      USING ERRCODE = '55000';
  END IF;

  IF p_cash_account_id IS NOT NULL THEN
    SELECT ca.* INTO v_cash
    FROM public.cash_accounts ca
    WHERE ca.id = p_cash_account_id
      AND ca.company_id = p_company_id
      AND ca.enabled
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'YEAR_END_MANUAL_RECONCILIATION_ACCOUNT_NOT_FOUND'
        USING ERRCODE = '22023';
    END IF;
    v_ledger_account := v_cash.ledger_account;
    v_currency := v_cash.currency;
    v_account_name := coalesce(nullif(btrim(v_cash.name), ''), 'Konto ' || v_cash.ledger_account);
    v_bank_connection_id := v_cash.bank_connection_id;
    v_source := v_cash.source;
    v_is_primary := v_cash.is_primary;
  ELSE
    IF EXISTS (
      SELECT 1
      FROM public.cash_accounts ca
      WHERE ca.company_id = p_company_id
        AND ca.enabled
    ) THEN
      RAISE EXCEPTION 'YEAR_END_MANUAL_RECONCILIATION_ACCOUNT_REQUIRED'
        USING ERRCODE = '22023';
    END IF;
    v_ledger_account := '1930';
    v_currency := 'SEK';
    v_account_name := 'Företagskonto 1930';
    v_bank_connection_id := NULL;
    v_source := 'manual';
    v_is_primary := true;
  END IF;

  -- A live/bank-sourced account must be reconciled through the bank matcher.
  IF v_bank_connection_id IS NOT NULL OR v_source = 'enable_banking' THEN
    RAISE EXCEPTION 'YEAR_END_MANUAL_RECONCILIATION_BANK_FEED_PRESENT'
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*)::integer INTO v_transaction_count
  FROM public.transactions t
  WHERE t.company_id = p_company_id
    AND t.date BETWEEN v_period.period_start AND v_period.period_end
    AND (
      (p_cash_account_id IS NULL AND coalesce(t.currency, 'SEK') = v_currency)
      OR t.cash_account_id = p_cash_account_id
      OR (
        p_cash_account_id IS NOT NULL
        AND v_is_primary
        AND t.cash_account_id IS NULL
        AND coalesce(t.currency, 'SEK') = v_currency
      )
    );

  IF v_transaction_count > 0 THEN
    RAISE EXCEPTION 'YEAR_END_MANUAL_RECONCILIATION_BANK_TRANSACTIONS_PRESENT: %',
      v_transaction_count
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_document
  FROM public.document_attachments da
  WHERE da.id = p_evidence_document_id
    AND da.company_id = p_company_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'YEAR_END_MANUAL_RECONCILIATION_EVIDENCE_NOT_FOUND'
      USING ERRCODE = '22023';
  END IF;
  IF v_document.file_size_bytes IS NULL OR v_document.file_size_bytes <= 0
     OR v_document.sha256_hash !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'YEAR_END_MANUAL_RECONCILIATION_EVIDENCE_INVALID'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing
  FROM public.year_end_manual_cash_reconciliations r
  WHERE r.company_id = p_company_id
    AND r.fiscal_period_id = p_fiscal_period_id
    AND r.ledger_account = v_ledger_account
    AND r.idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_existing.cash_account_id IS NOT DISTINCT FROM p_cash_account_id
       AND v_existing.statement_balance = round(p_statement_balance, 2)
       AND v_existing.evidence_document_id = p_evidence_document_id THEN
      RETURN jsonb_build_object(
        'id', v_existing.id,
        'cash_account_id', v_existing.cash_account_id,
        'ledger_account', v_existing.ledger_account,
        'currency', v_existing.currency,
        'statement_balance', v_existing.statement_balance,
        'ledger_balance', v_existing.ledger_balance,
        'difference', v_existing.difference,
        'verified_at', v_existing.verified_at,
        'idempotent', true
      );
    END IF;
    RAISE EXCEPTION 'YEAR_END_MANUAL_RECONCILIATION_IDEMPOTENCY_CONFLICT'
      USING ERRCODE = '23505';
  END IF;

  SELECT * INTO v_snapshot
  FROM public.__year_end_cash_ledger_snapshot(
    p_company_id,
    v_ledger_account,
    v_period.period_end
  );

  v_difference := round(round(p_statement_balance, 2) - v_snapshot.ledger_balance, 2);
  IF abs(v_difference) >= 0.01 THEN
    RAISE EXCEPTION
      'YEAR_END_MANUAL_RECONCILIATION_DIFFERENCE: statement=% ledger=% difference=% account=%',
      round(p_statement_balance, 2),
      v_snapshot.ledger_balance,
      v_difference,
      v_ledger_account
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.year_end_manual_cash_reconciliations (
    company_id,
    fiscal_period_id,
    cash_account_id,
    ledger_account,
    currency,
    balance_date,
    statement_balance,
    ledger_balance,
    difference,
    ledger_snapshot_hash,
    ledger_line_count,
    evidence_document_id,
    evidence_sha256,
    evidence_file_name,
    evidence_mime_type,
    evidence_size_bytes,
    idempotency_key,
    attestation,
    verified_by
  ) VALUES (
    p_company_id,
    p_fiscal_period_id,
    p_cash_account_id,
    v_ledger_account,
    v_currency,
    v_period.period_end,
    round(p_statement_balance, 2),
    v_snapshot.ledger_balance,
    v_difference,
    v_snapshot.snapshot_hash,
    v_snapshot.ledger_line_count,
    v_document.id,
    lower(v_document.sha256_hash),
    v_document.file_name,
    v_document.mime_type,
    v_document.file_size_bytes,
    p_idempotency_key,
    v_attestation,
    p_user_id
  )
  RETURNING * INTO v_row;

  INSERT INTO public.audit_log (
    user_id,
    company_id,
    action,
    table_name,
    record_id,
    actor_id,
    new_state,
    description
  ) VALUES (
    p_user_id,
    p_company_id,
    'SECURITY_EVENT',
    'year_end_manual_cash_reconciliations',
    v_row.id,
    p_user_id,
    jsonb_build_object(
      'company_id', p_company_id,
      'fiscal_period_id', p_fiscal_period_id,
      'cash_account_id', p_cash_account_id,
      'ledger_account', v_ledger_account,
      'currency', v_currency,
      'balance_date', v_period.period_end,
      'statement_balance', v_row.statement_balance,
      'ledger_balance', v_row.ledger_balance,
      'difference', v_row.difference,
      'ledger_snapshot_hash', v_row.ledger_snapshot_hash,
      'evidence_document_id', v_row.evidence_document_id,
      'evidence_sha256', v_row.evidence_sha256,
      'idempotency_key', p_idempotency_key
    ),
    format(
      'Manuell bokslutsavstämning verifierad för %s (%s) per %s.',
      v_account_name,
      v_ledger_account,
      v_period.period_end
    )
  );

  RETURN jsonb_build_object(
    'id', v_row.id,
    'cash_account_id', v_row.cash_account_id,
    'ledger_account', v_row.ledger_account,
    'currency', v_row.currency,
    'statement_balance', v_row.statement_balance,
    'ledger_balance', v_row.ledger_balance,
    'difference', v_row.difference,
    'verified_at', v_row.verified_at,
    'idempotent', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_year_end_manual_cash_reconciliation(
  uuid, uuid, uuid, uuid, numeric, uuid, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_year_end_manual_cash_reconciliation(
  uuid, uuid, uuid, uuid, numeric, uuid, text
) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Canonical status used by UI, readiness and the closing transaction.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.year_end_cash_reconciliation_status(
  p_company_id uuid,
  p_fiscal_period_id uuid
) RETURNS TABLE (
  cash_account_id uuid,
  ledger_account text,
  account_name text,
  currency text,
  reconciliation_mode text,
  ledger_balance numeric,
  statement_balance numeric,
  difference numeric,
  unmatched_transaction_count integer,
  unmatched_gl_line_count integer,
  matching_conflict_count integer,
  reconciliation_id uuid,
  evidence_document_id uuid,
  evidence_file_name text,
  evidence_sha256 text,
  verified_at timestamptz,
  invalidated_at timestamptz,
  invalidation_reason text,
  snapshot_current boolean,
  is_reconciled boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period public.fiscal_periods%ROWTYPE;
  v_cash record;
  v_latest public.year_end_manual_cash_reconciliations%ROWTYPE;
  v_invalidation public.year_end_manual_cash_reconciliation_invalidations%ROWTYPE;
  v_snapshot record;
  v_has_bank_feed boolean;
  v_tx_count integer;
  v_unmatched_tx integer;
  v_unmatched_gl integer;
  v_conflicts integer;
  v_bank_total numeric;
  v_gl_movement numeric;
  v_difference numeric;
BEGIN
  SELECT fp.* INTO v_period
  FROM public.fiscal_periods fp
  WHERE fp.id = p_fiscal_period_id
    AND fp.company_id = p_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'YEAR_END_MANUAL_RECONCILIATION_PERIOD_NOT_FOUND'
      USING ERRCODE = '22023';
  END IF;

  FOR v_cash IN
    SELECT
      ca.id,
      ca.ledger_account,
      coalesce(nullif(btrim(ca.name), ''), 'Konto ' || ca.ledger_account) AS name,
      ca.currency,
      ca.bank_connection_id,
      ca.source,
      ca.is_primary
    FROM public.cash_accounts ca
    WHERE ca.company_id = p_company_id
      AND ca.enabled
    UNION ALL
    SELECT
      null::uuid,
      '1930'::text,
      'Företagskonto 1930'::text,
      'SEK'::text,
      null::uuid,
      'manual'::text,
      true
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.cash_accounts ca2
      WHERE ca2.company_id = p_company_id
        AND ca2.enabled
    )
  LOOP
    SELECT count(*)::integer INTO v_tx_count
    FROM public.transactions t
    WHERE t.company_id = p_company_id
      AND t.date BETWEEN v_period.period_start AND v_period.period_end
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

    v_has_bank_feed :=
      v_cash.bank_connection_id IS NOT NULL
      OR v_cash.source = 'enable_banking'
      OR v_tx_count > 0;

    SELECT * INTO v_snapshot
    FROM public.__year_end_cash_ledger_snapshot(
      p_company_id,
      v_cash.ledger_account,
      v_period.period_end
    );

    v_latest := NULL;
    v_invalidation := NULL;
    SELECT r.* INTO v_latest
    FROM public.year_end_manual_cash_reconciliations r
    WHERE r.company_id = p_company_id
      AND r.fiscal_period_id = p_fiscal_period_id
      AND r.ledger_account = v_cash.ledger_account
      AND r.cash_account_id IS NOT DISTINCT FROM v_cash.id
    ORDER BY r.verified_at DESC, r.id DESC
    LIMIT 1;

    IF v_latest.id IS NOT NULL THEN
      SELECT i.* INTO v_invalidation
      FROM public.year_end_manual_cash_reconciliation_invalidations i
      WHERE i.reconciliation_id = v_latest.id;
    END IF;

    IF v_has_bank_feed THEN
      SELECT count(*)::integer INTO v_unmatched_tx
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

      SELECT count(*)::integer INTO v_unmatched_gl
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
            AND (
              (v_cash.id IS NULL AND coalesce(t.currency, 'SEK') = v_cash.currency)
              OR t.cash_account_id = v_cash.id
              OR (
                v_cash.id IS NOT NULL
                AND v_cash.is_primary
                AND t.cash_account_id IS NULL
                AND coalesce(t.currency, 'SEK') = v_cash.currency
              )
            )
        );

      SELECT count(*)::integer INTO v_conflicts
      FROM public.transactions t
      WHERE t.company_id = p_company_id
        AND t.date BETWEEN v_period.period_start AND v_period.period_end
        AND t.journal_entry_id IS NULL
        AND coalesce(t.is_ignored, false) = false
        AND t.automation_status IN ('needs_review', 'failed')
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

      SELECT round(coalesce(sum(t.amount), 0), 2) INTO v_bank_total
      FROM public.transactions t
      LEFT JOIN public.journal_entries linked_je
        ON linked_je.id = t.journal_entry_id
       AND linked_je.company_id = p_company_id
      WHERE t.company_id = p_company_id
        AND t.date BETWEEN v_period.period_start AND v_period.period_end
        AND coalesce(t.is_ignored, false) = false
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
    ELSE
      v_unmatched_tx := 0;
      v_unmatched_gl := 0;
      v_conflicts := 0;
      v_difference := CASE
        WHEN v_latest.id IS NULL THEN NULL
        ELSE round(v_latest.statement_balance - v_snapshot.ledger_balance, 2)
      END;
    END IF;

    cash_account_id := v_cash.id;
    ledger_account := v_cash.ledger_account;
    account_name := v_cash.name;
    currency := v_cash.currency;
    reconciliation_mode := CASE WHEN v_has_bank_feed THEN 'automated' ELSE 'manual' END;
    ledger_balance := v_snapshot.ledger_balance;
    statement_balance := v_latest.statement_balance;
    difference := v_difference;
    unmatched_transaction_count := v_unmatched_tx;
    unmatched_gl_line_count := v_unmatched_gl;
    matching_conflict_count := v_conflicts;
    reconciliation_id := v_latest.id;
    evidence_document_id := v_latest.evidence_document_id;
    evidence_file_name := v_latest.evidence_file_name;
    evidence_sha256 := v_latest.evidence_sha256;
    verified_at := v_latest.verified_at;
    invalidated_at := v_invalidation.invalidated_at;
    invalidation_reason := v_invalidation.reason;
    snapshot_current := v_latest.id IS NOT NULL
      AND v_latest.ledger_snapshot_hash = v_snapshot.snapshot_hash
      AND v_latest.ledger_line_count = v_snapshot.ledger_line_count;
    is_reconciled := CASE
      WHEN v_has_bank_feed THEN
        v_unmatched_tx = 0
        AND v_unmatched_gl = 0
        AND v_conflicts = 0
        AND abs(coalesce(v_difference, 0)) < 0.01
      ELSE
        v_latest.id IS NOT NULL
        AND v_invalidation.id IS NULL
        AND v_latest.balance_date = v_period.period_end
        AND v_latest.ledger_snapshot_hash = v_snapshot.snapshot_hash
        AND v_latest.ledger_line_count = v_snapshot.ledger_line_count
        AND abs(coalesce(v_difference, 0)) < 0.01
    END;
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.year_end_cash_reconciliation_status(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.year_end_cash_reconciliation_status(uuid, uuid)
  TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Automatic invalidation after ledger mutations.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.__invalidate_year_end_manual_cash_for_entry(
  p_entry_id uuid,
  p_ledger_account text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_entry public.journal_entries%ROWTYPE;
BEGIN
  SELECT je.* INTO v_entry
  FROM public.journal_entries je
  WHERE je.id = p_entry_id;

  IF NOT FOUND OR v_entry.status NOT IN ('posted', 'reversed') THEN
    RETURN;
  END IF;

  INSERT INTO public.year_end_manual_cash_reconciliation_invalidations (
    reconciliation_id,
    company_id,
    fiscal_period_id,
    invalidated_by_entry_id,
    reason
  )
  SELECT
    r.id,
    r.company_id,
    r.fiscal_period_id,
    v_entry.id,
    format(
      'Huvudboken på konto %s ändrades efter verifieringen genom verifikation %s.',
      r.ledger_account,
      v_entry.id
    )
  FROM public.year_end_manual_cash_reconciliations r
  WHERE r.company_id = v_entry.company_id
    AND v_entry.entry_date <= r.balance_date
    AND (
      r.ledger_account = p_ledger_account
      OR (
        p_ledger_account IS NULL
        AND EXISTS (
          SELECT 1
          FROM public.journal_entry_lines jel
          WHERE jel.journal_entry_id = v_entry.id
            AND jel.account_number = r.ledger_account
        )
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.year_end_manual_cash_reconciliation_invalidations i
      WHERE i.reconciliation_id = r.id
    )
  ON CONFLICT (reconciliation_id) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.__invalidate_year_end_manual_cash_for_entry(uuid, text)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.invalidate_year_end_manual_cash_from_entry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IN ('posted', 'reversed') THEN
      PERFORM public.__invalidate_year_end_manual_cash_for_entry(NEW.id, NULL);
    END IF;
  ELSIF NEW.status IN ('posted', 'reversed')
        AND OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM public.__invalidate_year_end_manual_cash_for_entry(NEW.id, NULL);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invalidate_year_end_manual_cash_from_entry
  ON public.journal_entries;
CREATE TRIGGER invalidate_year_end_manual_cash_from_entry
  AFTER INSERT OR UPDATE OF status ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.invalidate_year_end_manual_cash_from_entry();

CREATE OR REPLACE FUNCTION public.invalidate_year_end_manual_cash_from_line()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.__invalidate_year_end_manual_cash_for_entry(
      OLD.journal_entry_id,
      OLD.account_number
    );
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
     AND (
       OLD.journal_entry_id IS DISTINCT FROM NEW.journal_entry_id
       OR OLD.account_number IS DISTINCT FROM NEW.account_number
     ) THEN
    PERFORM public.__invalidate_year_end_manual_cash_for_entry(
      OLD.journal_entry_id,
      OLD.account_number
    );
  END IF;

  PERFORM public.__invalidate_year_end_manual_cash_for_entry(
    NEW.journal_entry_id,
    NEW.account_number
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invalidate_year_end_manual_cash_from_line
  ON public.journal_entry_lines;
CREATE TRIGGER invalidate_year_end_manual_cash_from_line
  AFTER INSERT OR UPDATE OR DELETE ON public.journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION public.invalidate_year_end_manual_cash_from_line();

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Replace only the bank/cash branch of the existing canonical blocker
--    function. Every other blocker from the previous function is preserved.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regprocedure('public.__year_end_db_blockers_core_20260728(uuid,uuid)') IS NULL THEN
    EXECUTE
      'ALTER FUNCTION public.year_end_db_blockers(uuid, uuid) '
      'RENAME TO __year_end_db_blockers_core_20260728';
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.__year_end_db_blockers_core_20260728(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.__year_end_db_blockers_core_20260728(uuid, uuid)
  TO service_role;

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
  v_status record;
BEGIN
  -- Preserve all non-cash controls. The four cash controls are recalculated
  -- below per account so a manual account and an automated account can coexist
  -- without either one weakening the other.
  RETURN QUERY
  SELECT core.code, core.message, core.detail_count
  FROM public.__year_end_db_blockers_core_20260728(
    p_company_id,
    p_fiscal_period_id
  ) core
  WHERE core.code NOT IN (
    'bank_unmatched_transactions',
    'bank_unmatched_gl_lines',
    'bank_reconciliation_difference',
    'bank_matching_conflicts'
  );

  FOR v_status IN
    SELECT *
    FROM public.year_end_cash_reconciliation_status(
      p_company_id,
      p_fiscal_period_id
    )
  LOOP
    IF v_status.reconciliation_mode = 'automated' THEN
      IF v_status.unmatched_transaction_count > 0 THEN
        RETURN QUERY SELECT
          'bank_unmatched_transactions'::text,
          format(
            '%s omatchade bankrader finns för konto %s.',
            v_status.unmatched_transaction_count,
            v_status.ledger_account
          ),
          v_status.unmatched_transaction_count;
      END IF;
      IF v_status.unmatched_gl_line_count > 0 THEN
        RETURN QUERY SELECT
          'bank_unmatched_gl_lines'::text,
          format(
            '%s omatchade huvudboksrader finns på konto %s.',
            v_status.unmatched_gl_line_count,
            v_status.ledger_account
          ),
          v_status.unmatched_gl_line_count;
      END IF;
      IF v_status.matching_conflict_count > 0 THEN
        RETURN QUERY SELECT
          'bank_matching_conflicts'::text,
          format(
            '%s bankmatchning(ar) kräver granskning eller har misslyckats för konto %s.',
            v_status.matching_conflict_count,
            v_status.ledger_account
          ),
          v_status.matching_conflict_count;
      END IF;
      IF abs(coalesce(v_status.difference, 0)) >= 0.01 THEN
        RETURN QUERY SELECT
          'bank_reconciliation_difference'::text,
          format(
            'Bankavstämningen för konto %s har differensen %s kr.',
            v_status.ledger_account,
            v_status.difference
          ),
          0;
      END IF;
    ELSIF NOT v_status.is_reconciled THEN
      IF v_status.reconciliation_id IS NULL THEN
        RETURN QUERY SELECT
          'manual_cash_reconciliation_missing'::text,
          format(
            'Konto %s saknar bankkoppling. Ladda upp kontoutdrag och verifiera saldot manuellt per balansdagen.',
            v_status.ledger_account
          ),
          1;
      ELSIF v_status.invalidated_at IS NOT NULL
         OR NOT coalesce(v_status.snapshot_current, false) THEN
        RETURN QUERY SELECT
          'manual_cash_reconciliation_stale'::text,
          format(
            'Den manuella avstämningen för konto %s är ogiltig eftersom huvudboken ändrades. Verifiera saldot igen.',
            v_status.ledger_account
          ),
          1;
      ELSE
        RETURN QUERY SELECT
          'manual_cash_reconciliation_difference'::text,
          format(
            'Den manuella avstämningen för konto %s har differensen %s kr.',
            v_status.ledger_account,
            v_status.difference
          ),
          1;
      END IF;
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.year_end_db_blockers(uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.year_end_db_blockers(uuid, uuid)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
