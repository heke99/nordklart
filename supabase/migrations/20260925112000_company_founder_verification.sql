-- Company creation requires an identified, authorized founder.
--
-- Until now the founder of a company became an active owner with
-- verification_status = 'self_attested' — a checkbox. Anyone with an email
-- address could register any org.nr and get full write access to "its" books.
--
-- The application now decides a founder verification before creating the
-- company (lib/company/verify-signatory.ts): BankID identity plus, for an
-- aktiebolag, a current representative position in Bolagsverket's register
-- (TIC Identity company roles); for an enskild firma, org.nr = personnummer.
-- This migration makes the database apply that decision in the SAME
-- transaction that creates the company, so no company can exist with an
-- unverified founder holding full access:
--
--   verified / self_attested (BankID off)  -> founder status 'active'
--   manual_review                          -> founder status 'active_limited'
--                                             (read-only until a platform
--                                             admin verifies)
--
-- 1. create_company_for_founder(): one transaction for company, owner
--    membership + verification, org.nr, cash account, chart of accounts,
--    settings, first fiscal period, active company and team sync. Replaces the
--    client-side sequence in lib/company/actions.ts, which ran seven separate
--    statements with a best-effort "rollback" (deletes that could themselves
--    fail and that RLS partly blocked).
-- 2. provision_authorized_signup_draft_v5(): the signup-draft path; wraps v4
--    and applies the verification in the same transaction.
-- 3. An access request raised by a verified founder against a company whose
--    owners are not verified goes to platform review
--    (requires_platform_review): an unverified owner is 'active_limited' and
--    cannot approve it, so a squatter can never gate the real signatory.
-- 4. bankid_identities: users could INSERT their own row (policy
--    bankid_identities_insert) with a chosen personal_number_hash. Only the
--    server-side BankID link flow (service role) writes this table; the policy
--    is dropped.
--
-- pg-test: tests/pg/company-founder-verification.pg.test.ts

BEGIN;

-- ---------------------------------------------------------------------------
-- 4. bankid_identities is server-written only
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS bankid_identities_insert ON public.bankid_identities;

-- ---------------------------------------------------------------------------
-- 3. Platform review flag on access requests
-- ---------------------------------------------------------------------------
ALTER TABLE public.company_access_requests
  ADD COLUMN IF NOT EXISTS requires_platform_review boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- Shared: apply a founder verification to the owner membership
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_founder_verification(
  p_company_id uuid,
  p_user_id uuid,
  p_status text,
  p_reason text,
  p_evidence jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_updated integer;
BEGIN
  IF p_status NOT IN ('verified', 'manual_review', 'self_attested') THEN
    RAISE EXCEPTION 'invalid founder verification status %', p_status USING ERRCODE = '22023';
  END IF;

  -- Only the founding owner, and only while undecided: a later platform
  -- decision (verified/rejected) is never overwritten by a re-run.
  UPDATE public.company_members cm
     SET verification_status = p_status,
         status = CASE WHEN p_status = 'manual_review' THEN 'active_limited' ELSE 'active' END,
         access_source = 'founder_signup',
         approved_by = CASE WHEN p_status = 'manual_review' THEN NULL ELSE p_user_id END,
         approved_at = CASE WHEN p_status = 'manual_review' THEN NULL ELSE now() END,
         updated_at = now()
   WHERE cm.company_id = p_company_id
     AND cm.user_id = p_user_id
     AND cm.role = 'owner'
     AND cm.verification_status IN ('not_required', 'self_attested');
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated > 0 THEN
    INSERT INTO public.auth_audit_events (user_id, company_id, event_type, status, metadata)
    VALUES (
      p_user_id, p_company_id, 'company_founder_verification',
      CASE WHEN p_status = 'manual_review' THEN 'blocked' ELSE 'success' END,
      jsonb_build_object('verification_status', p_status, 'reason', p_reason, 'evidence', coalesce(p_evidence, '{}'::jsonb))
    );
  END IF;

  RETURN v_updated > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_founder_verification(uuid, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_founder_verification(uuid, uuid, text, text, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- 3b. Flag an access request for platform review when appropriate
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.flag_access_request_for_verified_founder(
  p_request_id uuid,
  p_status text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_status <> 'verified' THEN
    RETURN;
  END IF;
  UPDATE public.company_access_requests r
     SET requires_platform_review = true, updated_at = now()
   WHERE r.id = p_request_id
     AND r.status = 'pending'
     AND NOT EXISTS (
       SELECT 1 FROM public.company_members cm
        WHERE cm.company_id = r.company_id
          AND cm.role = 'owner'
          AND cm.status = 'active'
          AND cm.verification_status = 'verified'
     );
END;
$$;

REVOKE ALL ON FUNCTION public.flag_access_request_for_verified_founder(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flag_access_request_for_verified_founder(uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 1. Atomic company creation for a verified founder
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_company_for_founder(
  p_user_id uuid,
  p_name text,
  p_entity_type text,
  p_team_id uuid,
  p_org_number text,
  p_settings jsonb,
  p_period_start date,
  p_period_end date,
  p_period_name text,
  p_verification_status text,
  p_verification_reason text,
  p_verification_evidence jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_set_list text;
  v_settings jsonb;
BEGIN
  IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_user_id) THEN
    RAISE EXCEPTION 'unknown user' USING ERRCODE = '42501';
  END IF;
  IF p_entity_type NOT IN ('enskild_firma', 'aktiebolag') THEN
    RAISE EXCEPTION 'Invalid entity_type: %', p_entity_type USING ERRCODE = '22023';
  END IF;
  IF p_verification_status NOT IN ('verified', 'manual_review', 'self_attested') THEN
    RAISE EXCEPTION 'invalid founder verification status %', p_verification_status USING ERRCODE = '22023';
  END IF;
  IF p_org_number IS NOT NULL AND p_org_number !~ '^\d{10}$' THEN
    RAISE EXCEPTION 'org_number must be 10 digits' USING ERRCODE = '22023';
  END IF;
  IF p_period_start IS NULL OR p_period_end IS NULL OR p_period_end <= p_period_start THEN
    RAISE EXCEPTION 'invalid fiscal period' USING ERRCODE = '22023';
  END IF;

  IF p_team_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.team_members tm WHERE tm.team_id = p_team_id AND tm.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'Not a member of team %', p_team_id USING ERRCODE = '42501';
  END IF;

  -- Same duplicate rule enforce_company_org_number_integrity applies to
  -- authenticated callers (it lets the service role through).
  IF p_org_number IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.companies c WHERE c.org_number = p_org_number AND c.archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Organisationsnumret är redan registrerat i Nordklart.' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.companies (name, entity_type, created_by, team_id, org_number)
  VALUES (coalesce(nullif(btrim(p_name), ''), 'Mitt företag'), p_entity_type, p_user_id, p_team_id, p_org_number)
  RETURNING id INTO v_company_id;

  INSERT INTO public.company_members (company_id, user_id, role, source, status, access_source, verification_status)
  VALUES (v_company_id, p_user_id, 'owner', 'direct', 'active_limited', 'founder_signup', 'not_required');

  PERFORM public.apply_founder_verification(
    v_company_id, p_user_id, p_verification_status, p_verification_reason, p_verification_evidence
  );

  INSERT INTO public.cash_accounts (company_id, ledger_account, currency, name, enabled, is_primary, source)
  VALUES (v_company_id, '1930', 'SEK', 'Företagskonto (SEK)', true, true, 'manual')
  ON CONFLICT (company_id, ledger_account) DO NOTHING;

  PERFORM public.seed_chart_of_accounts(v_company_id, p_entity_type);

  -- Settings: insert the row (column defaults apply), then set exactly the
  -- keys the wizard supplied that are real, non-managed columns.
  v_settings := coalesce(p_settings, '{}'::jsonb)
    - 'id' - 'user_id' - 'company_id' - 'created_at' - 'updated_at'
    - 'onboarding_complete' - 'onboarding_step' - 'entity_type' - 'org_number';

  INSERT INTO public.company_settings (company_id, user_id, entity_type, org_number, company_name, onboarding_complete, onboarding_step)
  VALUES (v_company_id, p_user_id, p_entity_type, p_org_number, coalesce(nullif(btrim(p_name), ''), 'Mitt företag'), true, 4)
  ON CONFLICT (company_id) DO NOTHING;

  SELECT string_agg(format('%1$I = (jsonb_populate_record(NULL::public.company_settings, $2)).%1$I', c.column_name), ', ')
    INTO v_set_list
    FROM information_schema.columns c
   WHERE c.table_schema = 'public'
     AND c.table_name = 'company_settings'
     AND v_settings ? c.column_name;

  IF v_set_list IS NOT NULL THEN
    EXECUTE format('UPDATE public.company_settings SET %s WHERE company_id = $1', v_set_list)
      USING v_company_id, v_settings;
  END IF;

  INSERT INTO public.fiscal_periods (company_id, user_id, name, period_start, period_end)
  VALUES (v_company_id, p_user_id, coalesce(nullif(btrim(p_period_name), ''), to_char(p_period_start, 'YYYY')), p_period_start, p_period_end);

  INSERT INTO public.user_preferences (user_id, active_company_id)
  VALUES (p_user_id, v_company_id)
  ON CONFLICT (user_id) DO UPDATE SET active_company_id = EXCLUDED.active_company_id;

  IF p_team_id IS NOT NULL THEN
    PERFORM public.sync_team_to_company(v_company_id, p_team_id);
  END IF;

  RETURN v_company_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_company_for_founder(uuid, text, text, uuid, text, jsonb, date, date, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_company_for_founder(uuid, text, text, uuid, text, jsonb, date, date, text, text, text, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Signup-draft provisioning with the verification in the same transaction
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.provision_authorized_signup_draft_v5(
  p_user_id uuid,
  p_verification_status text,
  p_verification_reason text,
  p_verification_evidence jsonb
)
RETURNS TABLE (
  provision_state text,
  company_id uuid,
  agency_id uuid,
  workspace_type text,
  onboarding_path text,
  provision_reference text,
  access_request_id uuid,
  existing_company_name text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r record;
BEGIN
  IF p_verification_status NOT IN ('verified', 'manual_review', 'self_attested') THEN
    RAISE EXCEPTION 'invalid founder verification status %', p_verification_status USING ERRCODE = '22023';
  END IF;

  SELECT * INTO r FROM public.provision_authorized_signup_draft_v4(p_user_id) LIMIT 1;

  IF r.provision_state = 'provisioned' AND r.company_id IS NOT NULL THEN
    PERFORM public.apply_founder_verification(
      r.company_id, p_user_id, p_verification_status, p_verification_reason, p_verification_evidence
    );
  ELSIF r.provision_state = 'access_request_pending' AND r.access_request_id IS NOT NULL THEN
    PERFORM public.flag_access_request_for_verified_founder(r.access_request_id, p_verification_status);
  END IF;

  RETURN QUERY SELECT r.provision_state, r.company_id, r.agency_id, r.workspace_type, r.onboarding_path,
                      r.provision_reference, r.access_request_id, r.existing_company_name;
END;
$$;

REVOKE ALL ON FUNCTION public.provision_authorized_signup_draft_v5(uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provision_authorized_signup_draft_v5(uuid, text, text, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. Platform decision on a founder in manual review
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.platform_decide_founder_verification(
  p_company_id uuid,
  p_user_id uuid,
  p_decision text,
  p_actor uuid,
  p_note text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_updated integer;
BEGIN
  IF p_decision NOT IN ('verified', 'rejected') THEN
    RAISE EXCEPTION 'invalid decision %', p_decision USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.platform_roles pr
     WHERE pr.user_id = p_actor AND pr.role = 'platform_admin' AND pr.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'platform_admin required' USING ERRCODE = '42501';
  END IF;

  UPDATE public.company_members cm
     SET verification_status = p_decision,
         status = CASE WHEN p_decision = 'verified' THEN 'active' ELSE 'suspended' END,
         approved_by = CASE WHEN p_decision = 'verified' THEN p_actor ELSE NULL END,
         approved_at = CASE WHEN p_decision = 'verified' THEN now() ELSE NULL END,
         updated_at = now()
   WHERE cm.company_id = p_company_id
     AND cm.user_id = p_user_id
     AND cm.role = 'owner'
     AND cm.verification_status = 'manual_review';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    RAISE EXCEPTION 'no founder awaiting review' USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.auth_audit_events (user_id, company_id, event_type, status, metadata)
  VALUES (p_actor, p_company_id, 'company_founder_verification_decided', 'success',
          jsonb_build_object('founder_user_id', p_user_id, 'decision', p_decision, 'note', p_note));

  RETURN p_decision;
END;
$$;

REVOKE ALL ON FUNCTION public.platform_decide_founder_verification(uuid, uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.platform_decide_founder_verification(uuid, uuid, text, uuid, text) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
