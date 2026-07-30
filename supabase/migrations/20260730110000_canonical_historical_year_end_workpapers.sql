-- Canonical historical year-end workpapers generated from imported SIE ledgers.
--
-- A missing historical support register is unknown (NULL), never zero. These
-- workpapers document, confirm and reconcile already-posted bookkeeping. They
-- never create journal entries. A real ledger correction must still pass
-- through the bookkeeping engine and its database guard rails.

CREATE TABLE public.year_end_historical_workpapers (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                 uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id                    uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  fiscal_period_id           uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE RESTRICT,
  category                   text NOT NULL CHECK (category IN (
    'customer_receivables',
    'supplier_payables',
    'bank',
    'cash',
    'vat',
    'tax',
    'equity',
    'accruals',
    'fixed_assets',
    'loans',
    'other_receivables',
    'other_liabilities'
  )),
  source_sie_import_id       uuid REFERENCES public.sie_imports(id) ON DELETE RESTRICT,
  imported_amount            numeric(18,2),
  current_amount             numeric(18,2),
  external_amount            numeric(18,2),
  actual_difference          numeric(18,2),
  support_register_available boolean NOT NULL DEFAULT false,
  status                     text NOT NULL CHECK (status IN (
    'automatically_reconciled',
    'imported_from_sie',
    'sie_balance_accepted',
    'external_evidence_verified',
    'manually_adjusted',
    'actual_difference',
    'completion_required',
    'blocking_accounting_error'
  )),
  source_type                text NOT NULL CHECK (source_type IN (
    'system_calculation',
    'sie_ledger',
    'internal_support_register',
    'external_evidence',
    'manual_confirmation',
    'manual_adjustment'
  )),
  source_priority            smallint NOT NULL CHECK (source_priority BETWEEN 0 AND 1000),
  account_numbers            text[] NOT NULL DEFAULT '{}',
  ledger_snapshot_fingerprint text NOT NULL,
  verification_method        text,
  comment                    text,
  metadata                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  pending_sie_import_id      uuid REFERENCES public.sie_imports(id) ON DELETE RESTRICT,
  pending_imported_amount    numeric(18,2),
  conflict_detected_at       timestamptz,
  confirmed_by               uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  confirmed_at               timestamptz,
  created_by                 uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, fiscal_period_id, category),
  CHECK (
    (pending_sie_import_id IS NULL AND pending_imported_amount IS NULL AND conflict_detected_at IS NULL)
    OR
    (pending_sie_import_id IS NOT NULL AND pending_imported_amount IS NOT NULL AND conflict_detected_at IS NOT NULL)
  )
);

CREATE INDEX idx_year_end_historical_workpapers_period
  ON public.year_end_historical_workpapers (company_id, fiscal_period_id, status);
CREATE INDEX idx_year_end_historical_workpapers_import
  ON public.year_end_historical_workpapers (source_sie_import_id)
  WHERE source_sie_import_id IS NOT NULL;

CREATE TABLE public.year_end_historical_workpaper_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  fiscal_period_id      uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE RESTRICT,
  workpaper_id          uuid NOT NULL REFERENCES public.year_end_historical_workpapers(id) ON DELETE RESTRICT,
  event_type            text NOT NULL CHECK (event_type IN (
    'generated',
    'refreshed',
    'accepted',
    'externally_verified',
    'manually_adjusted',
    'difference_detected',
    'reimport_conflict',
    'reimport_resolved'
  )),
  previous_status       text,
  new_status            text NOT NULL,
  previous_amount       numeric(18,2),
  new_amount            numeric(18,2),
  source_sie_import_id  uuid REFERENCES public.sie_imports(id) ON DELETE RESTRICT,
  document_id           uuid REFERENCES public.document_attachments(id) ON DELETE RESTRICT,
  adjustment_kind       text,
  reason                text,
  actor_id              uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- Broaden the explicit BAS defaults. Companies can still add or deactivate
-- mappings; no journal line is rewritten when a mapping changes.
INSERT INTO public.year_end_control_accounts (
  company_id, control_category, account_number
)
SELECT c.id, seed.control_category, seed.account_number
FROM public.companies c
CROSS JOIN (
  VALUES
    ('customer_receivables'::text, '1510'::text),
    ('customer_receivables', '1513'),
    ('customer_receivables', '1518'),
    ('customer_receivables', '1519'),
    ('supplier_payables', '2440'),
    ('supplier_payables', '2448'),
    ('bank_accounts', '1910'),
    ('bank_accounts', '1920'),
    ('bank_accounts', '1930'),
    ('bank_accounts', '1940'),
    ('equity_accounts', '2081'),
    ('equity_accounts', '2085'),
    ('equity_accounts', '2086'),
    ('equity_accounts', '2087'),
    ('equity_accounts', '2091'),
    ('equity_accounts', '2093'),
    ('equity_accounts', '2098'),
    ('equity_accounts', '2099'),
    ('tax_accounts', '2510'),
    ('tax_accounts', '2512'),
    ('tax_accounts', '2514'),
    ('tax_accounts', '2518'),
    ('vat_accounts', '2610'),
    ('vat_accounts', '2611'),
    ('vat_accounts', '2620'),
    ('vat_accounts', '2621'),
    ('vat_accounts', '2630'),
    ('vat_accounts', '2631'),
    ('vat_accounts', '2640'),
    ('vat_accounts', '2641'),
    ('vat_accounts', '2645'),
    ('vat_accounts', '2650')
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
  )
  SELECT NEW.id, seed.control_category, seed.account_number
  FROM (
    VALUES
      ('customer_receivables'::text, '1510'::text),
      ('customer_receivables', '1513'),
      ('customer_receivables', '1518'),
      ('customer_receivables', '1519'),
      ('supplier_payables', '2440'),
      ('supplier_payables', '2448'),
      ('bank_accounts', '1910'),
      ('bank_accounts', '1920'),
      ('bank_accounts', '1930'),
      ('bank_accounts', '1940'),
      ('equity_accounts', '2081'),
      ('equity_accounts', '2085'),
      ('equity_accounts', '2086'),
      ('equity_accounts', '2087'),
      ('equity_accounts', '2091'),
      ('equity_accounts', '2093'),
      ('equity_accounts', '2098'),
      ('equity_accounts', '2099'),
      ('tax_accounts', '2510'),
      ('tax_accounts', '2512'),
      ('tax_accounts', '2514'),
      ('tax_accounts', '2518'),
      ('vat_accounts', '2610'),
      ('vat_accounts', '2611'),
      ('vat_accounts', '2620'),
      ('vat_accounts', '2621'),
      ('vat_accounts', '2630'),
      ('vat_accounts', '2631'),
      ('vat_accounts', '2640'),
      ('vat_accounts', '2641'),
      ('vat_accounts', '2645'),
      ('vat_accounts', '2650')
  ) AS seed(control_category, account_number)
  ON CONFLICT (company_id, control_category, account_number) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE INDEX idx_year_end_historical_workpaper_events_workpaper
  ON public.year_end_historical_workpaper_events (workpaper_id, created_at DESC);

ALTER TABLE public.year_end_historical_workpapers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.year_end_historical_workpaper_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY year_end_historical_workpapers_select
  ON public.year_end_historical_workpapers
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.resolve_company_access(company_id) access
      WHERE access.can_read
    )
  );

CREATE POLICY year_end_historical_workpaper_events_select
  ON public.year_end_historical_workpaper_events
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.resolve_company_access(company_id) access
      WHERE access.can_read
    )
  );

GRANT SELECT ON public.year_end_historical_workpapers TO authenticated;
GRANT SELECT ON public.year_end_historical_workpaper_events TO authenticated;

CREATE TRIGGER set_updated_at_year_end_historical_workpapers
  BEFORE UPDATE ON public.year_end_historical_workpapers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_year_end_historical_workpapers
  AFTER INSERT OR UPDATE OR DELETE ON public.year_end_historical_workpapers
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

CREATE TRIGGER audit_year_end_historical_workpaper_events
  AFTER INSERT ON public.year_end_historical_workpaper_events
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

CREATE OR REPLACE FUNCTION public.year_end_workpaper_event_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'YEAR_END_WORKPAPER_EVENT_APPEND_ONLY'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER year_end_historical_workpaper_events_immutable
  BEFORE UPDATE OR DELETE ON public.year_end_historical_workpaper_events
  FOR EACH ROW EXECUTE FUNCTION public.year_end_workpaper_event_immutable();

CREATE OR REPLACE FUNCTION public.__year_end_workpaper_category_snapshot(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_category text
) RETURNS TABLE (
  ledger_amount numeric,
  account_numbers text[],
  account_breakdown jsonb,
  snapshot_fingerprint text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH period AS (
    SELECT fp.period_end
    FROM public.fiscal_periods fp
    WHERE fp.id = p_fiscal_period_id
      AND fp.company_id = p_company_id
  ),
  mapped_accounts AS (
    SELECT yeca.account_number
    FROM public.year_end_control_accounts yeca
    WHERE yeca.company_id = p_company_id
      AND yeca.active
      AND yeca.control_category = CASE p_category
        WHEN 'customer_receivables' THEN 'customer_receivables'
        WHEN 'supplier_payables' THEN 'supplier_payables'
        WHEN 'bank' THEN 'bank_accounts'
        WHEN 'cash' THEN 'bank_accounts'
        WHEN 'equity' THEN 'equity_accounts'
        WHEN 'tax' THEN 'tax_accounts'
        WHEN 'vat' THEN 'vat_accounts'
        ELSE '__range_based__'
      END
      AND (
        p_category <> 'cash'
        OR yeca.account_number LIKE '19%'
      )
  ),
  ledger_rows AS (
    SELECT
      jel.account_number,
      round(sum(
        CASE
          WHEN p_category IN (
            'supplier_payables', 'equity', 'tax', 'vat', 'loans', 'other_liabilities'
          ) THEN jel.credit_amount - jel.debit_amount
          WHEN p_category = 'accruals' AND jel.account_number LIKE '2%'
            THEN jel.credit_amount - jel.debit_amount
          ELSE jel.debit_amount - jel.credit_amount
        END
      ), 2) AS amount
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    CROSS JOIN period p
    WHERE je.company_id = p_company_id
      AND je.entry_date <= p.period_end
      AND je.status IN ('posted', 'reversed')
      AND (
        jel.account_number IN (SELECT ma.account_number FROM mapped_accounts ma)
        OR (p_category = 'fixed_assets' AND jel.account_number BETWEEN '1000' AND '1399')
        OR (p_category = 'accruals' AND (
          jel.account_number BETWEEN '1700' AND '1799'
          OR jel.account_number BETWEEN '2900' AND '2999'
        ))
        OR (p_category = 'loans' AND jel.account_number BETWEEN '2300' AND '2399')
        OR (p_category = 'other_receivables' AND jel.account_number BETWEEN '1600' AND '1699')
        OR (p_category = 'other_liabilities' AND jel.account_number BETWEEN '2400' AND '2899'
          AND NOT EXISTS (
            SELECT 1
            FROM public.year_end_control_accounts excluded
            WHERE excluded.company_id = p_company_id
              AND excluded.active
              AND excluded.account_number = jel.account_number
          )
        )
      )
    GROUP BY jel.account_number
  ),
  aggregated AS (
    SELECT
      round(coalesce(sum(lr.amount), 0), 2) AS total,
      coalesce(array_agg(lr.account_number ORDER BY lr.account_number), '{}') AS accounts,
      coalesce(
        jsonb_agg(
          jsonb_build_object('account_number', lr.account_number, 'amount', lr.amount)
          ORDER BY lr.account_number
        ),
        '[]'::jsonb
      ) AS breakdown,
      coalesce(
        string_agg(lr.account_number || ':' || lr.amount::text, '|' ORDER BY lr.account_number),
        'empty'
      ) AS fingerprint_input
    FROM ledger_rows lr
  )
  SELECT
    a.total,
    a.accounts,
    a.breakdown,
    md5(concat_ws('|', p_company_id::text, p_fiscal_period_id::text, p_category, a.fingerprint_input))
  FROM aggregated a;
$$;

REVOKE ALL ON FUNCTION public.__year_end_workpaper_category_snapshot(uuid, uuid, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.__year_end_workpaper_category_snapshot(uuid, uuid, text)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.refresh_year_end_historical_workpapers(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_source_sie_import_id uuid DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text := coalesce(auth.role(), current_user::text);
  v_period public.fiscal_periods%ROWTYPE;
  v_import public.sie_imports%ROWTYPE;
  v_category text;
  v_snapshot record;
  v_control record;
  v_existing public.year_end_historical_workpapers%ROWTYPE;
  v_new_status text;
  v_workpaper_id uuid;
  v_count integer := 0;
BEGIN
  IF v_role NOT IN ('service_role', 'postgres')
     AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'YEAR_END_WORKPAPER_REFRESH_SERVICE_ONLY'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat_ws(':', 'year-end-workpapers', p_company_id, p_fiscal_period_id),
    0
  ));

  SELECT fp.* INTO v_period
  FROM public.fiscal_periods fp
  WHERE fp.id = p_fiscal_period_id
    AND fp.company_id = p_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'YEAR_END_WORKPAPER_PERIOD_NOT_FOUND'
      USING ERRCODE = '22023';
  END IF;

  SELECT si.* INTO v_import
  FROM public.sie_imports si
  WHERE si.company_id = p_company_id
    AND si.status = 'completed'
    AND (p_source_sie_import_id IS NULL OR si.id = p_source_sie_import_id)
    AND (
      si.fiscal_period_id = p_fiscal_period_id
      OR daterange(si.fiscal_year_start, si.fiscal_year_end, '[]')
        && daterange(v_period.period_start, v_period.period_end, '[]')
    )
  ORDER BY si.imported_at DESC NULLS LAST, si.created_at DESC
  LIMIT 1;
  IF v_import.id IS NULL THEN
    RETURN 0;
  END IF;

  FOREACH v_category IN ARRAY ARRAY[
    'customer_receivables',
    'supplier_payables',
    'bank',
    'vat',
    'tax',
    'equity',
    'accruals',
    'fixed_assets',
    'loans',
    'other_receivables',
    'other_liabilities'
  ]
  LOOP
    SELECT * INTO v_snapshot
    FROM public.__year_end_workpaper_category_snapshot(
      p_company_id, p_fiscal_period_id, v_category
    );
    v_new_status := CASE
      WHEN abs(coalesce(v_snapshot.ledger_amount, 0)) < 0.01
        THEN 'automatically_reconciled'
      ELSE 'imported_from_sie'
    END;

    SELECT wp.* INTO v_existing
    FROM public.year_end_historical_workpapers wp
    WHERE wp.company_id = p_company_id
      AND wp.fiscal_period_id = p_fiscal_period_id
      AND wp.category = v_category
    FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO public.year_end_historical_workpapers (
        company_id, user_id, fiscal_period_id, category, source_sie_import_id,
        imported_amount, current_amount, actual_difference,
        support_register_available, status, source_type, source_priority,
        account_numbers, ledger_snapshot_fingerprint, metadata,
        created_by
      ) VALUES (
        p_company_id, v_import.user_id, p_fiscal_period_id, v_category, v_import.id,
        v_snapshot.ledger_amount,
        v_snapshot.ledger_amount,
        CASE WHEN v_new_status = 'automatically_reconciled' THEN 0 ELSE NULL END,
        false, v_new_status, 'sie_ledger', 200,
        v_snapshot.account_numbers, v_snapshot.snapshot_fingerprint,
        jsonb_build_object('account_breakdown', v_snapshot.account_breakdown),
        v_import.user_id
      )
      RETURNING id INTO v_workpaper_id;

      INSERT INTO public.year_end_historical_workpaper_events (
        company_id, user_id, fiscal_period_id, workpaper_id, event_type,
        new_status, new_amount, source_sie_import_id, actor_id,
        reason
      ) VALUES (
        p_company_id, v_import.user_id, p_fiscal_period_id, v_workpaper_id, 'generated',
        v_new_status, v_snapshot.ledger_amount, v_import.id, v_import.user_id,
        'Bokslutsunderlag skapades automatiskt från importerad SIE-huvudbok.'
      );
      v_count := v_count + 1;
    ELSIF v_existing.source_priority > 200
       OR v_existing.status IN (
         'sie_balance_accepted',
         'external_evidence_verified',
         'manually_adjusted',
         'actual_difference'
       ) THEN
      IF v_existing.source_sie_import_id IS DISTINCT FROM v_import.id
         AND v_existing.imported_amount IS DISTINCT FROM v_snapshot.ledger_amount THEN
        UPDATE public.year_end_historical_workpapers
        SET pending_sie_import_id = v_import.id,
            pending_imported_amount = v_snapshot.ledger_amount,
            conflict_detected_at = now(),
            account_numbers = v_snapshot.account_numbers,
            ledger_snapshot_fingerprint = v_snapshot.snapshot_fingerprint,
            metadata = metadata || jsonb_build_object(
              'pending_account_breakdown', v_snapshot.account_breakdown
            )
        WHERE id = v_existing.id;

        INSERT INTO public.year_end_historical_workpaper_events (
          company_id, user_id, fiscal_period_id, workpaper_id, event_type,
          previous_status, new_status, previous_amount, new_amount,
          source_sie_import_id, actor_id, reason
        ) VALUES (
          p_company_id, v_import.user_id, p_fiscal_period_id, v_existing.id, 'reimport_conflict',
          v_existing.status, v_existing.status, v_existing.current_amount,
          v_snapshot.ledger_amount, v_import.id, v_import.user_id,
          'En ny SIE-import avviker från tidigare bekräftat eller manuellt underlag.'
        );
      END IF;
    ELSE
      UPDATE public.year_end_historical_workpapers
      SET source_sie_import_id = v_import.id,
          imported_amount = v_snapshot.ledger_amount,
          current_amount = v_snapshot.ledger_amount,
          actual_difference = CASE
            WHEN v_new_status = 'automatically_reconciled' THEN 0
            ELSE NULL
          END,
          status = v_new_status,
          source_type = 'sie_ledger',
          source_priority = 200,
          account_numbers = v_snapshot.account_numbers,
          ledger_snapshot_fingerprint = v_snapshot.snapshot_fingerprint,
          metadata = jsonb_build_object('account_breakdown', v_snapshot.account_breakdown),
          pending_sie_import_id = NULL,
          pending_imported_amount = NULL,
          conflict_detected_at = NULL
      WHERE id = v_existing.id;

      INSERT INTO public.year_end_historical_workpaper_events (
        company_id, user_id, fiscal_period_id, workpaper_id, event_type,
        previous_status, new_status, previous_amount, new_amount,
        source_sie_import_id, actor_id, reason
      ) VALUES (
        p_company_id, v_import.user_id, p_fiscal_period_id, v_existing.id, 'refreshed',
        v_existing.status, v_new_status, v_existing.current_amount,
        v_snapshot.ledger_amount, v_import.id, v_import.user_id,
        'Bokslutsunderlag uppdaterades från den senaste SIE-huvudboken.'
      );
      v_count := v_count + 1;
    END IF;

    -- A verified support register outranks the imported SIE workpaper. Keep
    -- the SIE import as provenance, but expose the strongest available source
    -- in the canonical workpaper instead of asking the user to confirm twice.
    SELECT core.* INTO v_control
    FROM public.__year_end_control_status_workpaper_core_20260730(
      p_company_id, p_fiscal_period_id
    ) core
    WHERE core.control_category = v_category
      AND core.status = 'reconciled'
      AND core.evidence_count > 0
    ORDER BY core.control_code
    LIMIT 1;

    IF FOUND THEN
      SELECT wp.* INTO v_existing
      FROM public.year_end_historical_workpapers wp
      WHERE wp.company_id = p_company_id
        AND wp.fiscal_period_id = p_fiscal_period_id
        AND wp.category = v_category
      FOR UPDATE;

      IF v_existing.status IS DISTINCT FROM (
           CASE
             WHEN v_control.source_type LIKE 'itemized_%'
               THEN 'automatically_reconciled'
             ELSE 'external_evidence_verified'
           END
         )
         OR v_existing.current_amount IS DISTINCT FROM v_control.supporting_register_amount
         OR v_existing.verification_method IS DISTINCT FROM v_control.verification_method THEN
        UPDATE public.year_end_historical_workpapers
        SET current_amount = v_control.supporting_register_amount,
            external_amount = CASE
              WHEN v_control.source_type LIKE 'itemized_%' THEN NULL
              ELSE v_control.supporting_register_amount
            END,
            actual_difference = v_control.difference,
            support_register_available = true,
            status = CASE
              WHEN v_control.source_type LIKE 'itemized_%'
                THEN 'automatically_reconciled'
              ELSE 'external_evidence_verified'
            END,
            source_type = CASE
              WHEN v_control.source_type LIKE 'itemized_%'
                THEN 'internal_support_register'
              ELSE 'external_evidence'
            END,
            source_priority = CASE
              WHEN v_control.source_type LIKE 'itemized_%' THEN 300
              ELSE 400
            END,
            verification_method = v_control.verification_method,
            metadata = metadata || jsonb_build_object(
              'strongest_source_type', v_control.source_type,
              'evidence_count', v_control.evidence_count
            ),
            pending_sie_import_id = NULL,
            pending_imported_amount = NULL,
            conflict_detected_at = NULL
        WHERE id = v_existing.id;

        INSERT INTO public.year_end_historical_workpaper_events (
          company_id, user_id, fiscal_period_id, workpaper_id, event_type,
          previous_status, new_status, previous_amount, new_amount,
          source_sie_import_id, actor_id, reason
        ) VALUES (
          p_company_id, v_import.user_id, p_fiscal_period_id, v_existing.id,
          CASE
            WHEN v_control.source_type LIKE 'itemized_%' THEN 'refreshed'
            ELSE 'externally_verified'
          END,
          v_existing.status,
          CASE
            WHEN v_control.source_type LIKE 'itemized_%'
              THEN 'automatically_reconciled'
            ELSE 'external_evidence_verified'
          END,
          v_existing.current_amount, v_control.supporting_register_amount,
          v_import.id, v_import.user_id,
          'Ett verifierat stödregister med högre källprioritet ersatte SIE som aktiv avstämningskälla.'
        );
      END IF;
    END IF;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_year_end_historical_workpapers(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_year_end_historical_workpapers(uuid, uuid, uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.accept_year_end_historical_workpapers(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_user_id uuid,
  p_workpaper_ids uuid[],
  p_comment text,
  p_reimport_choice text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text := coalesce(auth.role(), current_user::text);
  v_period public.fiscal_periods%ROWTYPE;
  v_workpaper public.year_end_historical_workpapers%ROWTYPE;
  v_snapshot record;
  v_target_import_id uuid;
  v_target_amount numeric;
  v_accepted uuid[] := '{}';
BEGIN
  IF v_role NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'YEAR_END_WORKPAPER_ACCEPT_SERVICE_ONLY'
      USING ERRCODE = '42501';
  END IF;
  IF coalesce(array_length(p_workpaper_ids, 1), 0) = 0
     OR length(btrim(coalesce(p_comment, ''))) < 3
     OR (p_reimport_choice IS NOT NULL AND p_reimport_choice NOT IN ('keep', 'replace')) THEN
    RAISE EXCEPTION 'YEAR_END_WORKPAPER_ACCEPT_INVALID_ARGUMENT'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat_ws(':', 'year-end-workpapers', p_company_id, p_fiscal_period_id),
    0
  ));
  SELECT fp.* INTO v_period
  FROM public.fiscal_periods fp
  WHERE fp.id = p_fiscal_period_id
    AND fp.company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND OR v_period.is_closed OR v_period.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'YEAR_END_WORKPAPER_PERIOD_NOT_OPEN'
      USING ERRCODE = '55000';
  END IF;

  FOR v_workpaper IN
    SELECT wp.*
    FROM public.year_end_historical_workpapers wp
    WHERE wp.company_id = p_company_id
      AND wp.fiscal_period_id = p_fiscal_period_id
      AND wp.id = ANY(p_workpaper_ids)
    FOR UPDATE
  LOOP
    IF v_workpaper.pending_sie_import_id IS NOT NULL AND p_reimport_choice IS NULL THEN
      RAISE EXCEPTION 'YEAR_END_WORKPAPER_REIMPORT_CHOICE_REQUIRED'
        USING ERRCODE = '40001';
    END IF;

    SELECT * INTO v_snapshot
    FROM public.__year_end_workpaper_category_snapshot(
      p_company_id, p_fiscal_period_id, v_workpaper.category
    );

    v_target_import_id := CASE
      WHEN p_reimport_choice = 'replace' THEN v_workpaper.pending_sie_import_id
      ELSE v_workpaper.source_sie_import_id
    END;
    v_target_amount := CASE
      WHEN p_reimport_choice = 'replace' THEN v_workpaper.pending_imported_amount
      ELSE v_workpaper.current_amount
    END;

    IF p_reimport_choice IS NULL THEN
      v_target_amount := v_snapshot.ledger_amount;
      v_target_import_id := v_workpaper.source_sie_import_id;
    END IF;

    UPDATE public.year_end_historical_workpapers
    SET source_sie_import_id = coalesce(v_target_import_id, source_sie_import_id),
        imported_amount = CASE
          WHEN p_reimport_choice = 'replace' THEN v_target_amount
          ELSE imported_amount
        END,
        current_amount = v_target_amount,
        actual_difference = round(v_target_amount - v_snapshot.ledger_amount, 2),
        status = CASE
          WHEN abs(round(v_target_amount - v_snapshot.ledger_amount, 2)) < 0.01
            THEN 'sie_balance_accepted'
          ELSE 'actual_difference'
        END,
        source_type = CASE
          WHEN p_reimport_choice = 'keep' THEN 'manual_confirmation'
          ELSE 'manual_confirmation'
        END,
        source_priority = 250,
        verification_method = 'user_confirmation',
        comment = p_comment,
        confirmed_by = p_user_id,
        confirmed_at = now(),
        account_numbers = v_snapshot.account_numbers,
        ledger_snapshot_fingerprint = v_snapshot.snapshot_fingerprint,
        metadata = metadata || jsonb_build_object(
          'account_breakdown', v_snapshot.account_breakdown
        ),
        pending_sie_import_id = NULL,
        pending_imported_amount = NULL,
        conflict_detected_at = NULL
    WHERE id = v_workpaper.id;

    INSERT INTO public.year_end_historical_workpaper_events (
      company_id, user_id, fiscal_period_id, workpaper_id, event_type,
      previous_status, new_status, previous_amount, new_amount,
      source_sie_import_id, adjustment_kind, reason, actor_id
    ) VALUES (
      p_company_id, p_user_id, p_fiscal_period_id, v_workpaper.id,
      CASE WHEN p_reimport_choice IS NULL THEN 'accepted' ELSE 'reimport_resolved' END,
      v_workpaper.status,
      CASE
        WHEN abs(round(v_target_amount - v_snapshot.ledger_amount, 2)) < 0.01
          THEN 'sie_balance_accepted'
        ELSE 'actual_difference'
      END,
      v_workpaper.current_amount, v_target_amount, v_target_import_id,
      p_reimport_choice, p_comment, p_user_id
    );
    v_accepted := array_append(v_accepted, v_workpaper.id);
  END LOOP;

  IF coalesce(array_length(v_accepted, 1), 0) <> array_length(p_workpaper_ids, 1) THEN
    RAISE EXCEPTION 'YEAR_END_WORKPAPER_NOT_FOUND_OR_WRONG_TENANT'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.audit_log (
    user_id, company_id, action, table_name, actor_id,
    new_state, description
  ) VALUES (
    p_user_id, p_company_id, 'SECURITY_EVENT',
    'year_end_historical_workpapers', p_user_id,
    jsonb_build_object(
      'fiscal_period_id', p_fiscal_period_id,
      'workpaper_ids', to_jsonb(v_accepted),
      'reimport_choice', p_reimport_choice,
      'journal_entry_created', false
    ),
    'Historiska SIE-saldon bekräftades som bokslutsunderlag utan ny bokföring.'
  );

  RETURN jsonb_build_object(
    'accepted_ids', to_jsonb(v_accepted),
    'journal_entry_created', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.accept_year_end_historical_workpapers(
  uuid, uuid, uuid, uuid[], text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_year_end_historical_workpapers(
  uuid, uuid, uuid, uuid[], text, text
) TO service_role;

CREATE OR REPLACE FUNCTION public.adjust_year_end_historical_workpaper(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_user_id uuid,
  p_workpaper_id uuid,
  p_amount numeric,
  p_adjustment_kind text,
  p_comment text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text := coalesce(auth.role(), current_user::text);
  v_workpaper public.year_end_historical_workpapers%ROWTYPE;
  v_period public.fiscal_periods%ROWTYPE;
  v_snapshot record;
  v_difference numeric;
  v_status text;
BEGIN
  IF v_role NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'YEAR_END_WORKPAPER_ADJUST_SERVICE_ONLY'
      USING ERRCODE = '42501';
  END IF;
  IF p_adjustment_kind NOT IN (
    'verification_only',
    'support_register_completion',
    'annual_report_reclassification',
    'comment'
  ) OR length(btrim(coalesce(p_comment, ''))) < 3 THEN
    IF p_adjustment_kind = 'accounting_correction' THEN
      RAISE EXCEPTION 'YEAR_END_WORKPAPER_ACCOUNTING_CORRECTION_REQUIRES_JOURNAL'
        USING ERRCODE = '23514';
    END IF;
    RAISE EXCEPTION 'YEAR_END_WORKPAPER_ADJUST_INVALID_ARGUMENT'
      USING ERRCODE = '22023';
  END IF;

  SELECT fp.* INTO v_period
  FROM public.fiscal_periods fp
  WHERE fp.id = p_fiscal_period_id
    AND fp.company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND OR v_period.is_closed OR v_period.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'YEAR_END_WORKPAPER_PERIOD_NOT_OPEN'
      USING ERRCODE = '55000';
  END IF;

  SELECT wp.* INTO v_workpaper
  FROM public.year_end_historical_workpapers wp
  WHERE wp.id = p_workpaper_id
    AND wp.company_id = p_company_id
    AND wp.fiscal_period_id = p_fiscal_period_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'YEAR_END_WORKPAPER_NOT_FOUND'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_snapshot
  FROM public.__year_end_workpaper_category_snapshot(
    p_company_id, p_fiscal_period_id, v_workpaper.category
  );
  v_difference := round(p_amount - v_snapshot.ledger_amount, 2);
  v_status := CASE
    WHEN abs(v_difference) < 0.01 THEN 'manually_adjusted'
    ELSE 'actual_difference'
  END;

  UPDATE public.year_end_historical_workpapers
  SET current_amount = round(p_amount, 2),
      actual_difference = v_difference,
      status = v_status,
      source_type = 'manual_adjustment',
      source_priority = 500,
      verification_method = p_adjustment_kind,
      comment = p_comment,
      confirmed_by = p_user_id,
      confirmed_at = now(),
      account_numbers = v_snapshot.account_numbers,
      ledger_snapshot_fingerprint = v_snapshot.snapshot_fingerprint,
      metadata = metadata || jsonb_build_object(
        'account_breakdown', v_snapshot.account_breakdown
      ),
      pending_sie_import_id = NULL,
      pending_imported_amount = NULL,
      conflict_detected_at = NULL
  WHERE id = v_workpaper.id;

  INSERT INTO public.year_end_historical_workpaper_events (
    company_id, user_id, fiscal_period_id, workpaper_id, event_type,
    previous_status, new_status, previous_amount, new_amount,
    source_sie_import_id, adjustment_kind, reason, actor_id
  ) VALUES (
    p_company_id, p_user_id, p_fiscal_period_id, v_workpaper.id,
    CASE WHEN abs(v_difference) < 0.01 THEN 'manually_adjusted' ELSE 'difference_detected' END,
    v_workpaper.status, v_status, v_workpaper.current_amount, round(p_amount, 2),
    v_workpaper.source_sie_import_id, p_adjustment_kind, p_comment, p_user_id
  );

  RETURN jsonb_build_object(
    'id', v_workpaper.id,
    'status', v_status,
    'ledger_amount', v_snapshot.ledger_amount,
    'current_amount', round(p_amount, 2),
    'difference', v_difference,
    'journal_entry_created', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.adjust_year_end_historical_workpaper(
  uuid, uuid, uuid, uuid, numeric, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.adjust_year_end_historical_workpaper(
  uuid, uuid, uuid, uuid, numeric, text, text
) TO service_role;

CREATE OR REPLACE FUNCTION public.year_end_profit_disposition_proposal(
  p_company_id uuid,
  p_fiscal_period_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period_end date;
  v_current_result numeric;
  v_prior_free_equity numeric;
  v_available numeric;
BEGIN
  SELECT fp.period_end INTO v_period_end
  FROM public.fiscal_periods fp
  WHERE fp.id = p_fiscal_period_id
    AND fp.company_id = p_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'YEAR_END_PROFIT_PROPOSAL_PERIOD_NOT_FOUND'
      USING ERRCODE = '22023';
  END IF;

  SELECT round(coalesce(sum(jel.credit_amount - jel.debit_amount), 0), 2)
  INTO v_current_result
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  WHERE je.company_id = p_company_id
    AND je.entry_date <= v_period_end
    AND je.status IN ('posted', 'reversed')
    AND jel.account_number BETWEEN '3000' AND '8999';

  SELECT round(coalesce(sum(jel.credit_amount - jel.debit_amount), 0), 2)
  INTO v_prior_free_equity
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  WHERE je.company_id = p_company_id
    AND je.entry_date <= v_period_end
    AND je.status IN ('posted', 'reversed')
    AND jel.account_number IN ('2091', '2098');

  v_available := round(v_prior_free_equity + v_current_result, 2);
  RETURN jsonb_build_object(
    'current_year_result', v_current_result,
    'free_equity', greatest(v_available, 0),
    'proposed_dividend', 0,
    'carried_forward', greatest(v_available, 0),
    'proposal_text', format(
      'Styrelsen föreslår att %s kr balanseras i ny räkning.',
      to_char(greatest(v_available, 0), 'FM999G999G999G990D00')
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.year_end_profit_disposition_proposal(uuid, uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.year_end_profit_disposition_proposal(uuid, uuid)
  TO authenticated, service_role;

-- Preserve the previous comprehensive control implementation and layer the
-- workpaper semantics over it. The atomic close still calls
-- year_end_db_blockers(), which reads this same function inside its transaction.
DO $$
BEGIN
  IF to_regprocedure(
    'public.__year_end_control_status_workpaper_core_20260730(uuid,uuid)'
  ) IS NULL THEN
    ALTER FUNCTION public.year_end_control_status(uuid, uuid)
      RENAME TO __year_end_control_status_workpaper_core_20260730;
  END IF;
END
$$;

REVOKE ALL ON FUNCTION
  public.__year_end_control_status_workpaper_core_20260730(uuid, uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  public.__year_end_control_status_workpaper_core_20260730(uuid, uuid)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.year_end_control_status(
  p_company_id uuid,
  p_fiscal_period_id uuid
) RETURNS TABLE (
  control_code text,
  control_category text,
  status text,
  ledger_amount numeric,
  supporting_register_amount numeric,
  difference numeric,
  source_type text,
  verification_method text,
  evidence_count integer,
  is_stale boolean,
  is_blocking boolean,
  message text,
  available_actions jsonb,
  metadata jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    core.control_code,
    core.control_category,
    CASE
      WHEN wp.id IS NULL THEN core.status
      WHEN wp.status = 'imported_from_sie'
        AND core.status IN ('completion_required', 'manual_verification_required')
        THEN 'imported_from_sie'
      WHEN wp.status IN (
        'automatically_reconciled',
        'sie_balance_accepted',
        'external_evidence_verified',
        'manually_adjusted'
      ) AND abs(coalesce(wp.current_amount, 0) - coalesce(core.ledger_amount, 0)) < 0.01
        THEN wp.status
      WHEN wp.status IN ('actual_difference', 'blocking_accounting_error')
        OR abs(coalesce(wp.current_amount, 0) - coalesce(core.ledger_amount, 0)) >= 0.01
        THEN 'actual_difference'
      ELSE core.status
    END AS status,
    core.ledger_amount,
    CASE
      WHEN wp.status = 'imported_from_sie' AND core.status = 'reconciled'
        THEN core.supporting_register_amount
      WHEN wp.status = 'imported_from_sie'
        AND core.status IN ('completion_required', 'manual_verification_required')
        THEN NULL
      WHEN wp.id IS NOT NULL THEN wp.current_amount
      ELSE core.supporting_register_amount
    END AS supporting_register_amount,
    CASE
      WHEN wp.status = 'imported_from_sie' AND core.status = 'reconciled'
        THEN core.difference
      WHEN wp.status = 'imported_from_sie'
        AND core.status IN ('completion_required', 'manual_verification_required')
        THEN NULL
      WHEN wp.id IS NOT NULL
        THEN round(wp.current_amount - core.ledger_amount, 2)
      ELSE core.difference
    END AS difference,
    CASE
      WHEN wp.status = 'imported_from_sie' AND core.status = 'reconciled'
        THEN core.source_type
      ELSE coalesce(wp.source_type, core.source_type)
    END AS source_type,
    CASE
      WHEN wp.status = 'imported_from_sie' AND core.status = 'reconciled'
        THEN core.verification_method
      ELSE coalesce(wp.verification_method, core.verification_method)
    END AS verification_method,
    core.evidence_count,
    core.is_stale OR wp.pending_sie_import_id IS NOT NULL AS is_stale,
    CASE
      WHEN wp.id IS NULL THEN core.is_blocking
      WHEN wp.status = 'imported_from_sie'
        AND core.status IN ('completion_required', 'manual_verification_required')
        THEN true
      WHEN wp.status IN ('actual_difference', 'blocking_accounting_error')
        OR abs(coalesce(wp.current_amount, 0) - coalesce(core.ledger_amount, 0)) >= 0.01
        OR wp.pending_sie_import_id IS NOT NULL
        THEN true
      WHEN wp.status IN (
        'automatically_reconciled',
        'sie_balance_accepted',
        'external_evidence_verified',
        'manually_adjusted'
      ) THEN false
      ELSE core.is_blocking
    END AS is_blocking,
    CASE
      WHEN wp.pending_sie_import_id IS NOT NULL
        THEN 'En ny SIE-import avviker från tidigare godkänt underlag. Välj vilket värde som ska gälla.'
      WHEN wp.status = 'imported_from_sie'
        AND core.status IN ('completion_required', 'manual_verification_required')
        THEN format(
          '%s enligt importerad SIE: %s kr. Historiskt detaljregister saknas i Nordklart; bekräfta saldot eller verifiera ett externt underlag.',
          CASE core.control_category
            WHEN 'customer_receivables' THEN 'Kundfordringar'
            WHEN 'supplier_payables' THEN 'Leverantörsskulder'
            WHEN 'equity' THEN 'Eget kapital'
            WHEN 'tax' THEN 'Skatt'
            WHEN 'vat' THEN 'Moms'
            ELSE core.control_category
          END,
          to_char(coalesce(core.ledger_amount, 0), 'FM999G999G999G990D00')
        )
      WHEN wp.status = 'sie_balance_accepted'
        THEN 'Det importerade SIE-saldot är bekräftat som historiskt bokslutsunderlag. Ingen ny verifikation har skapats.'
      WHEN wp.status = 'automatically_reconciled'
        THEN 'Kontrollen är automatiskt avstämd från huvudboken.'
      WHEN wp.status = 'manually_adjusted'
        THEN 'Bokslutsunderlaget är manuellt kompletterat utan att huvudboken skrivits om.'
      WHEN wp.status = 'actual_difference'
        THEN 'Två faktiska värden skiljer sig. Förklara differensen eller skapa en korrigeringsverifikation om huvudboken är fel.'
      ELSE core.message
    END AS message,
    CASE
      WHEN wp.status = 'imported_from_sie'
        AND core.status IN ('completion_required', 'manual_verification_required')
        THEN jsonb_build_array(
          'accept_sie_balance',
          'verify_external_evidence',
          'adjust_workpaper'
        )
      WHEN wp.pending_sie_import_id IS NOT NULL
        THEN jsonb_build_array('resolve_reimport_conflict')
      ELSE core.available_actions
    END AS available_actions,
    core.metadata || CASE
      WHEN wp.id IS NULL THEN '{}'::jsonb
      ELSE jsonb_build_object(
        'workpaper_id', wp.id,
        'workpaper_status', wp.status,
        'source_sie_import_id', wp.source_sie_import_id,
        'account_numbers', to_jsonb(wp.account_numbers),
        'support_register_available', wp.support_register_available,
        'pending_sie_import_id', wp.pending_sie_import_id,
        'pending_imported_amount', wp.pending_imported_amount,
        'requires_confirmation', wp.status = 'imported_from_sie',
        'requires_accounting_correction', wp.status IN (
          'actual_difference', 'blocking_accounting_error'
        )
      )
    END AS metadata
  FROM public.__year_end_control_status_workpaper_core_20260730(
    p_company_id, p_fiscal_period_id
  ) core
  LEFT JOIN public.year_end_historical_workpapers wp
    ON wp.company_id = p_company_id
   AND wp.fiscal_period_id = p_fiscal_period_id
   AND wp.category = CASE core.control_category
     WHEN 'customer_receivables' THEN 'customer_receivables'
     WHEN 'supplier_payables' THEN 'supplier_payables'
     WHEN 'equity' THEN 'equity'
     WHEN 'tax' THEN 'tax'
     WHEN 'vat' THEN 'vat'
     ELSE '__not_a_workpaper_control__'
   END;
$$;

REVOKE ALL ON FUNCTION public.year_end_control_status(uuid, uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.year_end_control_status(uuid, uuid)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.refresh_historical_workpapers_after_sie()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period_id uuid;
BEGIN
  IF NEW.status <> 'completed'
     OR OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  v_period_id := NEW.fiscal_period_id;
  IF v_period_id IS NULL THEN
    SELECT fp.id INTO v_period_id
    FROM public.fiscal_periods fp
    WHERE fp.company_id = NEW.company_id
      AND daterange(fp.period_start, fp.period_end, '[]')
        && daterange(NEW.fiscal_year_start, NEW.fiscal_year_end, '[]')
    ORDER BY fp.period_start
    LIMIT 1;
  END IF;

  IF v_period_id IS NOT NULL THEN
    PERFORM public.refresh_year_end_historical_workpapers(
      NEW.company_id, v_period_id, NEW.id
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS refresh_historical_workpapers_after_sie
  ON public.sie_imports;
CREATE TRIGGER refresh_historical_workpapers_after_sie
  AFTER UPDATE OF status ON public.sie_imports
  FOR EACH ROW EXECUTE FUNCTION public.refresh_historical_workpapers_after_sie();

-- Idempotent backfill for completed imports already present before this model.
DO $$
DECLARE
  v_row record;
BEGIN
  FOR v_row IN
    SELECT DISTINCT ON (si.company_id, fp.id)
      si.company_id,
      fp.id AS fiscal_period_id,
      si.id AS import_id
    FROM public.sie_imports si
    JOIN public.fiscal_periods fp
      ON fp.company_id = si.company_id
     AND (
       fp.id = si.fiscal_period_id
       OR daterange(fp.period_start, fp.period_end, '[]')
         && daterange(si.fiscal_year_start, si.fiscal_year_end, '[]')
     )
    WHERE si.status = 'completed'
    ORDER BY si.company_id, fp.id, si.imported_at DESC NULLS LAST, si.created_at DESC
  LOOP
    PERFORM public.refresh_year_end_historical_workpapers(
      v_row.company_id, v_row.fiscal_period_id, v_row.import_id
    );
  END LOOP;
END
$$;

NOTIFY pgrst, 'reload schema';
