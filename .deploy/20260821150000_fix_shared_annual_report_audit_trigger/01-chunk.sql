WITH staged AS (
  INSERT INTO public.nordklart_deploy_staging (file, idx, body, expected_sha)
  VALUES ('20260821150000_fix_shared_annual_report_audit_trigger.sql', 1, $nk_stage_0$-- =============================================================================
-- audit_annual_report_document_change: stop reading a field two of its three
-- tables do not have
--
-- The trigger function is attached to three tables:
--
--   annual_report_presentation_reclassifications  (has created_by, revoked_by)
--   arsredovisning_narratives                     (has neither)
--   arsredovisning_signature_requests             (has neither)
--
-- and resolves the actor with:
--
--   coalesce(auth.uid(), CASE
--     WHEN TG_TABLE_NAME = 'annual_report_presentation_reclassifications'
--       AND TG_OP = 'INSERT' THEN NEW.created_by ... END)
--
-- The TG_TABLE_NAME guard reads as if it makes the field reference safe. It
-- does not. PL/pgSQL prepares the whole expression as one SQL statement and
-- caches the plan on the function, keyed by the expression — not by the row
-- type of NEW. Once a backend has run this trigger for the reclassifications
-- table, the cached plan contains a `created_by` field extraction, and the next
-- INSERT or UPDATE on either of the other two tables on THAT connection dies
-- with:
--
--   ERROR: record "new" has no field "created_by"
--
-- So årsredovisning signing and narrative edits fail intermittently, depending
-- on what the pooled connection happened to touch first — and pass every time
-- in a test that only exercises one of the three tables per connection. It
-- reproduces reliably the moment two of them are used in one session, which is
-- how it was found.
--
-- to_jsonb(NEW) ->> 'field' is resolved against the actual row at run time and
-- yields NULL for a row type that lacks the field, which is exactly the value
-- the CASE was written to produce. Nothing else in the body changes.
--
-- pg-test: covered-by tests/pg/annual-report-audit-trigger.pg.test.ts
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.audit_annual_report_document_change()
RETURNS TRIGGER
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
  v_row jsonb;
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

  -- Field lookup through jsonb: resolved against the actual row, so a table
  -- without the column yields NULL instead of failing on a cached plan.
  v_row := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;

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
          AND TG_OP = 'INSERT' THEN nullif(v_row->>'created_by', '')::uuid
        WHEN TG_TABLE_NAME = 'annual_report_presentation_reclassifications'
          AND TG_OP = 'UPDATE' THEN nullif(v_row->>'revoked_by', '')::uuid
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

COMMIT;

NOTIFY pgrst, 'reload schema';
$nk_stage_0$, '5d2fb71e4268339b816b4edbf6d05044a33e2ab011a40252f5c8d0a6c8f35951')
  ON CONFLICT (file, idx) DO UPDATE
    SET body = EXCLUDED.body, expected_sha = EXCLUDED.expected_sha, staged_at = now()
  RETURNING idx, body, expected_sha
)
SELECT idx,
       encode(sha256(convert_to(body, 'UTF8')), 'hex') = expected_sha AS ok,
       octet_length(body) AS bytes
FROM staged;
