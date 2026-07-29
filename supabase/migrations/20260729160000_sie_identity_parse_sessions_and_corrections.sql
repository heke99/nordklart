-- Canonical SIE identity, state model, durable parse sessions and corrections.
--
-- This is forward-only. It deliberately wraps the latest finalizer instead of
-- editing an already deployed migration.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.normalize_swedish_organisation_number(
  p_value text
) RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  WITH normalized AS (
    SELECT regexp_replace(coalesce(p_value, ''), '[^0-9]', '', 'g') AS digits
  )
  SELECT CASE
    WHEN length(digits) = 12 AND left(digits, 2) = '16'
      THEN substring(digits FROM 3)
    WHEN length(digits) = 10
      THEN digits
    ELSE NULL
  END
  FROM normalized;
$$;

CREATE OR REPLACE FUNCTION public.compare_sie_company_identity(
  p_sie_organisation_number text,
  p_company_organisation_number text
) RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN public.normalize_swedish_organisation_number(
      p_sie_organisation_number
    ) IS NULL THEN 'missing_in_sie'
    WHEN public.normalize_swedish_organisation_number(
      p_company_organisation_number
    ) IS NULL THEN 'missing_in_company'
    WHEN public.normalize_swedish_organisation_number(
      p_sie_organisation_number
    ) = public.normalize_swedish_organisation_number(
      p_company_organisation_number
    ) THEN 'match'
    ELSE 'mismatch'
  END;
$$;

REVOKE ALL ON FUNCTION public.normalize_swedish_organisation_number(text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.normalize_swedish_organisation_number(text)
  TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.compare_sie_company_identity(text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.compare_sie_company_identity(text, text)
  TO authenticated, service_role;

-- One database state model, aligned with lib/import/sie-status.ts.
ALTER TABLE public.sie_imports
  DROP CONSTRAINT IF EXISTS sie_imports_status_check;
ALTER TABLE public.sie_imports
  ADD CONSTRAINT sie_imports_status_check CHECK (status IN (
    'pending',
    'validating',
    'staged',
    'importing',
    'partial',
    'mapped',
    'completed',
    'failed',
    'replaced',
    'undone'
  ));

CREATE TABLE IF NOT EXISTS public.sie_parse_sessions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid NOT NULL
    REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id                  uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  file_name                text NOT NULL CHECK (length(btrim(file_name)) > 0),
  file_hash                text NOT NULL CHECK (file_hash ~ '^[0-9a-f]{64}$'),
  archive_hash             text NOT NULL CHECK (archive_hash ~ '^[0-9a-f]{64}$'),
  storage_path             text NOT NULL,
  parser_version           text NOT NULL,
  parsed_header            jsonb NOT NULL DEFAULT '{}'::jsonb,
  detected_source_system   text,
  identity_status          text NOT NULL CHECK (identity_status IN (
    'match', 'missing_in_sie', 'missing_in_company', 'mismatch'
  )),
  identity_result          jsonb NOT NULL DEFAULT '{}'::jsonb,
  status                   text NOT NULL DEFAULT 'validating' CHECK (status IN (
    'validating', 'staged', 'failed', 'completed', 'expired'
  )),
  replace_import_id        uuid REFERENCES public.sie_imports(id) ON DELETE RESTRICT,
  sie_import_id            uuid,
  error_message            text,
  archived_at              timestamptz,
  completed_at             timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  expires_at               timestamptz NOT NULL,
  CHECK (expires_at > created_at),
  UNIQUE (company_id, id),
  UNIQUE (storage_path)
);

ALTER TABLE public.sie_imports
  ADD COLUMN IF NOT EXISTS parse_session_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sie_imports_parse_session_id_fkey'
      AND conrelid = 'public.sie_imports'::regclass
  ) THEN
    ALTER TABLE public.sie_imports
      ADD CONSTRAINT sie_imports_parse_session_id_fkey
      FOREIGN KEY (parse_session_id)
      REFERENCES public.sie_parse_sessions(id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sie_parse_sessions_sie_import_id_fkey'
      AND conrelid = 'public.sie_parse_sessions'::regclass
  ) THEN
    ALTER TABLE public.sie_parse_sessions
      ADD CONSTRAINT sie_parse_sessions_sie_import_id_fkey
      FOREIGN KEY (sie_import_id)
      REFERENCES public.sie_imports(id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_sie_parse_sessions_company_status
  ON public.sie_parse_sessions (company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sie_parse_sessions_expiry
  ON public.sie_parse_sessions (expires_at)
  WHERE status IN ('validating', 'staged');
CREATE UNIQUE INDEX IF NOT EXISTS idx_sie_imports_parse_session
  ON public.sie_imports (parse_session_id)
  WHERE parse_session_id IS NOT NULL;

ALTER TABLE public.sie_parse_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sie_parse_sessions_select
  ON public.sie_parse_sessions;
CREATE POLICY sie_parse_sessions_select
  ON public.sie_parse_sessions
  FOR SELECT USING (
    EXISTS (
      SELECT 1
      FROM public.resolve_company_access(company_id) access
      WHERE access.can_read
    )
  );

-- No authenticated INSERT/UPDATE/DELETE policies. Parse-session lifecycle
-- writes are performed only by tenant-checked server routes using service_role.

CREATE OR REPLACE FUNCTION public.enforce_sie_parse_session_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.company_id IS DISTINCT FROM NEW.company_id
     OR OLD.user_id IS DISTINCT FROM NEW.user_id
     OR OLD.file_hash IS DISTINCT FROM NEW.file_hash
     OR OLD.archive_hash IS DISTINCT FROM NEW.archive_hash
     OR OLD.storage_path IS DISTINCT FROM NEW.storage_path
     OR OLD.parsed_header IS DISTINCT FROM NEW.parsed_header
     OR OLD.identity_result IS DISTINCT FROM NEW.identity_result
     OR OLD.identity_status IS DISTINCT FROM NEW.identity_status THEN
    RAISE EXCEPTION 'SIE_PARSE_SESSION_IMMUTABLE_IDENTITY'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD.status = 'validating' AND NEW.status IN ('staged', 'failed', 'expired'))
    OR (OLD.status = 'staged' AND NEW.status IN ('completed', 'failed', 'expired'))
  ) THEN
    RAISE EXCEPTION 'SIE_PARSE_SESSION_INVALID_TRANSITION: % -> %',
      OLD.status, NEW.status
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_sie_parse_session_transition
  ON public.sie_parse_sessions;
CREATE TRIGGER enforce_sie_parse_session_transition
  BEFORE UPDATE ON public.sie_parse_sessions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_sie_parse_session_transition();

CREATE TABLE IF NOT EXISTS public.sie_import_corrections (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                 uuid NOT NULL
    REFERENCES public.companies(id) ON DELETE CASCADE,
  sie_import_session_id      uuid NOT NULL
    REFERENCES public.sie_parse_sessions(id) ON DELETE RESTRICT,
  sie_import_id              uuid
    REFERENCES public.sie_imports(id) ON DELETE RESTRICT,
  source_voucher_identifier  text,
  source_line_identifier     text,
  field_name                 text NOT NULL,
  original_value             jsonb,
  corrected_value            jsonb NOT NULL,
  correction_type            text NOT NULL CHECK (correction_type IN (
    'account_mapping',
    'voucher_text',
    'account_interpretation',
    'dimension',
    'cost_center',
    'currency',
    'technical_line',
    'parser_interpretation',
    'amount'
  )),
  reason                     text NOT NULL CHECK (length(btrim(reason)) >= 3),
  accounting_impact          jsonb NOT NULL DEFAULT '{}'::jsonb,
  status                     text NOT NULL DEFAULT 'proposed' CHECK (status IN (
    'proposed', 'approved', 'rejected', 'superseded', 'posted_as_correction'
  )),
  created_by                 uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  approved_by                uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  approved_at                timestamptz,
  superseded_at              timestamptz,
  CHECK (
    correction_type <> 'amount'
    OR (
      accounting_impact ? 'debit_delta'
      AND accounting_impact ? 'credit_delta'
      AND accounting_impact ? 'balanced'
      AND (accounting_impact->>'balanced')::boolean
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_sie_import_corrections_session
  ON public.sie_import_corrections
    (company_id, sie_import_session_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sie_import_correction_natural_key
  ON public.sie_import_corrections (
    company_id,
    sie_import_session_id,
    correction_type,
    coalesce(source_line_identifier, ''),
    field_name
  )
  WHERE superseded_at IS NULL;

ALTER TABLE public.sie_import_corrections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sie_import_corrections_select
  ON public.sie_import_corrections;
CREATE POLICY sie_import_corrections_select
  ON public.sie_import_corrections
  FOR SELECT USING (
    EXISTS (
      SELECT 1
      FROM public.resolve_company_access(company_id) access
      WHERE access.can_read
    )
  );

CREATE OR REPLACE FUNCTION public.sie_import_correction_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'SIE_IMPORT_CORRECTION_APPEND_ONLY'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS sie_import_corrections_immutable
  ON public.sie_import_corrections;
CREATE TRIGGER sie_import_corrections_immutable
  BEFORE UPDATE OR DELETE ON public.sie_import_corrections
  FOR EACH ROW EXECUTE FUNCTION public.sie_import_correction_immutable();

CREATE OR REPLACE FUNCTION public.record_sie_import_corrections(
  p_company_id uuid,
  p_parse_session_id uuid,
  p_user_id uuid,
  p_corrections jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text := coalesce(auth.role(), current_user::text);
  v_session public.sie_parse_sessions%ROWTYPE;
  v_correction jsonb;
  v_count integer := 0;
BEGIN
  IF v_role NOT IN ('service_role', 'postgres')
     AND (
       auth.uid() IS DISTINCT FROM p_user_id
       OR NOT public.user_can_write_company(p_company_id)
     ) THEN
    RAISE EXCEPTION 'SIE_CORRECTION_FORBIDDEN'
      USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_corrections) <> 'array' THEN
    RAISE EXCEPTION 'SIE_CORRECTION_ARRAY_REQUIRED'
      USING ERRCODE = '22023';
  END IF;

  SELECT ps.* INTO v_session
  FROM public.sie_parse_sessions ps
  WHERE ps.id = p_parse_session_id
    AND ps.company_id = p_company_id
    AND ps.user_id = p_user_id
    AND ps.status = 'staged'
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SIE_PARSE_SESSION_INVALID'
      USING ERRCODE = '23514';
  END IF;

  FOR v_correction IN SELECT value FROM jsonb_array_elements(p_corrections)
  LOOP
    IF v_correction->>'correction_type' NOT IN (
      'account_mapping', 'voucher_text', 'account_interpretation',
      'dimension', 'cost_center', 'currency', 'technical_line',
      'parser_interpretation'
    ) THEN
      RAISE EXCEPTION 'SIE_CORRECTION_TYPE_INVALID'
        USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.sie_import_corrections (
      company_id, sie_import_session_id, source_voucher_identifier,
      source_line_identifier, field_name, original_value, corrected_value,
      correction_type, reason, accounting_impact, status, created_by,
      approved_by, approved_at
    ) VALUES (
      p_company_id, p_parse_session_id,
      v_correction->>'source_voucher_identifier',
      v_correction->>'source_line_identifier',
      v_correction->>'field_name',
      v_correction->'original_value',
      v_correction->'corrected_value',
      v_correction->>'correction_type',
      coalesce(nullif(v_correction->>'reason', ''), 'Godkänd korrigering inför SIE-import.'),
      coalesce(v_correction->'accounting_impact', '{}'::jsonb),
      'approved', p_user_id, p_user_id, now()
    )
    ON CONFLICT DO NOTHING;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.record_sie_import_corrections(
  uuid, uuid, uuid, jsonb
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_sie_import_corrections(
  uuid, uuid, uuid, jsonb
) TO authenticated, service_role;

-- Final database guard. Parse and execute already compare the same identity,
-- but the economic commit cannot rely on either HTTP call having happened.
DO $$
BEGIN
  IF to_regprocedure(
    'public.__finalize_sie_import_identity_core_20260729(uuid,uuid,uuid,jsonb)'
  ) IS NULL THEN
    ALTER FUNCTION public.finalize_sie_import(uuid, uuid, uuid, jsonb)
      RENAME TO __finalize_sie_import_identity_core_20260729;
  END IF;
END
$$;

REVOKE ALL ON FUNCTION
  public.__finalize_sie_import_identity_core_20260729(uuid, uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.__finalize_sie_import_identity_core_20260729(uuid, uuid, uuid, jsonb)
  TO service_role;

CREATE OR REPLACE FUNCTION public.finalize_sie_import(
  p_company_id uuid,
  p_import_id uuid,
  p_user_id uuid,
  p_options jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_import public.sie_imports%ROWTYPE;
  v_company_org text;
  v_identity text;
  v_session public.sie_parse_sessions%ROWTYPE;
  v_result jsonb;
BEGIN
  SELECT si.* INTO v_import
  FROM public.sie_imports si
  WHERE si.id = p_import_id
    AND si.company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SIE_IMPORT_NOT_FOUND';
  END IF;

  SELECT coalesce(c.org_number, cs.org_number)
    INTO v_company_org
  FROM public.companies c
  LEFT JOIN public.company_settings cs ON cs.company_id = c.id
  WHERE c.id = p_company_id;

  v_identity := public.compare_sie_company_identity(
    v_import.org_number,
    v_company_org
  );
  IF v_identity <> 'match' THEN
    RAISE EXCEPTION 'SIE_COMPANY_IDENTITY_%', upper(v_identity)
      USING ERRCODE = '23514';
  END IF;

  IF v_import.parse_session_id IS NOT NULL THEN
    SELECT ps.* INTO v_session
    FROM public.sie_parse_sessions ps
    WHERE ps.id = v_import.parse_session_id
      AND ps.company_id = p_company_id
    FOR UPDATE;

    IF NOT FOUND
       OR v_session.status <> 'staged'
       OR v_session.expires_at <= now()
       OR v_session.file_hash <> v_import.file_hash
       OR v_session.identity_status <> 'match' THEN
      RAISE EXCEPTION 'SIE_PARSE_SESSION_INVALID_AT_FINALIZE'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  v_result :=
    public.__finalize_sie_import_identity_core_20260729(
      p_company_id,
      p_import_id,
      p_user_id,
      p_options
    );

  IF v_import.parse_session_id IS NOT NULL THEN
    UPDATE public.sie_parse_sessions
    SET sie_import_id = p_import_id
    WHERE id = v_import.parse_session_id
      AND company_id = p_company_id;
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_sie_import(uuid, uuid, uuid, jsonb)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_sie_import(uuid, uuid, uuid, jsonb)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
