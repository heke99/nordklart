-- Annual-report lifecycle, verified comparatives and controlled fiscal-year reopen.
--
-- Accounting data and annual-report document data deliberately have separate
-- locks. Posted ledger rows remain immutable; a controlled reopen creates
-- storno entries and preserves every prior annual-report version.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Explicit ledger lock mirror and document-only narrative fields
-- ---------------------------------------------------------------------------
ALTER TABLE public.fiscal_periods
  ADD COLUMN IF NOT EXISTS ledger_locked boolean NOT NULL DEFAULT false;

UPDATE public.fiscal_periods
SET ledger_locked = (is_closed OR locked_at IS NOT NULL OR closing_entry_id IS NOT NULL)
WHERE ledger_locked IS DISTINCT FROM (is_closed OR locked_at IS NOT NULL OR closing_entry_id IS NOT NULL);

CREATE OR REPLACE FUNCTION public.sync_fiscal_period_ledger_lock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.ledger_locked := NEW.is_closed OR NEW.locked_at IS NOT NULL OR NEW.closing_entry_id IS NOT NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_fiscal_period_ledger_lock ON public.fiscal_periods;
CREATE TRIGGER sync_fiscal_period_ledger_lock
  BEFORE INSERT OR UPDATE OF is_closed, locked_at, closing_entry_id
  ON public.fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION public.sync_fiscal_period_ledger_lock();

ALTER TABLE public.arsredovisning_narratives
  ADD COLUMN IF NOT EXISTS events_after_balance_sheet text,
  ADD COLUMN IF NOT EXISTS report_legal_name text,
  ADD COLUMN IF NOT EXISTS report_registered_office text,
  ADD COLUMN IF NOT EXISTS prior_legal_name text,
  ADD COLUMN IF NOT EXISTS agm_accounts_adopted boolean,
  ADD COLUMN IF NOT EXISTS agm_result_disposition_decision text,
  ADD COLUMN IF NOT EXISTS certificate_signer_name text,
  ADD COLUMN IF NOT EXISTS certificate_signer_role text,
  ADD COLUMN IF NOT EXISTS certificate_signed_at date;

ALTER TABLE public.arsredovisning_narratives
  DROP CONSTRAINT IF EXISTS arsredovisning_narratives_events_after_balance_sheet_length,
  DROP CONSTRAINT IF EXISTS arsredovisning_narratives_report_legal_name_length,
  DROP CONSTRAINT IF EXISTS arsredovisning_narratives_report_registered_office_length,
  DROP CONSTRAINT IF EXISTS arsredovisning_narratives_prior_legal_name_length,
  DROP CONSTRAINT IF EXISTS arsredovisning_narratives_agm_decision_length,
  DROP CONSTRAINT IF EXISTS arsredovisning_narratives_certificate_name_length,
  DROP CONSTRAINT IF EXISTS arsredovisning_narratives_certificate_role_length;
ALTER TABLE public.arsredovisning_narratives
  ADD CONSTRAINT arsredovisning_narratives_events_after_balance_sheet_length
    CHECK (events_after_balance_sheet IS NULL OR length(events_after_balance_sheet) <= 4000),
  ADD CONSTRAINT arsredovisning_narratives_report_legal_name_length
    CHECK (report_legal_name IS NULL OR length(report_legal_name) <= 200),
  ADD CONSTRAINT arsredovisning_narratives_report_registered_office_length
    CHECK (report_registered_office IS NULL OR length(report_registered_office) <= 100),
  ADD CONSTRAINT arsredovisning_narratives_prior_legal_name_length
    CHECK (prior_legal_name IS NULL OR length(prior_legal_name) <= 200),
  ADD CONSTRAINT arsredovisning_narratives_agm_decision_length
    CHECK (agm_result_disposition_decision IS NULL OR length(agm_result_disposition_decision) <= 2000),
  ADD CONSTRAINT arsredovisning_narratives_certificate_name_length
    CHECK (certificate_signer_name IS NULL OR length(certificate_signer_name) <= 200),
  ADD CONSTRAINT arsredovisning_narratives_certificate_role_length
    CHECK (certificate_signer_role IS NULL OR length(certificate_signer_role) <= 100);

-- ---------------------------------------------------------------------------
-- 2. Annual-report project and immutable versions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.annual_report_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'ready_for_finalization', 'final', 'signed', 'filed',
    'registered', 'superseded'
  )),
  annual_report_locked boolean NOT NULL DEFAULT false,
  document_revision bigint NOT NULL DEFAULT 0 CHECK (document_revision >= 0),
  preflight_status text NOT NULL DEFAULT 'not_run' CHECK (preflight_status IN (
    'not_run', 'failed', 'passed'
  )),
  blocking_issue_count integer NOT NULL DEFAULT 0 CHECK (blocking_issue_count >= 0),
  current_version_id uuid,
  submission_blocked boolean NOT NULL DEFAULT true,
  invalidated_reason text,
  invalidated_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, fiscal_period_id)
);

ALTER TABLE public.annual_report_projects
  ADD COLUMN IF NOT EXISTS document_revision bigint NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.annual_report_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.annual_report_projects(id) ON DELETE RESTRICT,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE CASCADE,
  version_number integer NOT NULL CHECK (version_number > 0),
  status text NOT NULL CHECK (status IN (
    'draft', 'ready_for_finalization', 'final', 'signed', 'filed',
    'registered', 'superseded'
  )),
  canonical_snapshot jsonb NOT NULL,
  formal_report_snapshot jsonb,
  core_amounts jsonb NOT NULL,
  validation_report jsonb NOT NULL,
  pdf_document_id uuid NOT NULL REFERENCES public.document_attachments(id) ON DELETE RESTRICT,
  ixbrl_document_id uuid REFERENCES public.document_attachments(id) ON DELETE RESTRICT,
  pdf_sha256 text NOT NULL CHECK (pdf_sha256 ~ '^[0-9a-f]{64}$'),
  ixbrl_sha256 text CHECK (ixbrl_sha256 IS NULL OR ixbrl_sha256 ~ '^[0-9a-f]{64}$'),
  combined_sha256 text NOT NULL CHECK (combined_sha256 ~ '^[0-9a-f]{64}$'),
  finalized_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  finalized_at timestamptz,
  signed_at timestamptz,
  filed_at timestamptz,
  registered_at timestamptz,
  superseded_by_id uuid REFERENCES public.annual_report_versions(id) ON DELETE RESTRICT,
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, version_number)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'annual_report_projects_current_version_fk'
  ) THEN
    ALTER TABLE public.annual_report_projects
      ADD CONSTRAINT annual_report_projects_current_version_fk
      FOREIGN KEY (current_version_id)
      REFERENCES public.annual_report_versions(id)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS annual_report_one_live_final_version
  ON public.annual_report_versions(project_id)
  WHERE status IN ('final', 'signed', 'filed', 'registered') AND superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS annual_report_versions_period_idx
  ON public.annual_report_versions(company_id, fiscal_period_id, version_number DESC);

CREATE TABLE IF NOT EXISTS public.annual_report_comparative_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  source_fiscal_period_id uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE CASCADE,
  source_version_id uuid REFERENCES public.annual_report_versions(id) ON DELETE SET NULL,
  source_type text NOT NULL CHECK (source_type IN (
    'established_annual_report', 'final_report_snapshot', 'manually_verified'
  )),
  source_label text NOT NULL,
  formal_report_snapshot jsonb,
  overview_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  verified_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  verified_at timestamptz NOT NULL,
  is_current boolean NOT NULL DEFAULT true,
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS annual_report_one_current_comparative_source
  ON public.annual_report_comparative_snapshots(company_id, source_fiscal_period_id)
  WHERE is_current AND superseded_at IS NULL;

CREATE TABLE IF NOT EXISTS public.annual_report_presentation_reclassifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.annual_report_projects(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE CASCADE,
  account_number text NOT NULL,
  source_concept text NOT NULL,
  target_concept text NOT NULL,
  original_presentation text NOT NULL,
  target_presentation text NOT NULL,
  amount numeric(18,2) NOT NULL,
  reason text NOT NULL CHECK (length(trim(reason)) >= 10),
  creates_journal_entry boolean NOT NULL DEFAULT false CHECK (creates_journal_entry = false),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  revocation_reason text CHECK (revocation_reason IS NULL OR length(trim(revocation_reason)) >= 10),
  CHECK (account_number ~ '^[0-9]{4}$')
);
CREATE INDEX IF NOT EXISTS annual_report_reclassifications_period_idx
  ON public.annual_report_presentation_reclassifications(company_id, fiscal_period_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS public.annual_report_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES public.annual_report_projects(id) ON DELETE SET NULL,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  affects_ledger boolean NOT NULL DEFAULT false,
  previous_value jsonb,
  new_value jsonb,
  reason text,
  report_version_id uuid REFERENCES public.annual_report_versions(id) ON DELETE SET NULL,
  document_hash text,
  checks_run jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS annual_report_audit_period_idx
  ON public.annual_report_audit_events(company_id, fiscal_period_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 3. Controlled fiscal-year reopen requests
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fiscal_period_reopen_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (length(trim(reason)) >= 10),
  requested_changes jsonb NOT NULL CHECK (jsonb_typeof(requested_changes) = 'array'),
  annual_report_already_filed boolean NOT NULL,
  tax_return_already_filed boolean NOT NULL,
  approval_note text,
  designated_approver_name text NOT NULL CHECK (length(trim(designated_approver_name)) >= 2),
  requested_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN (
    'requested', 'approved', 'reopening', 'reopened', 'rejected', 'blocked', 'failed'
  )),
  period_snapshot jsonb NOT NULL,
  annual_report_snapshot jsonb,
  closing_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  closing_reversal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  opening_balance_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  opening_balance_reversal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  error_code text,
  error_message text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  reopened_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fiscal_period_reopen_requests_period_idx
  ON public.fiscal_period_reopen_requests(company_id, fiscal_period_id, requested_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS fiscal_period_one_active_reopen_request
  ON public.fiscal_period_reopen_requests(company_id, fiscal_period_id)
  WHERE status IN ('requested', 'approved', 'reopening');

ALTER TABLE public.year_end_runs
  ADD COLUMN IF NOT EXISTS reopen_request_id uuid REFERENCES public.fiscal_period_reopen_requests(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reopening_reversal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reopened_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reopened_at timestamptz;

-- ---------------------------------------------------------------------------
-- 4. RLS. Reads use canonical tenant access; writes require can_write.
-- ---------------------------------------------------------------------------
ALTER TABLE public.annual_report_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.annual_report_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.annual_report_comparative_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.annual_report_presentation_reclassifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.annual_report_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fiscal_period_reopen_requests ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'annual_report_projects',
    'annual_report_versions',
    'annual_report_comparative_snapshots',
    'annual_report_presentation_reclassifications',
    'annual_report_audit_events',
    'fiscal_period_reopen_requests'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_select ON public.%I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_select ON public.%I FOR SELECT USING (public.user_can_access_company_v2(company_id))',
      t, t
    );
  END LOOP;
END $$;

DROP POLICY IF EXISTS annual_report_projects_insert ON public.annual_report_projects;
CREATE POLICY annual_report_projects_insert ON public.annual_report_projects
  FOR INSERT WITH CHECK (
    public.user_can_write_company(company_id)
    AND status = 'draft'
    AND annual_report_locked = false
    AND preflight_status = 'not_run'
    AND blocking_issue_count = 0
    AND current_version_id IS NULL
    AND submission_blocked = true
    AND created_by = auth.uid()
  );
-- Project lifecycle changes are security-definer RPC only. A tenant writer may
-- create a draft project, but cannot self-declare it final or unlock a final.
DROP POLICY IF EXISTS annual_report_projects_update ON public.annual_report_projects;

-- Immutable version rows and verified comparative snapshots are written only
-- by the atomic security-definer RPCs below. This prevents bypassing preflight
-- with direct PostgREST inserts or status updates.
DROP POLICY IF EXISTS annual_report_versions_insert ON public.annual_report_versions;
DROP POLICY IF EXISTS annual_report_versions_update ON public.annual_report_versions;
DROP POLICY IF EXISTS annual_report_comparatives_insert ON public.annual_report_comparative_snapshots;
DROP POLICY IF EXISTS annual_report_comparatives_update ON public.annual_report_comparative_snapshots;

-- Presentation reclassifications are validated by the server route and then
-- written with the service role. Direct tenant writes would bypass account
-- direction, source-concept and balance-preservation checks.
DROP POLICY IF EXISTS annual_report_reclassifications_insert ON public.annual_report_presentation_reclassifications;
DROP POLICY IF EXISTS annual_report_reclassifications_update ON public.annual_report_presentation_reclassifications;

DROP POLICY IF EXISTS annual_report_audit_insert ON public.annual_report_audit_events;
-- Audit rows are security-definer/trigger only and append-only. Tenant clients
-- cannot fabricate audit history through direct PostgREST writes.

DROP POLICY IF EXISTS fiscal_period_reopen_requests_insert ON public.fiscal_period_reopen_requests;
CREATE POLICY fiscal_period_reopen_requests_insert ON public.fiscal_period_reopen_requests
  FOR INSERT WITH CHECK (
    public.user_can_write_company(company_id)
    AND requested_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.resolve_company_access(company_id) access
      WHERE access.effective_role IN ('platform_admin', 'company_owner', 'company_admin', 'accountant')
    )
    AND approved_by IS NULL
    AND status IN ('requested', 'blocked')
  );
-- Approval/reopen state transitions are security-definer RPC only.
DROP POLICY IF EXISTS fiscal_period_reopen_requests_update ON public.fiscal_period_reopen_requests;

-- Document-data writes are independent of the ledger lock, but a locked
-- annual-report version is immutable until create_new_annual_report_draft()
-- explicitly unlocks the project.
CREATE OR REPLACE FUNCTION public.enforce_annual_report_document_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_fiscal_period_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_company_id := OLD.company_id;
    v_fiscal_period_id := OLD.fiscal_period_id;
  ELSE
    v_company_id := NEW.company_id;
    v_fiscal_period_id := NEW.fiscal_period_id;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.annual_report_projects arp
    WHERE arp.company_id = v_company_id
      AND arp.fiscal_period_id = v_fiscal_period_id
      AND arp.annual_report_locked
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ANNUAL_REPORT_LOCKED_CREATE_NEW_VERSION_REQUIRED';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_annual_report_narrative_lock ON public.arsredovisning_narratives;
CREATE TRIGGER enforce_annual_report_narrative_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.arsredovisning_narratives
  FOR EACH ROW EXECUTE FUNCTION public.enforce_annual_report_document_lock();
DROP TRIGGER IF EXISTS enforce_annual_report_signature_lock ON public.arsredovisning_signature_requests;
CREATE TRIGGER enforce_annual_report_signature_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.arsredovisning_signature_requests
  FOR EACH ROW EXECUTE FUNCTION public.enforce_annual_report_document_lock();

DROP TRIGGER IF EXISTS enforce_annual_report_reclassification_lock ON public.annual_report_presentation_reclassifications;
CREATE TRIGGER enforce_annual_report_reclassification_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.annual_report_presentation_reclassifications
  FOR EACH ROW EXECUTE FUNCTION public.enforce_annual_report_document_lock();

CREATE OR REPLACE FUNCTION public.enforce_annual_report_reclassification_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ANNUAL_REPORT_RECLASSIFICATION_IMMUTABLE';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ANNUAL_REPORT_RECLASSIFICATION_IMMUTABLE';
  END IF;
  IF NEW.revoked_at IS NULL OR NEW.revoked_by IS NULL OR NEW.revocation_reason IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ANNUAL_REPORT_RECLASSIFICATION_REVOKE_FIELDS_REQUIRED';
  END IF;
  IF (to_jsonb(NEW) - 'revoked_at' - 'revoked_by' - 'revocation_reason')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'revoked_at' - 'revoked_by' - 'revocation_reason') THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ANNUAL_REPORT_RECLASSIFICATION_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS enforce_annual_report_reclassification_immutability
  ON public.annual_report_presentation_reclassifications;
CREATE TRIGGER enforce_annual_report_reclassification_immutability
  BEFORE UPDATE OR DELETE ON public.annual_report_presentation_reclassifications
  FOR EACH ROW EXECUTE FUNCTION public.enforce_annual_report_reclassification_immutability();

CREATE OR REPLACE FUNCTION public.audit_annual_report_document_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_fiscal_period_id uuid;
  v_project_id uuid;
  v_previous jsonb;
  v_new jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_company_id := OLD.company_id;
    v_fiscal_period_id := OLD.fiscal_period_id;
  ELSE
    v_company_id := NEW.company_id;
    v_fiscal_period_id := NEW.fiscal_period_id;
  END IF;
  SELECT id INTO v_project_id
  FROM public.annual_report_projects
  WHERE company_id = v_company_id AND fiscal_period_id = v_fiscal_period_id;

  v_previous := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) ELSE NULL END;
  v_new := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) ELSE NULL END;
  -- BankID response material is evidence in its source table, but must not be
  -- duplicated into a broad audit payload.
  IF TG_TABLE_NAME = 'arsredovisning_signature_requests' THEN
    v_previous := v_previous - 'bankid_signature_data';
    v_new := v_new - 'bankid_signature_data';
  END IF;

  IF v_project_id IS NOT NULL THEN
    UPDATE public.annual_report_projects
    SET document_revision = document_revision + 1, updated_at = now()
    WHERE id = v_project_id;
  END IF;

  INSERT INTO public.annual_report_audit_events(
    project_id, company_id, fiscal_period_id, actor_user_id, event_type,
    affects_ledger, previous_value, new_value, reason
  ) VALUES (
    v_project_id, v_company_id, v_fiscal_period_id,
    coalesce(
      auth.uid(),
      CASE
        WHEN TG_TABLE_NAME = 'annual_report_presentation_reclassifications'
          AND TG_OP = 'INSERT' THEN NEW.created_by
        WHEN TG_TABLE_NAME = 'annual_report_presentation_reclassifications'
          AND TG_OP = 'UPDATE' THEN NEW.revoked_by
        ELSE NULL
      END
    ),
    TG_TABLE_NAME || '_' || lower(TG_OP), false, v_previous, v_new,
    'Dokumentuppgift ändrad utan påverkan på huvudboken.'
  );
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_annual_report_narrative_change ON public.arsredovisning_narratives;
CREATE TRIGGER audit_annual_report_narrative_change
  AFTER INSERT OR UPDATE OR DELETE ON public.arsredovisning_narratives
  FOR EACH ROW EXECUTE FUNCTION public.audit_annual_report_document_change();
DROP TRIGGER IF EXISTS audit_annual_report_signature_change ON public.arsredovisning_signature_requests;
CREATE TRIGGER audit_annual_report_signature_change
  AFTER INSERT OR UPDATE OR DELETE ON public.arsredovisning_signature_requests
  FOR EACH ROW EXECUTE FUNCTION public.audit_annual_report_document_change();

DROP TRIGGER IF EXISTS audit_annual_report_reclassification_change
  ON public.annual_report_presentation_reclassifications;
CREATE TRIGGER audit_annual_report_reclassification_change
  AFTER INSERT OR UPDATE OR DELETE ON public.annual_report_presentation_reclassifications
  FOR EACH ROW EXECUTE FUNCTION public.audit_annual_report_document_change();

-- ---------------------------------------------------------------------------
-- 5. Immutable final versions, with a narrow supersession transition.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_annual_report_version_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ANNUAL_REPORT_VERSION_IMMUTABLE';
  END IF;
  IF OLD.status IN ('final', 'signed', 'filed', 'registered', 'superseded') THEN
    IF OLD.status IN ('final', 'signed')
       AND NEW.status = 'superseded'
       AND NEW.superseded_at IS NOT NULL
       AND NEW.superseded_by_id IS NOT NULL
       AND (to_jsonb(NEW) - 'status' - 'superseded_at' - 'superseded_by_id')
           = (to_jsonb(OLD) - 'status' - 'superseded_at' - 'superseded_by_id') THEN
      RETURN NEW;
    END IF;
    IF OLD.status = 'final'
       AND NEW.status = 'signed'
       AND NEW.signed_at IS NOT NULL
       AND (to_jsonb(NEW) - 'status' - 'signed_at')
           = (to_jsonb(OLD) - 'status' - 'signed_at') THEN
      RETURN NEW;
    END IF;
    IF OLD.status = 'signed'
       AND NEW.status = 'filed'
       AND NEW.filed_at IS NOT NULL
       AND (to_jsonb(NEW) - 'status' - 'filed_at')
           = (to_jsonb(OLD) - 'status' - 'filed_at') THEN
      RETURN NEW;
    END IF;
    IF OLD.status = 'filed'
       AND NEW.status = 'registered'
       AND NEW.registered_at IS NOT NULL
       AND (to_jsonb(NEW) - 'status' - 'registered_at')
           = (to_jsonb(OLD) - 'status' - 'registered_at') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'ANNUAL_REPORT_VERSION_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_annual_report_version_immutability ON public.annual_report_versions;
CREATE TRIGGER enforce_annual_report_version_immutability
  BEFORE UPDATE OR DELETE ON public.annual_report_versions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_annual_report_version_immutability();

-- Replace the old period-metadata trigger with a GUC-gated carve-out used only
-- by approve_fiscal_period_reopen(). Normal updates remain immutable.
CREATE OR REPLACE FUNCTION public.enforce_opening_balance_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_setting('nordklart.allow_controlled_year_end_reopen', true) = 'true' THEN
    RETURN NEW;
  END IF;
  IF OLD.opening_balance_entry_id IS NOT NULL
     AND OLD.opening_balances_set = true
     AND NEW.opening_balance_entry_id IS DISTINCT FROM OLD.opening_balance_entry_id THEN
    RAISE EXCEPTION 'Cannot modify opening_balance_entry_id on period "%" — opening balances are immutable once set', OLD.name;
  END IF;
  IF OLD.closing_entry_id IS NOT NULL
     AND NEW.closing_entry_id IS DISTINCT FROM OLD.closing_entry_id THEN
    RAISE EXCEPTION 'Cannot modify closing_entry_id on period "%" — year-end closing is immutable', OLD.name;
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Persisted preflight and atomic final-version registration.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_annual_report_preflight(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_actor_user_id uuid,
  p_preflight_report jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_project public.annual_report_projects%ROWTYPE;
  v_status text;
  v_blockers integer;
BEGIN
  IF auth.uid() IS DISTINCT FROM p_actor_user_id
     OR NOT public.user_can_write_company(p_company_id) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'ANNUAL_REPORT_ACCESS_DENIED';
  END IF;
  v_status := COALESCE(p_preflight_report->>'preflight_status', 'failed');
  v_blockers := COALESCE((p_preflight_report->>'blocking_issue_count')::integer, 0);
  IF v_status NOT IN ('passed', 'failed') OR v_blockers < 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'ANNUAL_REPORT_PREFLIGHT_INVALID';
  END IF;

  INSERT INTO public.annual_report_projects(
    company_id, fiscal_period_id, status, annual_report_locked,
    preflight_status, blocking_issue_count, submission_blocked,
    created_by, updated_by
  ) VALUES (
    p_company_id, p_fiscal_period_id, 'draft', false,
    'not_run', 0, true, p_actor_user_id, p_actor_user_id
  )
  ON CONFLICT (company_id, fiscal_period_id) DO NOTHING;

  SELECT * INTO v_project
  FROM public.annual_report_projects
  WHERE company_id = p_company_id AND fiscal_period_id = p_fiscal_period_id
  FOR UPDATE;
  IF v_project.annual_report_locked THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ANNUAL_REPORT_LOCKED_CREATE_NEW_VERSION_REQUIRED';
  END IF;

  UPDATE public.annual_report_projects
  SET status = CASE WHEN v_status = 'passed' AND v_blockers = 0
                    THEN 'ready_for_finalization' ELSE 'draft' END,
      preflight_status = v_status,
      blocking_issue_count = v_blockers,
      submission_blocked = true,
      updated_by = p_actor_user_id,
      updated_at = now()
  WHERE id = v_project.id
  RETURNING * INTO v_project;

  INSERT INTO public.annual_report_audit_events(
    project_id, company_id, fiscal_period_id, actor_user_id, event_type,
    affects_ledger, new_value, checks_run
  ) VALUES (
    v_project.id, p_company_id, p_fiscal_period_id, p_actor_user_id,
    'annual_report_preflight_completed', false,
    jsonb_build_object(
      'preflight_status', v_status,
      'blocking_issue_count', v_blockers,
      'project_status', v_project.status
    ),
    p_preflight_report
  );

  RETURN jsonb_build_object(
    'project_id', v_project.id,
    'status', v_project.status,
    'preflight_status', v_project.preflight_status,
    'blocking_issue_count', v_project.blocking_issue_count
  );
END;
$$;
REVOKE ALL ON FUNCTION public.record_annual_report_preflight(uuid, uuid, uuid, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_annual_report_preflight(uuid, uuid, uuid, jsonb)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.finalize_annual_report_version(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_actor_user_id uuid,
  p_expected_document_revision bigint,
  p_canonical_snapshot jsonb,
  p_formal_report_snapshot jsonb,
  p_core_amounts jsonb,
  p_validation_report jsonb,
  p_pdf_document_id uuid,
  p_ixbrl_document_id uuid,
  p_pdf_sha256 text,
  p_ixbrl_sha256 text,
  p_combined_sha256 text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period public.fiscal_periods%ROWTYPE;
  v_project public.annual_report_projects%ROWTYPE;
  v_previous public.annual_report_versions%ROWTYPE;
  v_version public.annual_report_versions%ROWTYPE;
  v_next integer;
  v_signed_at timestamptz;
  v_pdf public.document_attachments%ROWTYPE;
  v_ixbrl public.document_attachments%ROWTYPE;
BEGIN
  IF coalesce(auth.role(), current_user::text) NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'ANNUAL_REPORT_FINALIZATION_SERVICE_ONLY';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.resolve_company_access_for_user(p_actor_user_id, p_company_id) access
    WHERE access.can_write OR access.can_manage_platform
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'ANNUAL_REPORT_ACCESS_DENIED';
  END IF;
  IF COALESCE(p_validation_report->>'preflight_status', '') <> 'passed'
     OR COALESCE((p_validation_report->>'blocking_issue_count')::integer, -1) <> 0
     OR COALESCE((p_validation_report->>'pdf_ixbrl_match')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ANNUAL_REPORT_PREFLIGHT_REQUIRED';
  END IF;

  SELECT * INTO v_period
  FROM public.fiscal_periods
  WHERE id = p_fiscal_period_id AND company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ANNUAL_REPORT_PERIOD_NOT_FOUND'; END IF;
  IF NOT (v_period.is_closed AND v_period.ledger_locked AND v_period.closing_entry_id IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ANNUAL_REPORT_LEDGER_NOT_LOCKED';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.arsredovisning_signature_requests sr
    WHERE sr.company_id = p_company_id AND sr.fiscal_period_id = p_fiscal_period_id
  ) OR EXISTS (
    SELECT 1 FROM public.arsredovisning_signature_requests sr
    WHERE sr.company_id = p_company_id AND sr.fiscal_period_id = p_fiscal_period_id
      AND (sr.status <> 'signed' OR sr.signed_at IS NULL)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ANNUAL_REPORT_SIGNATURES_INCOMPLETE';
  END IF;
  SELECT max(sr.signed_at) INTO v_signed_at
  FROM public.arsredovisning_signature_requests sr
  WHERE sr.company_id = p_company_id AND sr.fiscal_period_id = p_fiscal_period_id
    AND sr.status = 'signed';

  SELECT * INTO v_pdf
  FROM public.document_attachments
  WHERE id = p_pdf_document_id AND company_id = p_company_id
  FOR SHARE;
  IF NOT FOUND OR v_pdf.sha256_hash IS DISTINCT FROM p_pdf_sha256
     OR v_pdf.mime_type <> 'application/pdf' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ANNUAL_REPORT_PDF_ARCHIVE_MISMATCH';
  END IF;
  SELECT * INTO v_ixbrl
  FROM public.document_attachments
  WHERE id = p_ixbrl_document_id AND company_id = p_company_id
  FOR SHARE;
  IF NOT FOUND OR v_ixbrl.sha256_hash IS DISTINCT FROM p_ixbrl_sha256
     OR v_ixbrl.mime_type NOT IN ('application/xhtml+xml', 'text/html') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ANNUAL_REPORT_IXBRL_ARCHIVE_MISMATCH';
  END IF;

  INSERT INTO public.annual_report_projects(
    company_id, fiscal_period_id, status, annual_report_locked,
    preflight_status, blocking_issue_count, submission_blocked,
    created_by, updated_by
  ) VALUES (
    p_company_id, p_fiscal_period_id, 'draft', false,
    'not_run', 0, true, p_actor_user_id, p_actor_user_id
  )
  ON CONFLICT (company_id, fiscal_period_id) DO NOTHING;

  SELECT * INTO v_project
  FROM public.annual_report_projects
  WHERE company_id = p_company_id AND fiscal_period_id = p_fiscal_period_id
  FOR UPDATE;

  IF v_project.document_revision IS DISTINCT FROM p_expected_document_revision THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'ANNUAL_REPORT_DOCUMENT_CHANGED_DURING_FINALIZATION',
      DETAIL = jsonb_build_object(
        'expected_document_revision', p_expected_document_revision,
        'actual_document_revision', v_project.document_revision
      )::text;
  END IF;

  IF v_project.status IN ('filed', 'registered') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ANNUAL_REPORT_ALREADY_FILED';
  END IF;
  IF v_project.annual_report_locked AND v_project.status NOT IN ('draft', 'ready_for_finalization') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ANNUAL_REPORT_CREATE_NEW_VERSION_REQUIRED';
  END IF;

  SELECT * INTO v_previous
  FROM public.annual_report_versions
  WHERE project_id = v_project.id
    AND status IN ('final', 'signed')
    AND superseded_at IS NULL
  FOR UPDATE;

  SELECT COALESCE(max(version_number), 0) + 1 INTO v_next
  FROM public.annual_report_versions
  WHERE project_id = v_project.id;

  INSERT INTO public.annual_report_versions(
    project_id, company_id, fiscal_period_id, version_number, status,
    canonical_snapshot, formal_report_snapshot, core_amounts, validation_report,
    pdf_document_id, ixbrl_document_id, pdf_sha256, ixbrl_sha256,
    combined_sha256, finalized_by, finalized_at
  ) VALUES (
    v_project.id, p_company_id, p_fiscal_period_id, v_next, 'ready_for_finalization',
    p_canonical_snapshot, p_formal_report_snapshot, p_core_amounts, p_validation_report,
    p_pdf_document_id, p_ixbrl_document_id, p_pdf_sha256, p_ixbrl_sha256,
    p_combined_sha256, p_actor_user_id, now()
  ) RETURNING * INTO v_version;

  IF v_previous.id IS NOT NULL THEN
    UPDATE public.annual_report_versions
    SET status = 'superseded', superseded_at = now(), superseded_by_id = v_version.id
    WHERE id = v_previous.id;
  END IF;

  UPDATE public.annual_report_versions
  SET status = 'signed', signed_at = v_signed_at
  WHERE id = v_version.id
  RETURNING * INTO v_version;

  UPDATE public.annual_report_projects
  SET status = 'signed', annual_report_locked = true,
      preflight_status = 'passed', blocking_issue_count = 0,
      current_version_id = v_version.id, submission_blocked = false,
      invalidated_reason = NULL, invalidated_at = NULL,
      updated_by = p_actor_user_id, updated_at = now()
  WHERE id = v_project.id;

  UPDATE public.annual_report_comparative_snapshots
  SET is_current = false, superseded_at = now()
  WHERE company_id = p_company_id
    AND source_fiscal_period_id = p_fiscal_period_id
    AND is_current AND superseded_at IS NULL;

  INSERT INTO public.annual_report_comparative_snapshots(
    company_id, source_fiscal_period_id, source_version_id, source_type,
    source_label, formal_report_snapshot, overview_snapshot,
    verified_by, verified_at
  ) VALUES (
    p_company_id, p_fiscal_period_id, v_version.id, 'final_report_snapshot',
    'Slutlig årsredovisning version ' || v_next,
    p_formal_report_snapshot,
    COALESCE(p_canonical_snapshot->'forvaltningsberattelse'->'flerarsoversikt', '[]'::jsonb),
    p_actor_user_id, now()
  );

  INSERT INTO public.annual_report_audit_events(
    project_id, company_id, fiscal_period_id, actor_user_id, event_type,
    affects_ledger, previous_value, new_value, report_version_id,
    document_hash, checks_run
  ) VALUES (
    v_project.id, p_company_id, p_fiscal_period_id, p_actor_user_id,
    'annual_report_finalized', false,
    CASE WHEN v_previous.id IS NULL THEN NULL ELSE jsonb_build_object('version_id', v_previous.id, 'status', v_previous.status) END,
    jsonb_build_object('version_id', v_version.id, 'version_number', v_next, 'status', 'signed'),
    v_version.id, p_combined_sha256, p_validation_report
  );

  RETURN jsonb_build_object(
    'project_id', v_project.id,
    'version_id', v_version.id,
    'version_number', v_next,
    'status', 'signed',
    'pdf_document_id', p_pdf_document_id,
    'ixbrl_document_id', p_ixbrl_document_id,
    'combined_sha256', p_combined_sha256
  );
END;
$$;
REVOKE ALL ON FUNCTION public.finalize_annual_report_version(
  uuid, uuid, uuid, bigint, jsonb, jsonb, jsonb, jsonb, uuid, uuid, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_annual_report_version(
  uuid, uuid, uuid, bigint, jsonb, jsonb, jsonb, jsonb, uuid, uuid, text, text, text
) TO service_role;

CREATE OR REPLACE FUNCTION public.create_new_annual_report_draft(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_actor_user_id uuid,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_project public.annual_report_projects%ROWTYPE;
BEGIN
  IF auth.uid() IS DISTINCT FROM p_actor_user_id OR NOT public.user_can_write_company(p_company_id) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'ANNUAL_REPORT_ACCESS_DENIED';
  END IF;
  IF length(trim(COALESCE(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ANNUAL_REPORT_VERSION_REASON_REQUIRED';
  END IF;
  SELECT * INTO v_project FROM public.annual_report_projects
  WHERE company_id = p_company_id AND fiscal_period_id = p_fiscal_period_id
  FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.annual_report_projects(
      company_id, fiscal_period_id, status, annual_report_locked,
      submission_blocked, created_by, updated_by
    ) VALUES (
      p_company_id, p_fiscal_period_id, 'draft', false, true,
      p_actor_user_id, p_actor_user_id
    ) RETURNING * INTO v_project;
  ELSIF v_project.status IN ('filed', 'registered') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ANNUAL_REPORT_FILED_CORRECTION_FLOW_REQUIRED';
  ELSE
    UPDATE public.annual_report_projects
    SET status = 'draft', annual_report_locked = false,
        preflight_status = 'not_run', blocking_issue_count = 0,
        submission_blocked = true, invalidated_reason = p_reason,
        invalidated_at = now(), updated_by = p_actor_user_id, updated_at = now()
    WHERE id = v_project.id
    RETURNING * INTO v_project;
  END IF;

  INSERT INTO public.annual_report_audit_events(
    project_id, company_id, fiscal_period_id, actor_user_id, event_type,
    affects_ledger, reason, new_value
  ) VALUES (
    v_project.id, p_company_id, p_fiscal_period_id, p_actor_user_id,
    'annual_report_new_draft_created', false, p_reason,
    jsonb_build_object('status', 'draft', 'annual_report_locked', false)
  );
  RETURN jsonb_build_object('project_id', v_project.id, 'status', 'draft');
END;
$$;
REVOKE ALL ON FUNCTION public.create_new_annual_report_draft(uuid, uuid, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_new_annual_report_draft(uuid, uuid, uuid, text)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.replace_annual_report_comparative_snapshot(
  p_company_id uuid,
  p_source_fiscal_period_id uuid,
  p_actor_user_id uuid,
  p_source_type text,
  p_source_label text,
  p_formal_report_snapshot jsonb,
  p_overview_snapshot jsonb,
  p_source_version_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_snapshot public.annual_report_comparative_snapshots%ROWTYPE;
BEGIN
  IF coalesce(auth.role(), current_user::text) NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'ANNUAL_REPORT_COMPARATIVE_SERVICE_ONLY';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.resolve_company_access_for_user(p_actor_user_id, p_company_id) access
    WHERE access.can_write OR access.can_manage_platform
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'ANNUAL_REPORT_ACCESS_DENIED';
  END IF;
  IF p_source_type NOT IN (
    'established_annual_report', 'final_report_snapshot', 'manually_verified'
  ) OR length(trim(COALESCE(p_source_label, ''))) < 3 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'ANNUAL_REPORT_COMPARATIVE_INVALID';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.fiscal_periods
    WHERE id = p_source_fiscal_period_id AND company_id = p_company_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'ANNUAL_REPORT_COMPARATIVE_PERIOD_NOT_FOUND';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat_ws(':', 'annual-report-comparative', p_company_id, p_source_fiscal_period_id), 0
  ));

  UPDATE public.annual_report_comparative_snapshots
  SET is_current = false, superseded_at = now()
  WHERE company_id = p_company_id
    AND source_fiscal_period_id = p_source_fiscal_period_id
    AND is_current
    AND superseded_at IS NULL;

  INSERT INTO public.annual_report_comparative_snapshots(
    company_id, source_fiscal_period_id, source_version_id, source_type,
    source_label, formal_report_snapshot, overview_snapshot,
    verified_by, verified_at, is_current
  ) VALUES (
    p_company_id, p_source_fiscal_period_id, p_source_version_id, p_source_type,
    trim(p_source_label), p_formal_report_snapshot,
    COALESCE(p_overview_snapshot, '[]'::jsonb),
    p_actor_user_id, now(), true
  ) RETURNING * INTO v_snapshot;

  UPDATE public.annual_report_projects project
  SET document_revision = project.document_revision + 1, updated_at = now()
  FROM public.fiscal_periods current_period
  WHERE project.company_id = p_company_id
    AND project.fiscal_period_id = current_period.id
    AND current_period.company_id = p_company_id
    AND current_period.previous_period_id = p_source_fiscal_period_id;

  INSERT INTO public.annual_report_audit_events(
    company_id, fiscal_period_id, actor_user_id, event_type, affects_ledger,
    new_value, reason
  ) VALUES (
    p_company_id, p_source_fiscal_period_id, p_actor_user_id,
    'annual_report_comparatives_verified', false,
    jsonb_build_object(
      'snapshot_id', v_snapshot.id,
      'source_type', v_snapshot.source_type,
      'source_label', v_snapshot.source_label
    ),
    'Verifierade jämförelsetal ersatte tidigare presentationskälla.'
  );

  RETURN jsonb_build_object(
    'id', v_snapshot.id,
    'source_type', v_snapshot.source_type,
    'source_label', v_snapshot.source_label,
    'verified_at', v_snapshot.verified_at
  );
END;
$$;
REVOKE ALL ON FUNCTION public.replace_annual_report_comparative_snapshot(
  uuid, uuid, uuid, text, text, jsonb, jsonb, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_annual_report_comparative_snapshot(
  uuid, uuid, uuid, text, text, jsonb, jsonb, uuid
) TO service_role;

-- Synchronize the immutable version lifecycle with the canonical Bolagsverket
-- submission evidence. The exact archived iXBRL document and SHA-256 must match
-- the current signed version; a different payload can never advance status.
CREATE OR REPLACE FUNCTION public.sync_annual_report_submission_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_project public.annual_report_projects%ROWTYPE;
  v_version public.annual_report_versions%ROWTYPE;
  v_document_id uuid;
BEGIN
  IF NEW.status NOT IN (
    'uploaded', 'inkommen', 'forelagd', 'komplettering', 'registrerad', 'avslutad'
  ) THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_project
  FROM public.annual_report_projects
  WHERE company_id = NEW.company_id AND fiscal_period_id = NEW.fiscal_period_id
  FOR UPDATE;
  IF NOT FOUND OR v_project.current_version_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_version
  FROM public.annual_report_versions
  WHERE id = v_project.current_version_id
  FOR UPDATE;
  v_document_id := coalesce(NEW.archived_document_id, NEW.dokument_id);
  IF v_document_id IS DISTINCT FROM v_version.ixbrl_document_id
     OR NEW.payload_hash IS DISTINCT FROM v_version.ixbrl_sha256 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ANNUAL_REPORT_SUBMISSION_ARTIFACT_MISMATCH';
  END IF;

  IF NEW.status IN ('uploaded', 'inkommen', 'forelagd', 'komplettering', 'registrerad', 'avslutad')
     AND v_version.status = 'signed' THEN
    UPDATE public.annual_report_versions
    SET status = 'filed', filed_at = coalesce(NEW.uploaded_at, now())
    WHERE id = v_version.id
    RETURNING * INTO v_version;
    UPDATE public.annual_report_projects
    SET status = 'filed', annual_report_locked = true,
        submission_blocked = false, updated_at = now()
    WHERE id = v_project.id;
    INSERT INTO public.annual_report_audit_events(
      project_id, company_id, fiscal_period_id, actor_user_id, event_type,
      affects_ledger, report_version_id, document_hash, new_value
    ) VALUES (
      v_project.id, NEW.company_id, NEW.fiscal_period_id, NEW.user_id,
      'annual_report_filed', false, v_version.id, v_version.combined_sha256,
      jsonb_build_object('submission_id', NEW.id, 'submission_status', NEW.status)
    );
  END IF;

  IF NEW.status IN ('registrerad', 'avslutad') AND v_version.status = 'filed' THEN
    UPDATE public.annual_report_versions
    SET status = 'registered', registered_at = coalesce(NEW.registered_at, now())
    WHERE id = v_version.id
    RETURNING * INTO v_version;
    UPDATE public.annual_report_projects
    SET status = 'registered', annual_report_locked = true,
        submission_blocked = false, updated_at = now()
    WHERE id = v_project.id;
    INSERT INTO public.annual_report_audit_events(
      project_id, company_id, fiscal_period_id, actor_user_id, event_type,
      affects_ledger, report_version_id, document_hash, new_value
    ) VALUES (
      v_project.id, NEW.company_id, NEW.fiscal_period_id, NEW.user_id,
      'annual_report_registered', false, v_version.id, v_version.combined_sha256,
      jsonb_build_object('submission_id', NEW.id, 'submission_status', NEW.status)
    );
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS sync_annual_report_submission_status ON public.arsredovisning_submissions;
CREATE TRIGGER sync_annual_report_submission_status
  AFTER INSERT OR UPDATE OF status, payload_hash, archived_document_id, dokument_id
  ON public.arsredovisning_submissions
  FOR EACH ROW EXECUTE FUNCTION public.sync_annual_report_submission_status();

REVOKE ALL ON FUNCTION public.sync_annual_report_submission_status()
  FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Controlled reopen: request + audit are atomic; approval reverses entries.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_fiscal_period_reopen(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_actor_user_id uuid,
  p_reason text,
  p_requested_changes text[],
  p_annual_report_already_filed boolean,
  p_tax_return_already_filed boolean,
  p_designated_approver_name text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period public.fiscal_periods%ROWTYPE;
  v_next_period public.fiscal_periods%ROWTYPE;
  v_project public.annual_report_projects%ROWTYPE;
  v_submission public.arsredovisning_submissions%ROWTYPE;
  v_request public.fiscal_period_reopen_requests%ROWTYPE;
  v_blocked boolean;
  v_period_snapshot jsonb;
  v_annual_report_snapshot jsonb;
BEGIN
  IF auth.uid() IS DISTINCT FROM p_actor_user_id
     OR NOT EXISTS (
       SELECT 1 FROM public.resolve_company_access(p_company_id) access
       WHERE access.effective_role IN ('platform_admin', 'company_owner', 'company_admin', 'accountant')
         AND access.can_write
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'YEAR_END_REOPEN_ACCESS_DENIED';
  END IF;
  IF length(trim(COALESCE(p_reason, ''))) < 10
     OR coalesce(array_length(p_requested_changes, 1), 0) < 1
     OR length(trim(COALESCE(p_designated_approver_name, ''))) < 2 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'YEAR_END_REOPEN_REQUEST_INCOMPLETE';
  END IF;

  SELECT * INTO v_period
  FROM public.fiscal_periods
  WHERE id = p_fiscal_period_id AND company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'YEAR_END_REOPEN_PERIOD_NOT_FOUND';
  END IF;
  IF NOT v_period.is_closed OR v_period.closing_entry_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'YEAR_END_REOPEN_PERIOD_NOT_CLOSED';
  END IF;

  SELECT * INTO v_project
  FROM public.annual_report_projects
  WHERE company_id = p_company_id AND fiscal_period_id = p_fiscal_period_id;
  SELECT * INTO v_next_period
  FROM public.fiscal_periods
  WHERE company_id = p_company_id AND previous_period_id = p_fiscal_period_id
  ORDER BY period_start ASC
  LIMIT 1;
  SELECT * INTO v_submission
  FROM public.arsredovisning_submissions
  WHERE company_id = p_company_id
    AND fiscal_period_id = p_fiscal_period_id
    AND status IN ('uploaded', 'inkommen', 'forelagd', 'komplettering', 'registrerad', 'avslutad')
  ORDER BY created_at DESC
  LIMIT 1;

  v_blocked := p_annual_report_already_filed OR v_submission.id IS NOT NULL;
  v_period_snapshot := to_jsonb(v_period) || jsonb_build_object(
    'next_period_id', v_next_period.id,
    'next_period_opening_balance_entry_id', v_next_period.opening_balance_entry_id
  );
  v_annual_report_snapshot := CASE
    WHEN v_project.id IS NULL THEN NULL
    ELSE to_jsonb(v_project) || jsonb_build_object(
      'detected_submission', CASE WHEN v_submission.id IS NULL THEN NULL ELSE to_jsonb(v_submission) END
    )
  END;

  INSERT INTO public.fiscal_period_reopen_requests(
    company_id, fiscal_period_id, reason, requested_changes,
    annual_report_already_filed, tax_return_already_filed,
    designated_approver_name, requested_by, status,
    period_snapshot, annual_report_snapshot,
    closing_entry_id, opening_balance_entry_id,
    error_code, error_message
  ) VALUES (
    p_company_id, p_fiscal_period_id, trim(p_reason), p_requested_changes,
    v_blocked, p_tax_return_already_filed,
    trim(p_designated_approver_name), p_actor_user_id,
    CASE WHEN v_blocked THEN 'blocked' ELSE 'requested' END,
    v_period_snapshot, v_annual_report_snapshot,
    v_period.closing_entry_id, v_next_period.opening_balance_entry_id,
    CASE WHEN v_blocked THEN 'FILED_CORRECTION_FLOW_REQUIRED' ELSE NULL END,
    CASE WHEN v_blocked
      THEN 'Årsredovisningen är redan inlämnad eller registrerad och kräver särskilt rättelseflöde.'
      ELSE NULL
    END
  ) RETURNING * INTO v_request;

  INSERT INTO public.annual_report_audit_events(
    project_id, company_id, fiscal_period_id, actor_user_id, event_type,
    affects_ledger, previous_value, new_value, reason
  ) VALUES (
    v_project.id, p_company_id, p_fiscal_period_id, p_actor_user_id,
    CASE WHEN v_blocked THEN 'fiscal_period_reopen_blocked' ELSE 'fiscal_period_reopen_requested' END,
    true, v_period_snapshot,
    jsonb_build_object(
      'request_id', v_request.id,
      'status', v_request.status,
      'requested_changes', to_jsonb(p_requested_changes),
      'tax_return_already_filed', p_tax_return_already_filed
    ),
    trim(p_reason)
  );

  RETURN jsonb_build_object(
    'id', v_request.id,
    'status', v_request.status,
    'reason', v_request.reason,
    'requested_changes', to_jsonb(v_request.requested_changes),
    'designated_approver_name', v_request.designated_approver_name,
    'error_code', v_request.error_code,
    'error_message', v_request.error_message,
    'requested_at', v_request.requested_at
  );
END;
$$;
REVOKE ALL ON FUNCTION public.request_fiscal_period_reopen(
  uuid, uuid, uuid, text, text[], boolean, boolean, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_fiscal_period_reopen(
  uuid, uuid, uuid, text, text[], boolean, boolean, text
) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.approve_fiscal_period_reopen(
  p_request_id uuid,
  p_actor_user_id uuid,
  p_approval_note text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_request public.fiscal_period_reopen_requests%ROWTYPE;
  v_period public.fiscal_periods%ROWTYPE;
  v_next_period public.fiscal_periods%ROWTYPE;
  v_project public.annual_report_projects%ROWTYPE;
  v_closing_lines jsonb;
  v_opening_lines jsonb;
  v_closing_reversal uuid;
  v_opening_reversal uuid;
  v_next_other_entries integer;
BEGIN
  SELECT * INTO v_request
  FROM public.fiscal_period_reopen_requests
  WHERE id = p_request_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'YEAR_END_REOPEN_REQUEST_NOT_FOUND'; END IF;
  IF auth.uid() IS DISTINCT FROM p_actor_user_id
     OR NOT EXISTS (
       SELECT 1 FROM public.resolve_company_access(v_request.company_id) access
       WHERE access.effective_role IN ('platform_admin', 'company_owner', 'company_admin', 'accountant')
         AND access.can_write
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'YEAR_END_REOPEN_ACCESS_DENIED';
  END IF;
  IF v_request.status <> 'requested' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'YEAR_END_REOPEN_REQUEST_NOT_PENDING';
  END IF;
  IF v_request.annual_report_already_filed THEN
    UPDATE public.fiscal_period_reopen_requests
    SET status = 'blocked', error_code = 'FILED_CORRECTION_FLOW_REQUIRED',
        error_message = 'Årsredovisningen är redan inlämnad och kräver särskilt rättelseflöde',
        updated_at = now()
    WHERE id = v_request.id;
    RETURN jsonb_build_object(
      'request_id', v_request.id,
      'status', 'blocked',
      'error_code', 'FILED_CORRECTION_FLOW_REQUIRED'
    );
  END IF;
  IF length(trim(COALESCE(p_approval_note, ''))) < 5 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'YEAR_END_REOPEN_APPROVAL_NOTE_REQUIRED';
  END IF;

  SELECT * INTO v_period FROM public.fiscal_periods
  WHERE id = v_request.fiscal_period_id AND company_id = v_request.company_id
  FOR UPDATE;
  IF NOT FOUND OR NOT v_period.is_closed OR v_period.closing_entry_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'YEAR_END_REOPEN_PERIOD_NOT_CLOSED';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.arsredovisning_submissions s
    WHERE s.company_id = v_request.company_id
      AND s.fiscal_period_id = v_request.fiscal_period_id
      AND s.status IN ('uploaded', 'inkommen', 'forelagd', 'komplettering', 'registrerad', 'avslutad')
  ) THEN
    UPDATE public.fiscal_period_reopen_requests
    SET status = 'blocked', error_code = 'FILED_CORRECTION_FLOW_REQUIRED',
        error_message = 'En registrerad eller pågående Bolagsverket-inlämning kräver särskilt rättelseflöde',
        updated_at = now()
    WHERE id = v_request.id;
    RETURN jsonb_build_object(
      'request_id', v_request.id,
      'status', 'blocked',
      'error_code', 'FILED_CORRECTION_FLOW_REQUIRED'
    );
  END IF;

  SELECT * INTO v_next_period FROM public.fiscal_periods
  WHERE company_id = v_request.company_id
    AND previous_period_id = v_period.id
  ORDER BY period_start ASC
  LIMIT 1
  FOR UPDATE;

  IF v_next_period.id IS NOT NULL
     AND (v_next_period.is_closed OR v_next_period.ledger_locked) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'YEAR_END_REOPEN_NEXT_PERIOD_CLOSED';
  END IF;

  IF v_next_period.id IS NOT NULL AND v_next_period.opening_balance_entry_id IS NOT NULL THEN
    SELECT count(*) INTO v_next_other_entries
    FROM public.journal_entries
    WHERE company_id = v_request.company_id
      AND fiscal_period_id = v_next_period.id
      AND status IN ('posted', 'reversed')
      AND id <> v_next_period.opening_balance_entry_id;
    IF v_next_other_entries > 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'YEAR_END_REOPEN_NEXT_PERIOD_HAS_ACTIVITY';
    END IF;
  END IF;

  UPDATE public.fiscal_period_reopen_requests
  SET status = 'reopening', approved_by = p_actor_user_id,
      approved_at = now(), approval_note = p_approval_note, updated_at = now()
  WHERE id = v_request.id;

  PERFORM set_config('nordklart.allow_controlled_year_end_reopen', 'true', true);

  -- Unlock metadata first; original posted entries are then reversed through
  -- the same balanced posting helper used by the year-end engine.
  UPDATE public.fiscal_periods
  SET is_closed = false, closed_at = NULL, locked_at = NULL,
      closing_entry_id = NULL, ledger_locked = false, updated_at = now()
  WHERE id = v_period.id;

  SELECT jsonb_agg(jsonb_build_object(
    'account_number', l.account_number,
    'debit_amount', l.credit_amount,
    'credit_amount', l.debit_amount,
    'line_description', 'Kontrollerad återöppning: ' || COALESCE(l.line_description, '')
  ) ORDER BY l.sort_order, l.id)
  INTO v_closing_lines
  FROM public.journal_entry_lines l
  WHERE l.journal_entry_id = v_period.closing_entry_id;

  v_closing_reversal := public.__ye_post_entry(
    v_request.company_id, p_actor_user_id, v_period.id, v_period.period_end,
    'Kontrollerad återöppning av ' || v_period.name || ': återföring bokslutsverifikation',
    'storno', 'A', v_closing_lines, v_period.closing_entry_id
  );
  UPDATE public.journal_entries
  SET status = 'reversed', reversed_by_id = v_closing_reversal
  WHERE id = v_period.closing_entry_id AND company_id = v_request.company_id;

  IF v_next_period.id IS NOT NULL AND v_next_period.opening_balance_entry_id IS NOT NULL THEN
    UPDATE public.fiscal_periods
    SET opening_balance_entry_id = NULL, opening_balances_set = false, updated_at = now()
    WHERE id = v_next_period.id;

    SELECT jsonb_agg(jsonb_build_object(
      'account_number', l.account_number,
      'debit_amount', l.credit_amount,
      'credit_amount', l.debit_amount,
      'line_description', 'Kontrollerad återöppning: återföring ingående balans'
    ) ORDER BY l.sort_order, l.id)
    INTO v_opening_lines
    FROM public.journal_entry_lines l
    WHERE l.journal_entry_id = v_next_period.opening_balance_entry_id;

    v_opening_reversal := public.__ye_post_entry(
      v_request.company_id, p_actor_user_id, v_next_period.id, v_next_period.period_start,
      'Kontrollerad återöppning av föregående år: återföring ingående balans',
      'storno', 'A', v_opening_lines, v_next_period.opening_balance_entry_id
    );
    UPDATE public.journal_entries
    SET status = 'reversed', reversed_by_id = v_opening_reversal
    WHERE id = v_next_period.opening_balance_entry_id AND company_id = v_request.company_id;
  END IF;

  UPDATE public.year_end_runs
  SET status = 'reopening', reopen_request_id = v_request.id,
      reopening_reversal_entry_id = v_closing_reversal, updated_at = now()
  WHERE company_id = v_request.company_id
    AND fiscal_period_id = v_period.id
    AND status = 'closed';
  UPDATE public.year_end_runs
  SET status = 'reopened', closing_entry_id = NULL,
      opening_balance_entry_id = NULL, reopened_by = p_actor_user_id,
      reopened_at = now(), updated_at = now()
  WHERE company_id = v_request.company_id
    AND fiscal_period_id = v_period.id
    AND status = 'reopening';

  SELECT * INTO v_project FROM public.annual_report_projects
  WHERE company_id = v_request.company_id AND fiscal_period_id = v_period.id
  FOR UPDATE;
  IF v_project.id IS NOT NULL THEN
    UPDATE public.annual_report_projects
    SET status = 'superseded', annual_report_locked = true,
        preflight_status = 'not_run', submission_blocked = true,
        invalidated_reason = 'Räkenskapsåret återöppnades för rättelse',
        invalidated_at = now(), updated_by = p_actor_user_id, updated_at = now()
    WHERE id = v_project.id;
  END IF;

  UPDATE public.fiscal_period_reopen_requests
  SET status = 'reopened', closing_reversal_entry_id = v_closing_reversal,
      opening_balance_reversal_entry_id = v_opening_reversal,
      approved_by = p_actor_user_id, reopened_at = now(), updated_at = now()
  WHERE id = v_request.id;

  INSERT INTO public.annual_report_audit_events(
    project_id, company_id, fiscal_period_id, actor_user_id, event_type,
    affects_ledger, previous_value, new_value, reason
  ) VALUES (
    v_project.id, v_request.company_id, v_period.id, p_actor_user_id,
    'fiscal_period_reopened', true,
    v_request.period_snapshot,
    jsonb_build_object(
      'ledger_locked', false,
      'closing_reversal_entry_id', v_closing_reversal,
      'opening_balance_reversal_entry_id', v_opening_reversal
    ),
    v_request.reason
  );

  RETURN jsonb_build_object(
    'request_id', v_request.id,
    'status', 'reopened',
    'closing_reversal_entry_id', v_closing_reversal,
    'opening_balance_reversal_entry_id', v_opening_reversal,
    'annual_report_invalidated', v_project.id IS NOT NULL
  );
EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE = '42501' THEN
    RAISE;
  END IF;
  -- The EXCEPTION block rolls back all accounting mutations performed by the
  -- protected block before recording a durable failed request state.
  UPDATE public.fiscal_period_reopen_requests
  SET status = 'failed', error_code = SQLSTATE, error_message = SQLERRM, updated_at = now()
  WHERE id = p_request_id AND status <> 'reopened';
  RETURN jsonb_build_object(
    'request_id', p_request_id,
    'status', 'failed',
    'error_code', SQLSTATE,
    'error_message', SQLERRM
  );
END;
$$;
REVOKE ALL ON FUNCTION public.approve_fiscal_period_reopen(uuid, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_fiscal_period_reopen(uuid, uuid, text)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. Closed-ledger document support.
--
-- These RPCs remain service-only and never create journal entries. The only
-- removed restriction is the ledger lock itself. Once the annual-report
-- document is final/locked, a new report draft is required before support
-- registers can change.
-- ---------------------------------------------------------------------------
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
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HISTORICAL_OPEN_ITEM_PERIOD_NOT_FOUND'
      USING ERRCODE = '23503';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.annual_report_projects arp
    WHERE arp.company_id = p_company_id
      AND arp.fiscal_period_id = p_fiscal_period_id
      AND arp.annual_report_locked
  ) THEN
    RAISE EXCEPTION 'HISTORICAL_OPEN_ITEM_ANNUAL_REPORT_LOCKED'
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
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HISTORICAL_BALANCE_RECONCILIATION_PERIOD_NOT_FOUND'
      USING ERRCODE = '23503';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.annual_report_projects arp
    WHERE arp.company_id = p_company_id
      AND arp.fiscal_period_id = p_fiscal_period_id
      AND arp.annual_report_locked
  ) THEN
    RAISE EXCEPTION 'HISTORICAL_BALANCE_RECONCILIATION_ANNUAL_REPORT_LOCKED'
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

  UPDATE public.annual_report_projects
  SET document_revision = document_revision + 1, updated_at = now()
  WHERE company_id = p_company_id AND fiscal_period_id = p_fiscal_period_id;

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

-- Updated-at helpers.
DROP TRIGGER IF EXISTS set_updated_at_annual_report_projects ON public.annual_report_projects;
CREATE TRIGGER set_updated_at_annual_report_projects
  BEFORE UPDATE ON public.annual_report_projects
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_fiscal_period_reopen_requests ON public.fiscal_period_reopen_requests;
CREATE TRIGGER set_updated_at_fiscal_period_reopen_requests
  BEFORE UPDATE ON public.fiscal_period_reopen_requests
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

NOTIFY pgrst, 'reload schema';
COMMIT;
