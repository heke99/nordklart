-- Annual report submission + narrative hardening (revision items R04, R10,
-- R11, R14) and the canonical legal-form reader (B13).
--
--   * arsredovisning_submissions: payload hash + idempotency key + archived
--     document reference so retries can never double-submit and the exact
--     submitted document version is always recoverable (R14).
--   * arsredovisning_narrative_confirmations: standard texts asserting facts
--     ("inga väsentliga händelser…") must be actively confirmed; we store
--     who, when, which text and for which fiscal year (R10).
--   * company_entity_type(): single canonical SQL reader for the legal form
--     (companies.entity_type — NOT NULL by schema); every module reads the
--     same source (B13).
--
-- pg-test: covered-by tests/pg/arsredovisning-hardening.pg.test.ts

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Submission idempotency + archive linkage (R14)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.arsredovisning_submissions
  ADD COLUMN IF NOT EXISTS payload_hash text,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS archived_document_id uuid REFERENCES public.document_attachments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS archived_storage_path text;

COMMENT ON COLUMN public.arsredovisning_submissions.payload_hash IS
  'SHA-256 of the exact iXBRL payload submitted — retries must reference the same hash.';
COMMENT ON COLUMN public.arsredovisning_submissions.archived_document_id IS
  'The archived document version submitted to Bolagsverket. Archiving failure blocks submission (R14).';

-- One in-flight/completed submission per (period, idempotency key).
CREATE UNIQUE INDEX IF NOT EXISTS arsredovisning_submissions_idempotency
  ON public.arsredovisning_submissions (company_id, fiscal_period_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL
    AND status IN ('uploaded', 'inkommen', 'forelagd', 'komplettering', 'registrerad', 'avslutad');

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Narrative confirmations (R10)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.arsredovisning_narrative_confirmations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE CASCADE,
  -- Which standard text was confirmed (e.g. 'important_events',
  -- 'resultatdisposition', 'description').
  field            text NOT NULL,
  confirmed_text   text NOT NULL,
  text_version     integer NOT NULL DEFAULT 1,
  confirmed_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  confirmed_at     timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, fiscal_period_id, field, text_version)
);

CREATE INDEX IF NOT EXISTS idx_arsredovisning_narrative_confirmations_period
  ON public.arsredovisning_narrative_confirmations (company_id, fiscal_period_id);

ALTER TABLE public.arsredovisning_narrative_confirmations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS arsredovisning_narrative_confirmations_select ON public.arsredovisning_narrative_confirmations;
CREATE POLICY arsredovisning_narrative_confirmations_select ON public.arsredovisning_narrative_confirmations
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
DROP POLICY IF EXISTS arsredovisning_narrative_confirmations_insert ON public.arsredovisning_narrative_confirmations;
CREATE POLICY arsredovisning_narrative_confirmations_insert ON public.arsredovisning_narrative_confirmations
  FOR INSERT WITH CHECK (public.user_can_write_company(company_id));
-- Confirmations are append-only: no UPDATE/DELETE policies.

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Canonical legal-form reader (B13)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.company_entity_type(p_company_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT entity_type FROM public.companies WHERE id = p_company_id
$$;

REVOKE ALL ON FUNCTION public.company_entity_type(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.company_entity_type(uuid) TO authenticated, service_role;

-- Keep the legacy mirror (company_settings.entity_type) in sync with the
-- canonical column so stale mirrors cannot drift (B13). companies.entity_type
-- is the single write target; the mirror is read-only derived data.
UPDATE public.company_settings cs
SET entity_type = c.entity_type
FROM public.companies c
WHERE c.id = cs.company_id
  AND cs.entity_type IS DISTINCT FROM c.entity_type;

CREATE OR REPLACE FUNCTION public.sync_entity_type_mirror()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE public.company_settings
  SET entity_type = NEW.entity_type
  WHERE company_id = NEW.id
    AND entity_type IS DISTINCT FROM NEW.entity_type;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_entity_type_mirror ON public.companies;
CREATE TRIGGER sync_entity_type_mirror
  AFTER UPDATE OF entity_type ON public.companies
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_entity_type_mirror();

NOTIFY pgrst, 'reload schema';
