-- Remaining historical support registers, locked company snapshots, structured
-- equity/disposition data and the canonical year-end control contract.

CREATE TABLE IF NOT EXISTS public.year_end_company_snapshots (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id            uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE RESTRICT,
  source_sie_import_id        uuid REFERENCES public.sie_imports(id) ON DELETE RESTRICT,
  source_registry_snapshot_id uuid,
  organisation_number         text NOT NULL,
  legal_name                  text NOT NULL,
  address_line1               text,
  address_line2               text,
  postal_code                 text,
  city                        text,
  registered_office           text,
  legal_entity_type           text,
  business_description        text,
  registration_status         text,
  board_members               jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_selection            jsonb NOT NULL DEFAULT '{}'::jsonb,
  effective_at                timestamptz NOT NULL,
  confirmed_by                uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  confirmed_at                timestamptz NOT NULL DEFAULT now(),
  locked_at                   timestamptz,
  snapshot_hash               text NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  superseded_at               timestamptz,
  UNIQUE (company_id, fiscal_period_id, snapshot_hash)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_year_end_company_snapshot_current
  ON public.year_end_company_snapshots (company_id, fiscal_period_id)
  WHERE superseded_at IS NULL;

CREATE TABLE IF NOT EXISTS public.historical_bank_statement_imports (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id      uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE RESTRICT,
  ledger_account        text NOT NULL,
  balance_date          date NOT NULL,
  file_name             text NOT NULL,
  file_hash             text NOT NULL CHECK (file_hash ~ '^[0-9a-f]{64}$'),
  storage_path          text NOT NULL UNIQUE,
  accounting_origin     text NOT NULL DEFAULT 'imported_sie'
    CHECK (accounting_origin = 'imported_sie'),
  recognition_status    text NOT NULL DEFAULT 'already_booked'
    CHECK (recognition_status = 'already_booked'),
  created_by            uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, file_hash)
);

CREATE TABLE IF NOT EXISTS public.historical_bank_statement_rows (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  statement_import_id   uuid NOT NULL REFERENCES public.historical_bank_statement_imports(id) ON DELETE RESTRICT,
  row_index             integer NOT NULL CHECK (row_index >= 0),
  transaction_date      date NOT NULL,
  amount                numeric(18,2) NOT NULL,
  balance               numeric(18,2),
  reference             text,
  description           text,
  accounting_origin     text NOT NULL DEFAULT 'imported_sie'
    CHECK (accounting_origin = 'imported_sie'),
  recognition_status    text NOT NULL DEFAULT 'already_booked'
    CHECK (recognition_status = 'already_booked'),
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (statement_import_id, row_index)
);

CREATE TABLE IF NOT EXISTS public.historical_bank_row_voucher_links (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  statement_row_id      uuid NOT NULL REFERENCES public.historical_bank_statement_rows(id) ON DELETE RESTRICT,
  journal_entry_id      uuid NOT NULL REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  allocated_amount_sek  numeric(18,2) NOT NULL,
  verification_method   text NOT NULL,
  verified_by           uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  verified_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (statement_row_id, journal_entry_id)
);

CREATE TABLE IF NOT EXISTS public.year_end_external_bank_reconciliations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id      uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE RESTRICT,
  ledger_account        text NOT NULL,
  balance_date          date NOT NULL,
  ledger_balance        numeric(18,2) NOT NULL,
  external_balance      numeric(18,2) NOT NULL,
  difference            numeric(18,2) NOT NULL CHECK (abs(difference) < 0.01),
  ledger_snapshot_hash  text NOT NULL CHECK (ledger_snapshot_hash ~ '^[0-9a-f]{64}$'),
  verification_method   text NOT NULL,
  comment               text NOT NULL,
  verified_by           uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  verified_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, fiscal_period_id, ledger_account)
);

CREATE TABLE IF NOT EXISTS public.year_end_external_bank_reconciliation_documents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id  uuid NOT NULL REFERENCES public.year_end_external_bank_reconciliations(id) ON DELETE RESTRICT,
  company_id         uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  document_id        uuid NOT NULL REFERENCES public.document_attachments(id) ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reconciliation_id, document_id)
);

CREATE TABLE IF NOT EXISTS public.year_end_external_bank_reconciliation_invalidations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id  uuid NOT NULL UNIQUE REFERENCES public.year_end_external_bank_reconciliations(id) ON DELETE RESTRICT,
  company_id         uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  reason             text NOT NULL,
  invalidated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.historical_equity_reconciliations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id      uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE RESTRICT,
  balance_date          date NOT NULL,
  opening_equity        numeric(18,2) NOT NULL,
  increases             numeric(18,2) NOT NULL DEFAULT 0,
  decreases             numeric(18,2) NOT NULL DEFAULT 0,
  current_year_result   numeric(18,2) NOT NULL DEFAULT 0,
  closing_equity        numeric(18,2) NOT NULL,
  ledger_equity         numeric(18,2) NOT NULL,
  difference            numeric(18,2) NOT NULL CHECK (abs(difference) < 0.01),
  ledger_snapshot_hash  text NOT NULL CHECK (ledger_snapshot_hash ~ '^[0-9a-f]{64}$'),
  verification_method   text NOT NULL,
  comment               text NOT NULL,
  idempotency_key       text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  verified_by           uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  verified_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, fiscal_period_id),
  UNIQUE (company_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS public.historical_equity_reconciliation_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id  uuid NOT NULL REFERENCES public.historical_equity_reconciliations(id) ON DELETE RESTRICT,
  company_id         uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  line_type          text NOT NULL CHECK (line_type IN (
    'share_capital', 'reserve_fund', 'share_premium', 'retained_earnings',
    'prior_year_result', 'current_year_result', 'dividend',
    'conditional_shareholder_contribution',
    'unconditional_shareholder_contribution',
    'repayment', 'new_issue', 'bonus_issue', 'reduction', 'other'
  )),
  amount             numeric(18,2) NOT NULL,
  description        text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.historical_equity_reconciliation_documents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id  uuid NOT NULL REFERENCES public.historical_equity_reconciliations(id) ON DELETE RESTRICT,
  company_id         uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  document_id        uuid NOT NULL REFERENCES public.document_attachments(id) ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reconciliation_id, document_id)
);

CREATE TABLE IF NOT EXISTS public.historical_equity_reconciliation_invalidations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id  uuid NOT NULL UNIQUE REFERENCES public.historical_equity_reconciliations(id) ON DELETE RESTRICT,
  company_id         uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  reason             text NOT NULL,
  invalidated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.historical_tax_reconciliations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id      uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE RESTRICT,
  balance_date          date NOT NULL,
  ledger_balance        numeric(18,2) NOT NULL,
  verified_balance      numeric(18,2) NOT NULL,
  difference            numeric(18,2) NOT NULL CHECK (abs(difference) < 0.01),
  ledger_snapshot_hash  text NOT NULL CHECK (ledger_snapshot_hash ~ '^[0-9a-f]{64}$'),
  verification_method   text NOT NULL,
  comment               text NOT NULL,
  idempotency_key       text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  verified_by           uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  verified_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, fiscal_period_id),
  UNIQUE (company_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS public.historical_tax_reconciliation_documents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id  uuid NOT NULL REFERENCES public.historical_tax_reconciliations(id) ON DELETE RESTRICT,
  company_id         uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  document_id        uuid NOT NULL REFERENCES public.document_attachments(id) ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reconciliation_id, document_id)
);

CREATE TABLE IF NOT EXISTS public.historical_tax_reconciliation_invalidations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id  uuid NOT NULL UNIQUE REFERENCES public.historical_tax_reconciliations(id) ON DELETE RESTRICT,
  company_id         uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  reason             text NOT NULL,
  invalidated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.historical_vat_reconciliations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id      uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE RESTRICT,
  balance_date          date NOT NULL,
  ledger_balance        numeric(18,2) NOT NULL,
  verified_balance      numeric(18,2) NOT NULL,
  difference            numeric(18,2) NOT NULL CHECK (abs(difference) < 0.01),
  ledger_snapshot_hash  text NOT NULL CHECK (ledger_snapshot_hash ~ '^[0-9a-f]{64}$'),
  verification_method   text NOT NULL,
  comment               text NOT NULL,
  idempotency_key       text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  verified_by           uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  verified_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, fiscal_period_id),
  UNIQUE (company_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS public.historical_vat_reconciliation_documents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id  uuid NOT NULL REFERENCES public.historical_vat_reconciliations(id) ON DELETE RESTRICT,
  company_id         uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  document_id        uuid NOT NULL REFERENCES public.document_attachments(id) ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reconciliation_id, document_id)
);

CREATE TABLE IF NOT EXISTS public.historical_vat_reconciliation_invalidations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id  uuid NOT NULL UNIQUE REFERENCES public.historical_vat_reconciliations(id) ON DELETE RESTRICT,
  company_id         uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  reason             text NOT NULL,
  invalidated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.year_end_profit_dispositions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id          uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE RESTRICT,
  current_year_result       numeric(18,2) NOT NULL,
  free_equity               numeric(18,2) NOT NULL,
  proposed_dividend         numeric(18,2) NOT NULL DEFAULT 0 CHECK (proposed_dividend >= 0),
  carried_forward           numeric(18,2) NOT NULL,
  status                    text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'approved', 'locked', 'superseded'
  )),
  narrative_override        text,
  approved_by               uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  approved_at               timestamptz,
  locked_at                 timestamptz,
  created_by                uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, fiscal_period_id)
);

CREATE TABLE IF NOT EXISTS public.dividend_proposals (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id          uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE RESTRICT,
  profit_disposition_id     uuid NOT NULL REFERENCES public.year_end_profit_dispositions(id) ON DELETE RESTRICT,
  total_amount              numeric(18,2) NOT NULL CHECK (total_amount >= 0),
  amount_per_share          numeric(18,6) CHECK (amount_per_share >= 0),
  share_count               bigint CHECK (share_count > 0),
  free_equity               numeric(18,2) NOT NULL,
  carried_forward           numeric(18,2) NOT NULL,
  planned_payment_date      date,
  board_reasoning           text NOT NULL,
  prudence_assessment       text NOT NULL,
  status                    text NOT NULL DEFAULT 'proposed' CHECK (status IN (
    'proposed', 'approved_for_annual_report', 'withdrawn', 'superseded'
  )),
  created_by                uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (profit_disposition_id)
);

CREATE TABLE IF NOT EXISTS public.dividend_decisions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  dividend_proposal_id      uuid NOT NULL REFERENCES public.dividend_proposals(id) ON DELETE RESTRICT,
  decision_date             date NOT NULL,
  decided_amount            numeric(18,2) NOT NULL CHECK (decided_amount >= 0),
  deviation_reason          text,
  payment_date              date,
  journal_entry_id          uuid REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  decided_by                uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dividend_proposal_id)
);

CREATE TABLE IF NOT EXISTS public.dividend_documents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  dividend_proposal_id  uuid REFERENCES public.dividend_proposals(id) ON DELETE RESTRICT,
  dividend_decision_id  uuid REFERENCES public.dividend_decisions(id) ON DELETE RESTRICT,
  document_id           uuid NOT NULL REFERENCES public.document_attachments(id) ON DELETE RESTRICT,
  document_type         text NOT NULL CHECK (document_type IN (
    'board_proposal', 'prudence_statement', 'agm_minutes', 'payment_evidence'
  )),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK ((dividend_proposal_id IS NOT NULL) <> (dividend_decision_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS public.year_end_equity_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id      uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE RESTRICT,
  event_type            text NOT NULL CHECK (event_type IN (
    'prior_year_result_transfer', 'dividend_proposal', 'dividend_decision',
    'shareholder_contribution', 'shareholder_contribution_repayment',
    'equity_other_change'
  )),
  amount                numeric(18,2) NOT NULL,
  journal_entry_id      uuid REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  source_sie_import_id  uuid REFERENCES public.sie_imports(id) ON DELETE RESTRICT,
  historical_link_only  boolean NOT NULL DEFAULT false,
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by            uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, fiscal_period_id, event_type, journal_entry_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_prior_result_transfer_once
  ON public.year_end_equity_events (company_id, fiscal_period_id, event_type)
  WHERE event_type = 'prior_year_result_transfer';

CREATE TABLE IF NOT EXISTS public.year_end_annotations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id      uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE RESTRICT,
  target_type           text NOT NULL CHECK (target_type IN (
    'year_end', 'account', 'journal_entry', 'receivable', 'payable',
    'bank_account', 'equity', 'tax', 'vat', 'dividend', 'annual_report_section'
  )),
  target_id             text,
  visibility            text NOT NULL CHECK (visibility IN (
    'internal', 'auditor', 'annual_report', 'tax_return'
  )),
  annotation_text       text NOT NULL CHECK (length(btrim(annotation_text)) > 0),
  created_by            uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  supersedes_id         uuid REFERENCES public.year_end_annotations(id) ON DELETE RESTRICT,
  superseded_at         timestamptz
);

CREATE TABLE IF NOT EXISTS public.year_end_annotation_documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  annotation_id  uuid NOT NULL REFERENCES public.year_end_annotations(id) ON DELETE RESTRICT,
  company_id     uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  document_id    uuid NOT NULL REFERENCES public.document_attachments(id) ON DELETE RESTRICT,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (annotation_id, document_id)
);

-- Tenant read policies. Inserts/updates are service-only unless a dedicated
-- RPC is defined below.
DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'year_end_company_snapshots',
    'historical_bank_statement_imports',
    'historical_bank_statement_rows',
    'historical_bank_row_voucher_links',
    'year_end_external_bank_reconciliations',
    'year_end_external_bank_reconciliation_documents',
    'year_end_external_bank_reconciliation_invalidations',
    'historical_equity_reconciliations',
    'historical_equity_reconciliation_lines',
    'historical_equity_reconciliation_documents',
    'historical_equity_reconciliation_invalidations',
    'historical_tax_reconciliations',
    'historical_tax_reconciliation_documents',
    'historical_tax_reconciliation_invalidations',
    'historical_vat_reconciliations',
    'historical_vat_reconciliation_documents',
    'historical_vat_reconciliation_invalidations',
    'year_end_profit_dispositions',
    'dividend_proposals',
    'dividend_decisions',
    'dividend_documents',
    'year_end_equity_events',
    'year_end_annotations',
    'year_end_annotation_documents'
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

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'historical_bank_statement_imports',
    'historical_bank_statement_rows',
    'historical_bank_row_voucher_links',
    'year_end_external_bank_reconciliations',
    'year_end_external_bank_reconciliation_documents',
    'year_end_external_bank_reconciliation_invalidations',
    'historical_equity_reconciliations',
    'historical_equity_reconciliation_lines',
    'historical_equity_reconciliation_documents',
    'historical_equity_reconciliation_invalidations',
    'historical_tax_reconciliations',
    'historical_tax_reconciliation_documents',
    'historical_tax_reconciliation_invalidations',
    'historical_vat_reconciliations',
    'historical_vat_reconciliation_documents',
    'historical_vat_reconciliation_invalidations',
    'year_end_equity_events',
    'dividend_decisions',
    'dividend_documents',
    'year_end_annotation_documents'
  ]
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS %I ON public.%I',
      v_table || '_immutable',
      v_table
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I ' ||
      'FOR EACH ROW EXECUTE FUNCTION public.historical_support_immutable()',
      v_table || '_immutable',
      v_table
    );
  END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION public.enforce_year_end_company_snapshot_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     OR OLD.locked_at IS NOT NULL
     OR (to_jsonb(OLD) - 'superseded_at')
        IS DISTINCT FROM (to_jsonb(NEW) - 'superseded_at')
     OR NEW.superseded_at IS NULL THEN
    RAISE EXCEPTION 'YEAR_END_COMPANY_SNAPSHOT_IMMUTABLE'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS year_end_company_snapshot_immutable
  ON public.year_end_company_snapshots;
CREATE TRIGGER year_end_company_snapshot_immutable
  BEFORE UPDATE OR DELETE ON public.year_end_company_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_year_end_company_snapshot_immutability();

CREATE OR REPLACE FUNCTION public.record_year_end_company_snapshot(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_user_id uuid,
  p_snapshot jsonb,
  p_lock boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_role text := coalesce(auth.role(), current_user::text);
  v_period public.fiscal_periods%ROWTYPE;
  v_company_org text;
  v_snapshot_org text;
  v_hash text;
  v_source_import uuid;
  v_id uuid;
BEGIN
  IF v_role NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'YEAR_END_COMPANY_SNAPSHOT_SERVICE_ONLY'
      USING ERRCODE = '42501';
  END IF;
  SELECT fp.* INTO v_period
  FROM public.fiscal_periods fp
  WHERE fp.id = p_fiscal_period_id
    AND fp.company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND OR v_period.is_closed OR v_period.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'YEAR_END_COMPANY_SNAPSHOT_PERIOD_NOT_OPEN'
      USING ERRCODE = '55000';
  END IF;

  SELECT coalesce(c.org_number, cs.org_number)
  INTO v_company_org
  FROM public.companies c
  LEFT JOIN public.company_settings cs ON cs.company_id = c.id
  WHERE c.id = p_company_id;
  v_snapshot_org := p_snapshot->>'organisation_number';
  IF public.compare_sie_company_identity(v_snapshot_org, v_company_org) <> 'match' THEN
    RAISE EXCEPTION 'YEAR_END_COMPANY_SNAPSHOT_ORG_NUMBER_LOCKED'
      USING ERRCODE = '23514';
  END IF;
  IF length(btrim(coalesce(p_snapshot->>'legal_name', ''))) = 0 THEN
    RAISE EXCEPTION 'YEAR_END_COMPANY_SNAPSHOT_LEGAL_NAME_REQUIRED'
      USING ERRCODE = '23514';
  END IF;

  SELECT si.id INTO v_source_import
  FROM public.sie_imports si
  WHERE si.company_id = p_company_id
    AND si.status = 'completed'
    AND daterange(si.fiscal_year_start, si.fiscal_year_end, '[]')
      && daterange(v_period.period_start, v_period.period_end, '[]')
  ORDER BY si.imported_at DESC NULLS LAST, si.created_at DESC
  LIMIT 1;

  v_hash := encode(digest(
    convert_to(
      jsonb_build_object(
        'company_id', p_company_id,
        'fiscal_period_id', p_fiscal_period_id,
        'organisation_number',
          public.normalize_swedish_organisation_number(v_snapshot_org),
        'snapshot', p_snapshot
      )::text,
      'UTF8'
    ),
    'sha256'::text
  ), 'hex'::text);

  UPDATE public.year_end_company_snapshots
  SET superseded_at = now()
  WHERE company_id = p_company_id
    AND fiscal_period_id = p_fiscal_period_id
    AND superseded_at IS NULL
    AND locked_at IS NULL;

  IF FOUND OR NOT EXISTS (
    SELECT 1
    FROM public.year_end_company_snapshots s
    WHERE s.company_id = p_company_id
      AND s.fiscal_period_id = p_fiscal_period_id
      AND s.superseded_at IS NULL
      AND s.locked_at IS NOT NULL
  ) THEN
    INSERT INTO public.year_end_company_snapshots (
      company_id, fiscal_period_id, source_sie_import_id,
      organisation_number, legal_name, address_line1, address_line2,
      postal_code, city, registered_office, legal_entity_type,
      business_description, registration_status, board_members,
      source_selection, effective_at, confirmed_by, locked_at, snapshot_hash
    ) VALUES (
      p_company_id, p_fiscal_period_id, v_source_import,
      public.normalize_swedish_organisation_number(v_snapshot_org),
      p_snapshot->>'legal_name', p_snapshot->>'address_line1',
      p_snapshot->>'address_line2', p_snapshot->>'postal_code',
      p_snapshot->>'city', p_snapshot->>'registered_office',
      p_snapshot->>'legal_entity_type', p_snapshot->>'business_description',
      p_snapshot->>'registration_status',
      coalesce(p_snapshot->'board_members', '[]'::jsonb),
      coalesce(p_snapshot->'source_selection', '{}'::jsonb),
      coalesce((p_snapshot->>'effective_at')::timestamptz, now()),
      p_user_id, CASE WHEN p_lock THEN now() ELSE NULL END, v_hash
    )
    RETURNING id INTO v_id;
  ELSE
    RAISE EXCEPTION 'YEAR_END_COMPANY_SNAPSHOT_ALREADY_LOCKED'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.audit_log (
    user_id, company_id, action, table_name, record_id, actor_id,
    new_state, description
  ) VALUES (
    p_user_id, p_company_id, 'SECURITY_EVENT',
    'year_end_company_snapshots', v_id, p_user_id,
    jsonb_build_object(
      'fiscal_period_id', p_fiscal_period_id,
      'organisation_number',
        public.normalize_swedish_organisation_number(v_snapshot_org),
      'snapshot_hash', v_hash,
      'locked', p_lock
    ),
    'Företagssnapshot för bokslut bekräftad.'
  );

  RETURN jsonb_build_object(
    'id', v_id,
    'snapshot_hash', v_hash,
    'locked', p_lock
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_year_end_company_snapshot(
  uuid, uuid, uuid, jsonb, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_year_end_company_snapshot(
  uuid, uuid, uuid, jsonb, boolean
) TO service_role;

CREATE OR REPLACE FUNCTION public.record_historical_balance_reconciliation(
  p_category text,
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_user_id uuid,
  p_verified_balance numeric,
  p_document_id uuid,
  p_verification_method text,
  p_comment text,
  p_idempotency_key text,
  p_details jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text := coalesce(auth.role(), current_user::text);
  v_period public.fiscal_periods%ROWTYPE;
  v_document public.document_attachments%ROWTYPE;
  v_snapshot record;
  v_control_category text;
  v_difference numeric;
  v_id uuid;
  v_closing_equity numeric;
  v_line jsonb;
BEGIN
  IF v_role NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'HISTORICAL_BALANCE_RECONCILIATION_SERVICE_ONLY'
      USING ERRCODE = '42501';
  END IF;
  IF p_category NOT IN ('equity', 'tax', 'vat')
     OR p_idempotency_key IS NULL
     OR length(p_idempotency_key) NOT BETWEEN 8 AND 128
     OR length(btrim(coalesce(p_verification_method, ''))) < 3
     OR length(btrim(coalesce(p_comment, ''))) < 3 THEN
    RAISE EXCEPTION 'HISTORICAL_BALANCE_RECONCILIATION_INVALID_ARGUMENT'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat_ws(':', 'historical-balance', p_company_id, p_fiscal_period_id, p_category),
    0
  ));

  SELECT fp.* INTO v_period
  FROM public.fiscal_periods fp
  WHERE fp.id = p_fiscal_period_id
    AND fp.company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND OR v_period.is_closed OR v_period.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'HISTORICAL_BALANCE_RECONCILIATION_PERIOD_NOT_OPEN'
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
    RAISE EXCEPTION 'HISTORICAL_BALANCE_RECONCILIATION_EVIDENCE_INVALID'
      USING ERRCODE = '23514';
  END IF;

  v_control_category := CASE p_category
    WHEN 'equity' THEN 'equity_accounts'
    WHEN 'tax' THEN 'tax_accounts'
    ELSE 'vat_accounts'
  END;
  SELECT * INTO v_snapshot
  FROM public.__year_end_control_ledger_snapshot(
    p_company_id, v_control_category, v_period.period_end
  );
  v_difference := round(p_verified_balance - v_snapshot.ledger_balance, 2);
  IF abs(v_difference) >= 0.01 THEN
    RAISE EXCEPTION
      'HISTORICAL_BALANCE_RECONCILIATION_DIFFERENCE: verified=% ledger=% difference=%',
      round(p_verified_balance, 2),
      v_snapshot.ledger_balance,
      v_difference
      USING ERRCODE = '23514';
  END IF;

  IF p_category = 'equity' THEN
    v_closing_equity := round(
      coalesce((p_details->>'opening_equity')::numeric, 0)
      + coalesce((p_details->>'increases')::numeric, 0)
      - coalesce((p_details->>'decreases')::numeric, 0)
      + coalesce((p_details->>'current_year_result')::numeric, 0),
      2
    );
    IF abs(v_closing_equity - p_verified_balance) >= 0.01 THEN
      RAISE EXCEPTION
        'HISTORICAL_EQUITY_ROLLFORWARD_DIFFERENCE: closing=% verified=%',
        v_closing_equity, p_verified_balance
        USING ERRCODE = '23514';
    END IF;

    INSERT INTO public.historical_equity_reconciliations (
      company_id, fiscal_period_id, balance_date,
      opening_equity, increases, decreases, current_year_result,
      closing_equity, ledger_equity, difference, ledger_snapshot_hash,
      verification_method, comment, idempotency_key, verified_by
    ) VALUES (
      p_company_id, p_fiscal_period_id, v_period.period_end,
      coalesce((p_details->>'opening_equity')::numeric, 0),
      coalesce((p_details->>'increases')::numeric, 0),
      coalesce((p_details->>'decreases')::numeric, 0),
      coalesce((p_details->>'current_year_result')::numeric, 0),
      v_closing_equity, v_snapshot.ledger_balance, v_difference,
      v_snapshot.snapshot_hash, p_verification_method, p_comment,
      p_idempotency_key, p_user_id
    ) RETURNING id INTO v_id;

    FOR v_line IN
      SELECT value FROM jsonb_array_elements(
        coalesce(p_details->'lines', '[]'::jsonb)
      )
    LOOP
      INSERT INTO public.historical_equity_reconciliation_lines (
        reconciliation_id, company_id, line_type, amount, description
      ) VALUES (
        v_id, p_company_id, v_line->>'line_type',
        (v_line->>'amount')::numeric, v_line->>'description'
      );
    END LOOP;

    INSERT INTO public.historical_equity_reconciliation_documents (
      reconciliation_id, company_id, document_id
    ) VALUES (v_id, p_company_id, p_document_id);
  ELSIF p_category = 'tax' THEN
    INSERT INTO public.historical_tax_reconciliations (
      company_id, fiscal_period_id, balance_date, ledger_balance,
      verified_balance, difference, ledger_snapshot_hash,
      verification_method, comment, idempotency_key, verified_by
    ) VALUES (
      p_company_id, p_fiscal_period_id, v_period.period_end,
      v_snapshot.ledger_balance, round(p_verified_balance, 2), v_difference,
      v_snapshot.snapshot_hash, p_verification_method, p_comment,
      p_idempotency_key, p_user_id
    ) RETURNING id INTO v_id;
    INSERT INTO public.historical_tax_reconciliation_documents (
      reconciliation_id, company_id, document_id
    ) VALUES (v_id, p_company_id, p_document_id);
  ELSE
    INSERT INTO public.historical_vat_reconciliations (
      company_id, fiscal_period_id, balance_date, ledger_balance,
      verified_balance, difference, ledger_snapshot_hash,
      verification_method, comment, idempotency_key, verified_by
    ) VALUES (
      p_company_id, p_fiscal_period_id, v_period.period_end,
      v_snapshot.ledger_balance, round(p_verified_balance, 2), v_difference,
      v_snapshot.snapshot_hash, p_verification_method, p_comment,
      p_idempotency_key, p_user_id
    ) RETURNING id INTO v_id;
    INSERT INTO public.historical_vat_reconciliation_documents (
      reconciliation_id, company_id, document_id
    ) VALUES (v_id, p_company_id, p_document_id);
  END IF;

  INSERT INTO public.audit_log (
    user_id, company_id, action, table_name, record_id, actor_id,
    new_state, description
  ) VALUES (
    p_user_id, p_company_id, 'SECURITY_EVENT',
    'historical_' || p_category || '_reconciliations',
    v_id, p_user_id,
    jsonb_build_object(
      'fiscal_period_id', p_fiscal_period_id,
      'balance_date', v_period.period_end,
      'ledger_balance', v_snapshot.ledger_balance,
      'verified_balance', round(p_verified_balance, 2),
      'difference', v_difference,
      'document_id', p_document_id,
      'snapshot_hash', v_snapshot.snapshot_hash
    ),
    'Historisk bokslutsavstämning verifierad mot serverberäknad huvudbok.'
  );

  RETURN jsonb_build_object(
    'id', v_id,
    'ledger_balance', v_snapshot.ledger_balance,
    'difference', v_difference
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_historical_balance_reconciliation(
  text, uuid, uuid, uuid, numeric, uuid, text, text, text, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_historical_balance_reconciliation(
  text, uuid, uuid, uuid, numeric, uuid, text, text, text, jsonb
) TO service_role;

CREATE OR REPLACE FUNCTION public.record_year_end_profit_disposition(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_user_id uuid,
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text := coalesce(auth.role(), current_user::text);
  v_period public.fiscal_periods%ROWTYPE;
  v_current_result numeric;
  v_free_equity numeric;
  v_dividend numeric;
  v_carried numeric;
  v_id uuid;
BEGIN
  IF v_role NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'YEAR_END_PROFIT_DISPOSITION_SERVICE_ONLY'
      USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat_ws(':', 'profit-disposition', p_company_id, p_fiscal_period_id),
    0
  ));
  SELECT fp.* INTO v_period
  FROM public.fiscal_periods fp
  WHERE fp.id = p_fiscal_period_id
    AND fp.company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND OR v_period.is_closed OR v_period.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'YEAR_END_PROFIT_DISPOSITION_PERIOD_NOT_OPEN'
      USING ERRCODE = '55000';
  END IF;

  v_current_result := round((p_payload->>'current_year_result')::numeric, 2);
  v_free_equity := round((p_payload->>'free_equity')::numeric, 2);
  v_dividend := round(coalesce((p_payload->>'proposed_dividend')::numeric, 0), 2);
  v_carried := round((p_payload->>'carried_forward')::numeric, 2);
  IF v_dividend < 0
     OR v_free_equity < 0
     OR v_dividend > v_free_equity + 0.01
     OR abs(v_carried - (v_free_equity - v_dividend)) >= 0.01 THEN
    RAISE EXCEPTION 'YEAR_END_PROFIT_DISPOSITION_INVALID_AMOUNTS'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.year_end_profit_dispositions (
    company_id, fiscal_period_id, current_year_result, free_equity,
    proposed_dividend, carried_forward, status, narrative_override,
    approved_by, approved_at, created_by
  ) VALUES (
    p_company_id, p_fiscal_period_id, v_current_result, v_free_equity,
    v_dividend, v_carried, 'approved', p_payload->>'narrative_override',
    p_user_id, now(), p_user_id
  )
  ON CONFLICT (company_id, fiscal_period_id) DO UPDATE SET
    current_year_result = EXCLUDED.current_year_result,
    free_equity = EXCLUDED.free_equity,
    proposed_dividend = EXCLUDED.proposed_dividend,
    carried_forward = EXCLUDED.carried_forward,
    status = 'approved',
    narrative_override = EXCLUDED.narrative_override,
    approved_by = p_user_id,
    approved_at = now()
  WHERE year_end_profit_dispositions.locked_at IS NULL
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'YEAR_END_PROFIT_DISPOSITION_LOCKED'
      USING ERRCODE = '55000';
  END IF;

  IF v_dividend > 0 THEN
    IF length(btrim(coalesce(p_payload->>'board_reasoning', ''))) < 3
       OR length(btrim(coalesce(p_payload->>'prudence_assessment', ''))) < 3
       OR nullif(p_payload->>'share_count', '') IS NULL
       OR nullif(p_payload->>'share_count', '')::bigint <= 0
       OR nullif(p_payload->>'amount_per_share', '') IS NULL
       OR nullif(p_payload->>'amount_per_share', '')::numeric < 0
       OR nullif(p_payload->>'planned_payment_date', '')::date IS NULL
       OR abs(
         nullif(p_payload->>'amount_per_share', '')::numeric
         * nullif(p_payload->>'share_count', '')::bigint
         - v_dividend
       ) >= 0.01 THEN
      RAISE EXCEPTION 'YEAR_END_DIVIDEND_JUSTIFICATION_REQUIRED'
        USING ERRCODE = '23514';
    END IF;
    INSERT INTO public.dividend_proposals (
      company_id, fiscal_period_id, profit_disposition_id,
      total_amount, amount_per_share, share_count, free_equity,
      carried_forward, planned_payment_date, board_reasoning,
      prudence_assessment, status, created_by
    ) VALUES (
      p_company_id, p_fiscal_period_id, v_id, v_dividend,
      nullif(p_payload->>'amount_per_share', '')::numeric,
      nullif(p_payload->>'share_count', '')::bigint,
      v_free_equity, v_carried,
      nullif(p_payload->>'planned_payment_date', '')::date,
      p_payload->>'board_reasoning',
      p_payload->>'prudence_assessment',
      'approved_for_annual_report', p_user_id
    )
    ON CONFLICT (profit_disposition_id) DO UPDATE SET
      total_amount = EXCLUDED.total_amount,
      amount_per_share = EXCLUDED.amount_per_share,
      share_count = EXCLUDED.share_count,
      free_equity = EXCLUDED.free_equity,
      carried_forward = EXCLUDED.carried_forward,
      planned_payment_date = EXCLUDED.planned_payment_date,
      board_reasoning = EXCLUDED.board_reasoning,
      prudence_assessment = EXCLUDED.prudence_assessment,
      status = EXCLUDED.status;
  ELSE
    UPDATE public.dividend_proposals
    SET status = 'withdrawn'
    WHERE profit_disposition_id = v_id
      AND status <> 'withdrawn';
  END IF;

  INSERT INTO public.audit_log (
    user_id, company_id, action, table_name, record_id, actor_id,
    new_state, description
  ) VALUES (
    p_user_id, p_company_id, 'SECURITY_EVENT',
    'year_end_profit_dispositions', v_id, p_user_id,
    jsonb_build_object(
      'fiscal_period_id', p_fiscal_period_id,
      'current_year_result', v_current_result,
      'free_equity', v_free_equity,
      'proposed_dividend', v_dividend,
      'carried_forward', v_carried
    ),
    'Strukturerad resultatdisposition godkänd utan bokföring av utdelningsskuld.'
  );
  RETURN jsonb_build_object(
    'id', v_id,
    'proposed_dividend', v_dividend,
    'journal_entry_created', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_year_end_profit_disposition(
  uuid, uuid, uuid, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_year_end_profit_disposition(
  uuid, uuid, uuid, jsonb
) TO service_role;

CREATE OR REPLACE FUNCTION public.record_year_end_annotation(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_user_id uuid,
  p_target_type text,
  p_target_id text,
  p_visibility text,
  p_annotation_text text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text := coalesce(auth.role(), current_user::text);
  v_id uuid;
BEGIN
  IF v_role NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'YEAR_END_ANNOTATION_SERVICE_ONLY'
      USING ERRCODE = '42501';
  END IF;
  IF p_target_type NOT IN (
    'year_end', 'account', 'journal_entry', 'receivable', 'payable',
    'bank_account', 'equity', 'tax', 'vat', 'dividend',
    'annual_report_section'
  ) OR p_visibility NOT IN (
    'internal', 'auditor', 'annual_report', 'tax_return'
  ) OR length(btrim(coalesce(p_annotation_text, ''))) = 0 THEN
    RAISE EXCEPTION 'YEAR_END_ANNOTATION_INVALID'
      USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.fiscal_periods fp
    WHERE fp.id = p_fiscal_period_id
      AND fp.company_id = p_company_id
      AND NOT fp.is_closed
      AND fp.locked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'YEAR_END_ANNOTATION_PERIOD_NOT_OPEN'
      USING ERRCODE = '55000';
  END IF;
  INSERT INTO public.year_end_annotations (
    company_id, fiscal_period_id, target_type, target_id,
    visibility, annotation_text, created_by
  ) VALUES (
    p_company_id, p_fiscal_period_id, p_target_type, p_target_id,
    p_visibility, btrim(p_annotation_text), p_user_id
  ) RETURNING id INTO v_id;

  INSERT INTO public.audit_log (
    user_id, company_id, action, table_name, record_id, actor_id,
    new_state, description
  ) VALUES (
    p_user_id, p_company_id, 'SECURITY_EVENT',
    'year_end_annotations', v_id, p_user_id,
    jsonb_build_object(
      'fiscal_period_id', p_fiscal_period_id,
      'target_type', p_target_type,
      'target_id', p_target_id,
      'visibility', p_visibility
    ),
    'Bokslutsanteckning registrerad med explicit synlighet.'
  );
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_year_end_annotation(
  uuid, uuid, uuid, text, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_year_end_annotation(
  uuid, uuid, uuid, text, text, text, text
) TO service_role;

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
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period public.fiscal_periods%ROWTYPE;
  v_ar record;
  v_ap record;
  v_import record;
  v_snapshot_count integer;
  v_cash record;
  v_balance_snapshot record;
  v_verified_balance numeric;
  v_verified_hash text;
  v_verification_method text;
  v_verification_invalid boolean;
  v_evidence_count integer;
  v_entity_type text;
  v_profit_disposition_count integer;
BEGIN
  SELECT fp.* INTO v_period
  FROM public.fiscal_periods fp
  WHERE fp.id = p_fiscal_period_id
    AND fp.company_id = p_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'YEAR_END_CONTROL_PERIOD_NOT_FOUND'
      USING ERRCODE = '22023';
  END IF;
  SELECT c.entity_type INTO v_entity_type
  FROM public.companies c
  WHERE c.id = p_company_id;

  SELECT si.* INTO v_import
  FROM public.sie_imports si
  WHERE si.company_id = p_company_id
    AND si.status = 'completed'
    AND (
      si.fiscal_period_id = p_fiscal_period_id
      OR daterange(si.fiscal_year_start, si.fiscal_year_end, '[]')
        && daterange(v_period.period_start, v_period.period_end, '[]')
    )
  ORDER BY si.imported_at DESC NULLS LAST, si.created_at DESC
  LIMIT 1;

  IF v_import.id IS NOT NULL THEN
    control_code := 'sie_company_identity';
    control_category := 'company_identity';
    status := CASE
      WHEN public.compare_sie_company_identity(
        v_import.org_number,
        (
          SELECT coalesce(c.org_number, cs.org_number)
          FROM public.companies c
          LEFT JOIN public.company_settings cs ON cs.company_id = c.id
          WHERE c.id = p_company_id
        )
      ) = 'match' THEN 'reconciled'
      ELSE 'accounting_error'
    END;
    ledger_amount := NULL;
    supporting_register_amount := NULL;
    difference := NULL;
    source_type := 'sie_import';
    verification_method := 'organisation_number';
    evidence_count := 1;
    is_stale := false;
    is_blocking := status <> 'reconciled';
    message := CASE WHEN status = 'reconciled'
      THEN 'SIE-filens juridiska identitet stämmer med det valda företaget.'
      ELSE 'SIE-filens organisationsnummer stämmer inte med det valda företaget.'
    END;
    available_actions := '[]'::jsonb;
    metadata := jsonb_build_object('sie_import_id', v_import.id);
    RETURN NEXT;
  END IF;

  SELECT count(*)::integer INTO v_snapshot_count
  FROM public.year_end_company_snapshots s
  WHERE s.company_id = p_company_id
    AND s.fiscal_period_id = p_fiscal_period_id
    AND s.superseded_at IS NULL
    AND s.locked_at IS NOT NULL;

  control_code := 'year_end_company_snapshot';
  control_category := 'company_identity';
  status := CASE WHEN v_snapshot_count = 1
    THEN 'reconciled' ELSE 'completion_required' END;
  ledger_amount := NULL;
  supporting_register_amount := NULL;
  difference := NULL;
  source_type := 'year_end_snapshot';
  verification_method := 'field_by_field_confirmation';
  evidence_count := v_snapshot_count;
  is_stale := false;
  is_blocking := v_import.id IS NOT NULL AND v_snapshot_count <> 1;
  message := CASE WHEN v_snapshot_count = 1
    THEN 'Företagsuppgifterna för bokslutet är bekräftade och låsta.'
    ELSE 'Bekräfta och lås vilka företagsuppgifter som ska användas i bokslutet och årsredovisningen.'
  END;
  available_actions := jsonb_build_array('confirm_company_snapshot');
  metadata := '{}'::jsonb;
  RETURN NEXT;

  SELECT count(*)::integer INTO v_profit_disposition_count
  FROM public.year_end_profit_dispositions d
  WHERE d.company_id = p_company_id
    AND d.fiscal_period_id = p_fiscal_period_id
    AND d.status IN ('approved', 'locked');
  control_code := 'profit_disposition';
  control_category := 'profit_disposition';
  status := CASE
    WHEN v_entity_type <> 'aktiebolag' THEN 'reconciled'
    WHEN v_profit_disposition_count = 1 THEN 'reconciled'
    ELSE 'completion_required'
  END;
  ledger_amount := NULL;
  supporting_register_amount := NULL;
  difference := NULL;
  source_type := 'structured_profit_disposition';
  verification_method := 'board_approval';
  evidence_count := v_profit_disposition_count;
  is_stale := false;
  is_blocking := v_import.id IS NOT NULL
    AND v_entity_type = 'aktiebolag'
    AND status <> 'reconciled';
  message := CASE WHEN status = 'reconciled'
    THEN 'Resultatdispositionen är strukturerad och godkänd.'
    ELSE 'Godkänn en strukturerad resultatdisposition för årsredovisningen.'
  END;
  available_actions := jsonb_build_array('approve_profit_disposition');
  metadata := '{}'::jsonb;
  RETURN NEXT;

  SELECT * INTO v_ar
  FROM public.customer_receivables_reconciliation_at(
    p_company_id, p_fiscal_period_id, v_period.period_end
  );
  control_code := 'customer_receivables_reconciliation';
  control_category := 'customer_receivables';
  status := CASE
    WHEN v_ar.is_reconciled THEN 'reconciled'
    WHEN abs(v_ar.difference) >= 0.01
      AND v_ar.reconciliation_mode <> 'none' THEN 'accounting_error'
    WHEN v_ar.reconciliation_mode = 'none' THEN 'completion_required'
    ELSE 'manual_verification_required'
  END;
  ledger_amount := v_ar.ledger_balance;
  supporting_register_amount := v_ar.total_subledger;
  difference := v_ar.difference;
  source_type := v_ar.reconciliation_mode;
  verification_method := CASE
    WHEN v_ar.reconciliation_mode LIKE 'external_%' THEN 'external_evidence'
    WHEN v_ar.reconciliation_mode LIKE 'itemized_%' THEN 'itemized'
    ELSE NULL
  END;
  evidence_count := CASE WHEN v_ar.reconciliation_mode = 'none' THEN 0 ELSE 1 END;
  is_stale := v_ar.verification_stale OR v_ar.source_import_invalidated;
  is_blocking := v_import.id IS NOT NULL AND NOT v_ar.is_reconciled
    AND (
      abs(v_ar.ledger_balance) >= 0.01
      OR abs(v_ar.total_subledger) >= 0.01
    );
  message := CASE WHEN v_ar.is_reconciled
    THEN 'Kundreskontran stämmer mot huvudboken.'
    WHEN v_ar.reconciliation_mode = 'none'
      THEN 'Komplettera historiska kundfordringar eller verifiera extern kundreskontra.'
    ELSE 'Kundreskontran stämmer inte mot huvudboken.'
  END;
  available_actions := jsonb_build_array(
    'register_migrated_receivables',
    'verify_external_receivables'
  );
  metadata := jsonb_build_object(
    'expected_legacy_balance', v_ar.expected_legacy_balance,
    'reconciliation_mode', v_ar.reconciliation_mode
  );
  RETURN NEXT;

  SELECT * INTO v_ap
  FROM public.supplier_payables_reconciliation_at(
    p_company_id, p_fiscal_period_id, v_period.period_end
  );
  control_code := 'supplier_payables_reconciliation';
  control_category := 'supplier_payables';
  status := CASE
    WHEN v_ap.is_reconciled THEN 'reconciled'
    WHEN abs(v_ap.difference) >= 0.01
      AND v_ap.reconciliation_mode <> 'none' THEN 'accounting_error'
    WHEN v_ap.reconciliation_mode = 'none' THEN 'completion_required'
    ELSE 'manual_verification_required'
  END;
  ledger_amount := v_ap.ledger_balance;
  supporting_register_amount := v_ap.total_subledger;
  difference := v_ap.difference;
  source_type := v_ap.reconciliation_mode;
  verification_method := CASE
    WHEN v_ap.reconciliation_mode LIKE 'external_%' THEN 'external_evidence'
    WHEN v_ap.reconciliation_mode LIKE 'itemized_%' THEN 'itemized'
    ELSE NULL
  END;
  evidence_count := CASE WHEN v_ap.reconciliation_mode = 'none' THEN 0 ELSE 1 END;
  is_stale := v_ap.verification_stale OR v_ap.source_import_invalidated;
  is_blocking := v_import.id IS NOT NULL AND NOT v_ap.is_reconciled
    AND (
      abs(v_ap.ledger_balance) >= 0.01
      OR abs(v_ap.total_subledger) >= 0.01
    );
  message := CASE WHEN v_ap.is_reconciled
    THEN 'Leverantörsreskontran stämmer mot huvudboken.'
    WHEN v_ap.reconciliation_mode = 'none'
      THEN 'Komplettera historiska leverantörsskulder eller verifiera extern leverantörsreskontra.'
    ELSE 'Leverantörsreskontran stämmer inte mot huvudboken.'
  END;
  available_actions := jsonb_build_array(
    'register_migrated_payables',
    'verify_external_payables'
  );
  metadata := jsonb_build_object(
    'expected_legacy_balance', v_ap.expected_legacy_balance,
    'reconciliation_mode', v_ap.reconciliation_mode
  );
  RETURN NEXT;

  FOR v_cash IN
    SELECT *
    FROM public.year_end_cash_reconciliation_status(
      p_company_id, p_fiscal_period_id
    )
  LOOP
    control_code := 'bank_reconciliation_' || v_cash.ledger_account;
    control_category := 'bank';
    status := CASE
      WHEN v_cash.is_reconciled THEN 'reconciled'
      WHEN v_cash.reconciliation_id IS NULL
        AND v_cash.reconciliation_mode = 'manual'
        THEN 'manual_verification_required'
      WHEN abs(coalesce(v_cash.difference, 0)) >= 0.01
        THEN 'accounting_error'
      ELSE 'completion_required'
    END;
    ledger_amount := v_cash.ledger_balance;
    supporting_register_amount := v_cash.statement_balance;
    difference := v_cash.difference;
    source_type := v_cash.reconciliation_mode;
    verification_method := CASE
      WHEN v_cash.reconciliation_mode = 'manual'
        THEN 'statement_evidence'
      ELSE 'transaction_matching'
    END;
    evidence_count := CASE WHEN v_cash.evidence_document_id IS NULL THEN 0 ELSE 1 END;
    is_stale := v_cash.invalidated_at IS NOT NULL
      OR (
        v_cash.reconciliation_mode = 'manual'
        AND NOT coalesce(v_cash.snapshot_current, false)
      );
    -- The pre-existing cash branch in the wrapped blocker function owns the
    -- blocking row. This control row is the richer UI/API representation.
    is_blocking := false;
    message := CASE WHEN v_cash.is_reconciled
      THEN format('Likvidkonto %s är avstämt.', v_cash.ledger_account)
      ELSE format('Likvidkonto %s behöver stämmas av.', v_cash.ledger_account)
    END;
    available_actions := jsonb_build_array(
      'import_historical_bank_statement',
      'verify_bank_balance'
    );
    metadata := jsonb_build_object(
      'cash_account_id', v_cash.cash_account_id,
      'unmatched_transaction_count', v_cash.unmatched_transaction_count,
      'unmatched_gl_line_count', v_cash.unmatched_gl_line_count,
      'matching_conflict_count', v_cash.matching_conflict_count
    );
    RETURN NEXT;
  END LOOP;

  -- Historical equity.
  SELECT * INTO v_balance_snapshot
  FROM public.__year_end_control_ledger_snapshot(
    p_company_id, 'equity_accounts', v_period.period_end
  );
  SELECT
    r.closing_equity,
    r.ledger_snapshot_hash,
    r.verification_method,
    (i.id IS NOT NULL),
    (
      SELECT count(*)::integer
      FROM public.historical_equity_reconciliation_documents d
      WHERE d.reconciliation_id = r.id
    )
  INTO
    v_verified_balance,
    v_verified_hash,
    v_verification_method,
    v_verification_invalid,
    v_evidence_count
  FROM public.historical_equity_reconciliations r
  LEFT JOIN public.historical_equity_reconciliation_invalidations i
    ON i.reconciliation_id = r.id
  WHERE r.company_id = p_company_id
    AND r.fiscal_period_id = p_fiscal_period_id;

  control_code := 'equity_reconciliation';
  control_category := 'equity';
  ledger_amount := v_balance_snapshot.ledger_balance;
  supporting_register_amount := v_verified_balance;
  difference := CASE WHEN v_verified_balance IS NULL THEN NULL
    ELSE round(v_verified_balance - v_balance_snapshot.ledger_balance, 2) END;
  source_type := 'historical_equity_reconciliation';
  verification_method := v_verification_method;
  evidence_count := coalesce(v_evidence_count, 0);
  is_stale := coalesce(v_verification_invalid, false)
    OR (
      v_verified_hash IS NOT NULL
      AND v_verified_hash <> v_balance_snapshot.snapshot_hash
    );
  status := CASE
    WHEN abs(v_balance_snapshot.ledger_balance) < 0.01
      AND v_verified_balance IS NULL THEN 'reconciled'
    WHEN v_verified_balance IS NULL THEN 'manual_verification_required'
    WHEN is_stale THEN 'manual_verification_required'
    WHEN abs(coalesce(difference, 0)) >= 0.01 THEN 'accounting_error'
    WHEN evidence_count = 0 THEN 'completion_required'
    ELSE 'reconciled'
  END;
  is_blocking := v_import.id IS NOT NULL AND status <> 'reconciled';
  message := CASE WHEN status = 'reconciled'
    THEN 'Eget kapital är avstämt mot huvudboken.'
    ELSE 'Skapa eller förnya den historiska eget-kapitalavstämningen.'
  END;
  available_actions := jsonb_build_array(
    'create_equity_reconciliation',
    'verify_equity_manually'
  );
  metadata := '{}'::jsonb;
  RETURN NEXT;

  -- Historical tax.
  SELECT * INTO v_balance_snapshot
  FROM public.__year_end_control_ledger_snapshot(
    p_company_id, 'tax_accounts', v_period.period_end
  );
  SELECT
    r.verified_balance,
    r.ledger_snapshot_hash,
    r.verification_method,
    (i.id IS NOT NULL),
    (
      SELECT count(*)::integer
      FROM public.historical_tax_reconciliation_documents d
      WHERE d.reconciliation_id = r.id
    )
  INTO
    v_verified_balance,
    v_verified_hash,
    v_verification_method,
    v_verification_invalid,
    v_evidence_count
  FROM public.historical_tax_reconciliations r
  LEFT JOIN public.historical_tax_reconciliation_invalidations i
    ON i.reconciliation_id = r.id
  WHERE r.company_id = p_company_id
    AND r.fiscal_period_id = p_fiscal_period_id;

  control_code := 'tax_reconciliation';
  control_category := 'tax';
  ledger_amount := v_balance_snapshot.ledger_balance;
  supporting_register_amount := v_verified_balance;
  difference := CASE WHEN v_verified_balance IS NULL THEN NULL
    ELSE round(v_verified_balance - v_balance_snapshot.ledger_balance, 2) END;
  source_type := 'historical_tax_reconciliation';
  verification_method := v_verification_method;
  evidence_count := coalesce(v_evidence_count, 0);
  is_stale := coalesce(v_verification_invalid, false)
    OR (
      v_verified_hash IS NOT NULL
      AND v_verified_hash <> v_balance_snapshot.snapshot_hash
    );
  status := CASE
    WHEN abs(v_balance_snapshot.ledger_balance) < 0.01
      AND v_verified_balance IS NULL THEN 'reconciled'
    WHEN v_verified_balance IS NULL THEN 'manual_verification_required'
    WHEN is_stale THEN 'manual_verification_required'
    WHEN abs(coalesce(difference, 0)) >= 0.01 THEN 'accounting_error'
    WHEN evidence_count = 0 THEN 'completion_required'
    ELSE 'reconciled'
  END;
  is_blocking := v_import.id IS NOT NULL AND status <> 'reconciled';
  message := CASE WHEN status = 'reconciled'
    THEN 'Skatten är avstämd mot huvudboken.'
    ELSE 'Verifiera historisk skatt med deklaration eller skattekontoutdrag.'
  END;
  available_actions := jsonb_build_array('verify_tax');
  metadata := '{}'::jsonb;
  RETURN NEXT;

  -- Historical VAT.
  SELECT * INTO v_balance_snapshot
  FROM public.__year_end_control_ledger_snapshot(
    p_company_id, 'vat_accounts', v_period.period_end
  );
  SELECT
    r.verified_balance,
    r.ledger_snapshot_hash,
    r.verification_method,
    (i.id IS NOT NULL),
    (
      SELECT count(*)::integer
      FROM public.historical_vat_reconciliation_documents d
      WHERE d.reconciliation_id = r.id
    )
  INTO
    v_verified_balance,
    v_verified_hash,
    v_verification_method,
    v_verification_invalid,
    v_evidence_count
  FROM public.historical_vat_reconciliations r
  LEFT JOIN public.historical_vat_reconciliation_invalidations i
    ON i.reconciliation_id = r.id
  WHERE r.company_id = p_company_id
    AND r.fiscal_period_id = p_fiscal_period_id;

  control_code := 'vat_reconciliation';
  control_category := 'vat';
  ledger_amount := v_balance_snapshot.ledger_balance;
  supporting_register_amount := v_verified_balance;
  difference := CASE WHEN v_verified_balance IS NULL THEN NULL
    ELSE round(v_verified_balance - v_balance_snapshot.ledger_balance, 2) END;
  source_type := 'historical_vat_reconciliation';
  verification_method := v_verification_method;
  evidence_count := coalesce(v_evidence_count, 0);
  is_stale := coalesce(v_verification_invalid, false)
    OR (
      v_verified_hash IS NOT NULL
      AND v_verified_hash <> v_balance_snapshot.snapshot_hash
    );
  status := CASE
    WHEN abs(v_balance_snapshot.ledger_balance) < 0.01
      AND v_verified_balance IS NULL THEN 'reconciled'
    WHEN v_verified_balance IS NULL THEN 'manual_verification_required'
    WHEN is_stale THEN 'manual_verification_required'
    WHEN abs(coalesce(difference, 0)) >= 0.01 THEN 'accounting_error'
    WHEN evidence_count = 0 THEN 'completion_required'
    ELSE 'reconciled'
  END;
  is_blocking := v_import.id IS NOT NULL AND status <> 'reconciled';
  message := CASE WHEN status = 'reconciled'
    THEN 'Momsen är avstämd mot huvudboken.'
    ELSE 'Verifiera historisk moms med momsrapport eller deklaration.'
  END;
  available_actions := jsonb_build_array('verify_vat');
  metadata := '{}'::jsonb;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.year_end_control_status(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.year_end_control_status(uuid, uuid)
  TO service_role;

-- Replace only the canonical blocker wrapper. The transaction-internal close
-- calls this name after acquiring the period lock, so it sees the same
-- controls as the UI.
DO $$
BEGIN
  IF to_regprocedure(
    'public.__year_end_db_blockers_historical_core_20260729(uuid,uuid)'
  ) IS NULL THEN
    ALTER FUNCTION public.year_end_db_blockers(uuid, uuid)
      RENAME TO __year_end_db_blockers_historical_core_20260729;
  END IF;
END
$$;

REVOKE ALL ON FUNCTION
  public.__year_end_db_blockers_historical_core_20260729(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.__year_end_db_blockers_historical_core_20260729(uuid, uuid)
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
  v_period public.fiscal_periods%ROWTYPE;
  v_count integer;
  v_control record;
BEGIN
  SELECT fp.* INTO v_period
  FROM public.fiscal_periods fp
  WHERE fp.id = p_fiscal_period_id
    AND fp.company_id = p_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'YE_PERIOD_NOT_FOUND';
  END IF;

  RETURN QUERY
  SELECT core.code, core.message, core.detail_count
  FROM public.__year_end_db_blockers_historical_core_20260729(
    p_company_id, p_fiscal_period_id
  ) core
  WHERE core.code <> 'unfinished_sie_imports';

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

-- Invalidate accepted external/open-item verification when the canonical
-- ledger changes. The invalidation itself is append-only.
CREATE OR REPLACE FUNCTION public.invalidate_historical_support_from_entry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_entry public.journal_entries%ROWTYPE;
BEGIN
  v_entry := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF v_entry.status NOT IN ('posted', 'reversed') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  INSERT INTO public.year_end_external_ar_reconciliation_invalidations (
    reconciliation_id, company_id, reason
  )
  SELECT er.id, er.company_id,
    format('Huvudboken ändrades genom verifikation %s.', v_entry.id)
  FROM public.year_end_external_ar_reconciliations er
  WHERE er.company_id = v_entry.company_id
    AND v_entry.entry_date <= er.balance_date
    AND NOT EXISTS (
      SELECT 1 FROM public.year_end_external_ar_reconciliation_invalidations i
      WHERE i.reconciliation_id = er.id
    )
    AND EXISTS (
      SELECT 1
      FROM public.journal_entry_lines jel
      JOIN public.year_end_control_accounts ca
        ON ca.company_id = er.company_id
       AND ca.control_category = 'customer_receivables'
       AND ca.account_number = jel.account_number
       AND ca.active
      WHERE jel.journal_entry_id = v_entry.id
    )
  ON CONFLICT (reconciliation_id) DO NOTHING;

  INSERT INTO public.year_end_external_ap_reconciliation_invalidations (
    reconciliation_id, company_id, reason
  )
  SELECT er.id, er.company_id,
    format('Huvudboken ändrades genom verifikation %s.', v_entry.id)
  FROM public.year_end_external_ap_reconciliations er
  WHERE er.company_id = v_entry.company_id
    AND v_entry.entry_date <= er.balance_date
    AND NOT EXISTS (
      SELECT 1 FROM public.year_end_external_ap_reconciliation_invalidations i
      WHERE i.reconciliation_id = er.id
    )
    AND EXISTS (
      SELECT 1
      FROM public.journal_entry_lines jel
      JOIN public.year_end_control_accounts ca
        ON ca.company_id = er.company_id
       AND ca.control_category = 'supplier_payables'
       AND ca.account_number = jel.account_number
       AND ca.active
      WHERE jel.journal_entry_id = v_entry.id
    )
  ON CONFLICT (reconciliation_id) DO NOTHING;

  INSERT INTO public.historical_equity_reconciliation_invalidations (
    reconciliation_id, company_id, reason
  )
  SELECT r.id, r.company_id,
    format('Huvudboken ändrades genom verifikation %s.', v_entry.id)
  FROM public.historical_equity_reconciliations r
  WHERE r.company_id = v_entry.company_id
    AND v_entry.entry_date <= r.balance_date
    AND NOT EXISTS (
      SELECT 1 FROM public.historical_equity_reconciliation_invalidations i
      WHERE i.reconciliation_id = r.id
    )
    AND EXISTS (
      SELECT 1
      FROM public.journal_entry_lines jel
      JOIN public.year_end_control_accounts ca
        ON ca.company_id = r.company_id
       AND ca.control_category = 'equity_accounts'
       AND ca.account_number = jel.account_number
       AND ca.active
      WHERE jel.journal_entry_id = v_entry.id
    )
  ON CONFLICT (reconciliation_id) DO NOTHING;

  INSERT INTO public.historical_tax_reconciliation_invalidations (
    reconciliation_id, company_id, reason
  )
  SELECT r.id, r.company_id,
    format('Huvudboken ändrades genom verifikation %s.', v_entry.id)
  FROM public.historical_tax_reconciliations r
  WHERE r.company_id = v_entry.company_id
    AND v_entry.entry_date <= r.balance_date
    AND NOT EXISTS (
      SELECT 1 FROM public.historical_tax_reconciliation_invalidations i
      WHERE i.reconciliation_id = r.id
    )
    AND EXISTS (
      SELECT 1
      FROM public.journal_entry_lines jel
      JOIN public.year_end_control_accounts ca
        ON ca.company_id = r.company_id
       AND ca.control_category = 'tax_accounts'
       AND ca.account_number = jel.account_number
       AND ca.active
      WHERE jel.journal_entry_id = v_entry.id
    )
  ON CONFLICT (reconciliation_id) DO NOTHING;

  INSERT INTO public.historical_vat_reconciliation_invalidations (
    reconciliation_id, company_id, reason
  )
  SELECT r.id, r.company_id,
    format('Huvudboken ändrades genom verifikation %s.', v_entry.id)
  FROM public.historical_vat_reconciliations r
  WHERE r.company_id = v_entry.company_id
    AND v_entry.entry_date <= r.balance_date
    AND NOT EXISTS (
      SELECT 1 FROM public.historical_vat_reconciliation_invalidations i
      WHERE i.reconciliation_id = r.id
    )
    AND EXISTS (
      SELECT 1
      FROM public.journal_entry_lines jel
      JOIN public.year_end_control_accounts ca
        ON ca.company_id = r.company_id
       AND ca.control_category = 'vat_accounts'
       AND ca.account_number = jel.account_number
       AND ca.active
      WHERE jel.journal_entry_id = v_entry.id
    )
  ON CONFLICT (reconciliation_id) DO NOTHING;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS invalidate_historical_support_from_entry
  ON public.journal_entries;
CREATE TRIGGER invalidate_historical_support_from_entry
  AFTER INSERT OR UPDATE OF status ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.invalidate_historical_support_from_entry();

CREATE OR REPLACE FUNCTION public.invalidate_historical_support_from_sie_import()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status NOT IN ('replaced', 'undone')
     OR OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.year_end_external_ar_reconciliation_invalidations (
    reconciliation_id, company_id, reason
  )
  SELECT r.id, r.company_id,
    format('Källimporten %s fick status %s.', NEW.id, NEW.status)
  FROM public.year_end_external_ar_reconciliations r
  WHERE r.source_sie_import_id = NEW.id
  ON CONFLICT (reconciliation_id) DO NOTHING;

  INSERT INTO public.year_end_external_ap_reconciliation_invalidations (
    reconciliation_id, company_id, reason
  )
  SELECT r.id, r.company_id,
    format('Källimporten %s fick status %s.', NEW.id, NEW.status)
  FROM public.year_end_external_ap_reconciliations r
  WHERE r.source_sie_import_id = NEW.id
  ON CONFLICT (reconciliation_id) DO NOTHING;

  INSERT INTO public.historical_equity_reconciliation_invalidations (
    reconciliation_id, company_id, reason
  )
  SELECT r.id, r.company_id,
    format('Överlappande SIE-import %s fick status %s.', NEW.id, NEW.status)
  FROM public.historical_equity_reconciliations r
  JOIN public.fiscal_periods fp ON fp.id = r.fiscal_period_id
  WHERE r.company_id = NEW.company_id
    AND daterange(NEW.fiscal_year_start, NEW.fiscal_year_end, '[]')
      && daterange(fp.period_start, fp.period_end, '[]')
  ON CONFLICT (reconciliation_id) DO NOTHING;

  INSERT INTO public.historical_tax_reconciliation_invalidations (
    reconciliation_id, company_id, reason
  )
  SELECT r.id, r.company_id,
    format('Överlappande SIE-import %s fick status %s.', NEW.id, NEW.status)
  FROM public.historical_tax_reconciliations r
  JOIN public.fiscal_periods fp ON fp.id = r.fiscal_period_id
  WHERE r.company_id = NEW.company_id
    AND daterange(NEW.fiscal_year_start, NEW.fiscal_year_end, '[]')
      && daterange(fp.period_start, fp.period_end, '[]')
  ON CONFLICT (reconciliation_id) DO NOTHING;

  INSERT INTO public.historical_vat_reconciliation_invalidations (
    reconciliation_id, company_id, reason
  )
  SELECT r.id, r.company_id,
    format('Överlappande SIE-import %s fick status %s.', NEW.id, NEW.status)
  FROM public.historical_vat_reconciliations r
  JOIN public.fiscal_periods fp ON fp.id = r.fiscal_period_id
  WHERE r.company_id = NEW.company_id
    AND daterange(NEW.fiscal_year_start, NEW.fiscal_year_end, '[]')
      && daterange(fp.period_start, fp.period_end, '[]')
  ON CONFLICT (reconciliation_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invalidate_historical_support_from_sie_import
  ON public.sie_imports;
CREATE TRIGGER invalidate_historical_support_from_sie_import
  AFTER UPDATE OF status ON public.sie_imports
  FOR EACH ROW EXECUTE FUNCTION public.invalidate_historical_support_from_sie_import();

-- Atomic 2099 -> 2098 transfer after close. The current close RPC is wrapped,
-- so the transfer is in the same transaction and its idempotency is covered by
-- the same advisory lock.
CREATE OR REPLACE FUNCTION public.__year_end_prior_result_transfer(
  p_company_id uuid,
  p_next_period_id uuid,
  p_user_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period public.fiscal_periods%ROWTYPE;
  v_entity_type text;
  v_net numeric;
  v_amount numeric;
  v_imported_entry uuid;
  v_entry_id uuid;
BEGIN
  SELECT fp.* INTO v_period
  FROM public.fiscal_periods fp
  WHERE fp.id = p_next_period_id
    AND fp.company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT c.entity_type INTO v_entity_type
  FROM public.companies c
  WHERE c.id = p_company_id;
  IF v_entity_type <> 'aktiebolag' THEN RETURN NULL; END IF;

  IF EXISTS (
    SELECT 1
    FROM public.year_end_equity_events e
    WHERE e.company_id = p_company_id
      AND e.fiscal_period_id = p_next_period_id
      AND e.event_type = 'prior_year_result_transfer'
  ) THEN
    RETURN NULL;
  END IF;

  SELECT round(coalesce(sum(jel.credit_amount - jel.debit_amount), 0), 2)
    INTO v_net
  FROM public.journal_entry_lines jel
  WHERE jel.journal_entry_id = v_period.opening_balance_entry_id
    AND jel.account_number = '2099';
  IF abs(v_net) < 0.01 THEN RETURN NULL; END IF;
  v_amount := abs(v_net);

  SELECT je.id INTO v_imported_entry
  FROM public.journal_entries je
  WHERE je.company_id = p_company_id
    AND je.fiscal_period_id = p_next_period_id
    AND je.status IN ('posted', 'reversed')
    AND je.sie_import_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.journal_entry_lines l
      WHERE l.journal_entry_id = je.id
        AND l.account_number IN ('2098', '2099')
      GROUP BY l.journal_entry_id
      HAVING abs(
        sum(CASE WHEN l.account_number = '2099'
          THEN l.credit_amount - l.debit_amount ELSE 0 END)
        + v_net
      ) < 0.01
      AND abs(
        sum(CASE WHEN l.account_number = '2098'
          THEN l.credit_amount - l.debit_amount ELSE 0 END)
        - v_net
      ) < 0.01
    )
  ORDER BY je.entry_date, je.id
  LIMIT 1;

  IF v_imported_entry IS NOT NULL THEN
    INSERT INTO public.year_end_equity_events (
      company_id, fiscal_period_id, event_type, amount,
      journal_entry_id, source_sie_import_id, historical_link_only,
      metadata, created_by
    )
    SELECT
      p_company_id, p_next_period_id, 'prior_year_result_transfer',
      v_amount, v_imported_entry, je.sie_import_id, true,
      jsonb_build_object('recognition_status', 'already_booked'), p_user_id
    FROM public.journal_entries je
    WHERE je.id = v_imported_entry;
    RETURN v_imported_entry;
  END IF;

  INSERT INTO public.journal_entries (
    company_id, user_id, fiscal_period_id, voucher_number, voucher_series,
    entry_date, description, source_type, status
  ) VALUES (
    p_company_id, p_user_id, p_next_period_id, 0, 'A',
    v_period.period_start,
    'Omföring av föregående års resultat (2099 → 2098)',
    'result_appropriation', 'draft'
  ) RETURNING id INTO v_entry_id;

  IF v_net > 0 THEN
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, account_number, debit_amount, credit_amount,
      line_description, sort_order
    ) VALUES
      (v_entry_id, '2099', v_amount, 0, 'Omföring av föregående års resultat', 0),
      (v_entry_id, '2098', 0, v_amount, 'Föregående års resultat', 1);
  ELSE
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, account_number, debit_amount, credit_amount,
      line_description, sort_order
    ) VALUES
      (v_entry_id, '2098', v_amount, 0, 'Föregående års resultat', 0),
      (v_entry_id, '2099', 0, v_amount, 'Omföring av föregående års resultat', 1);
  END IF;

  PERFORM public.commit_journal_entry(
    p_company_id, v_entry_id, 'system', 'prior-year-result-transfer', 'system',
    'execute_year_end_closing'
  );

  INSERT INTO public.year_end_equity_events (
    company_id, fiscal_period_id, event_type, amount,
    journal_entry_id, historical_link_only, metadata, created_by
  ) VALUES (
    p_company_id, p_next_period_id, 'prior_year_result_transfer', v_amount,
    v_entry_id, false, jsonb_build_object('created_atomically', true), p_user_id
  );
  RETURN v_entry_id;
END;
$$;

REVOKE ALL ON FUNCTION public.__year_end_prior_result_transfer(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF to_regprocedure(
    'public.__execute_year_end_closing_result_transfer_core_20260729(uuid,uuid,uuid,text,jsonb)'
  ) IS NULL THEN
    ALTER FUNCTION public.execute_year_end_closing(uuid, uuid, uuid, text, jsonb)
      RENAME TO __execute_year_end_closing_result_transfer_core_20260729;
  END IF;
END
$$;

REVOKE ALL ON FUNCTION
  public.__execute_year_end_closing_result_transfer_core_20260729(
    uuid, uuid, uuid, text, jsonb
  ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.__execute_year_end_closing_result_transfer_core_20260729(
    uuid, uuid, uuid, text, jsonb
  ) TO service_role;

CREATE OR REPLACE FUNCTION public.execute_year_end_closing(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_user_id uuid,
  p_idempotency_key text,
  p_revaluation jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
  v_actor uuid := coalesce(auth.uid(), p_user_id);
  v_transfer_id uuid;
BEGIN
  v_result :=
    public.__execute_year_end_closing_result_transfer_core_20260729(
      p_company_id,
      p_fiscal_period_id,
      p_user_id,
      p_idempotency_key,
      p_revaluation
    );

  UPDATE public.year_end_profit_dispositions
  SET status = 'locked',
      locked_at = coalesce(locked_at, now())
  WHERE company_id = p_company_id
    AND fiscal_period_id = p_fiscal_period_id
    AND status IN ('approved', 'locked');

  v_transfer_id := public.__year_end_prior_result_transfer(
    p_company_id,
    (v_result->>'next_period_id')::uuid,
    v_actor
  );
  RETURN v_result || jsonb_build_object(
    'prior_result_transfer_entry_id',
    v_transfer_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.execute_year_end_closing(
  uuid, uuid, uuid, text, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.execute_year_end_closing(
  uuid, uuid, uuid, text, jsonb
) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
