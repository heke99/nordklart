-- BankID consent hardening.
--
-- 1. user_can_write_company(company_id): RLS helper mirroring the app-layer
--    write rule (resolve_company_access().can_write — direct members with a
--    write-capable role, authorized agency staff; viewer/read-only/auditor
--    excluded). Previously most write policies only checked tenant MEMBERSHIP
--    (user_can_access_company_v2), so viewers could mutate rows over
--    PostgREST even though the API blocked them.
--
-- 2. signed_consents UPDATE policy now requires write capability: a viewer
--    could previously revoke a legally significant consent directly against
--    the database.
--
-- 3. Unique consent per BankID session: the poll flow creates the consent
--    BEFORE marking the session complete; the unique index makes replayed /
--    concurrent polls idempotent at the database level.
--
-- pg-test: covered-by tests/pg/bankid-consent-hardening.pg.test.ts

-- ============================================================
-- 1. Write-capability helper for RLS
-- ============================================================

CREATE OR REPLACE FUNCTION public.user_can_write_company(p_company_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT ra.can_write FROM public.resolve_company_access(p_company_id) ra),
    false
  );
$$;

REVOKE ALL ON FUNCTION public.user_can_write_company(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_can_write_company(uuid) TO authenticated, service_role;

-- ============================================================
-- 2. signed_consents: revocation requires write capability
-- ============================================================

DROP POLICY IF EXISTS signed_consents_update ON public.signed_consents;
CREATE POLICY signed_consents_update ON public.signed_consents
  FOR UPDATE USING (
    public.user_can_write_company(company_id)
  )
  WITH CHECK (
    public.user_can_write_company(company_id)
  );

-- ============================================================
-- 3. One consent per BankID session (idempotent completion)
-- ============================================================

-- Defensive dedupe before the unique index: keep the OLDEST consent per
-- session (the one already referenced by flow side effects). The immutability
-- trigger blocks DELETE for runtime roles — disable user triggers for this
-- one-off migration cleanup only.
ALTER TABLE public.signed_consents DISABLE TRIGGER USER;
DELETE FROM public.signed_consents sc
USING (
  SELECT id, row_number() OVER (PARTITION BY bankid_session_id ORDER BY created_at ASC, id ASC) AS rn
  FROM public.signed_consents
  WHERE bankid_session_id IS NOT NULL
) ranked
WHERE sc.id = ranked.id AND ranked.rn > 1;
ALTER TABLE public.signed_consents ENABLE TRIGGER USER;

CREATE UNIQUE INDEX IF NOT EXISTS signed_consents_bankid_session_unique_idx
  ON public.signed_consents (bankid_session_id)
  WHERE bankid_session_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
