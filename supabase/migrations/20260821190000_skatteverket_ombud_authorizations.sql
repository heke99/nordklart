-- =============================================================================
-- Ombudsbehörighet: record what Skatteverket actually said, never what a link
-- click implied
--
-- Filing a momsdeklaration or an AGI for someone else's company requires
-- authorisation at Skatteverket — firmatecknare, or a deklarationsombud the
-- company registered on Mina sidor. There is no API to grant it (SKV-02), and
-- there is no API that answers "is this actor authorised?" directly either.
--
-- What there IS: every call carries the answer. A 403 whose body names
-- "behörighet" is Skatteverket saying no. A call that succeeds for a company is
-- Skatteverket saying yes. Those are the only two facts about authorisation the
-- system can honestly hold, and this table holds exactly them — one row per
-- (company, auth flow), carrying the provider response that established it.
--
-- The rule this table exists to enforce is that `status = 'active'` is
-- unreachable except through an observation of a real provider response.
-- Opening an authorisation link, starting a flow, or a user asserting they are
-- the firmatecknare must never produce it: an authorisation the product
-- believes in but Skatteverket does not is how a filing silently fails at the
-- deadline. Enforcement is structural, not conventional:
--
--   * no INSERT/UPDATE/DELETE grants to anon or authenticated,
--   * RLS SELECT only, scoped to the caller's companies,
--   * writes go through record_skv_ombud_observation(), which is service-role
--     only and derives the status from the observation rather than accepting
--     one,
--   * and a trigger that refuses any write not made by that function, so a
--     future service-role code path cannot set 'active' by hand either.
--
-- 'manual_attestation' exists for the case the product must support today: the
-- user says they are authorised and files anyway. It is recorded as
-- `claimed`, never `active`, and carries who claimed it and when.
--
-- pg-test: covered-by tests/pg/skatteverket-ombud-authorizations.pg.test.ts
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.skatteverket_ombud_authorizations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- The identity the filing is made for, as sent to SKV. Kept alongside
  -- company_id because a company's org number can be corrected, and an
  -- observation is about the number that was actually used.
  org_number      text NOT NULL,
  -- Which credential the observation was made through. Authorisation is not
  -- transferable between them: a user's BankID session proving they may act
  -- says nothing about the organisation certificate, and vice versa.
  auth_flow       text NOT NULL CHECK (auth_flow IN ('per_bankid', 'ccg_sysorg', 'org_acg')),

  status          text NOT NULL DEFAULT 'unknown'
                    CHECK (status IN ('unknown', 'claimed', 'active', 'denied')),

  -- How the current status was established.
  source          text NOT NULL DEFAULT 'none'
                    CHECK (source IN ('none', 'skv_response', 'manual_attestation')),

  -- The evidence itself: for skv_response, the correlation id, status code and
  -- SKV error code of the call that settled it. Never a response body — those
  -- can carry personal data and this row is retained.
  evidence        jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Who is on the hook when source = 'manual_attestation'.
  claimed_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  claimed_at      timestamptz,

  observed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- 'active' and 'denied' are statements about Skatteverket's answer, so they
  -- require an observation of one. 'claimed' requires a claimant.
  CONSTRAINT skv_ombud_active_requires_response
    CHECK (status <> 'active' OR (source = 'skv_response' AND observed_at IS NOT NULL)),
  CONSTRAINT skv_ombud_denied_requires_response
    CHECK (status <> 'denied' OR (source = 'skv_response' AND observed_at IS NOT NULL)),
  CONSTRAINT skv_ombud_claimed_requires_claimant
    CHECK (status <> 'claimed' OR (source = 'manual_attestation' AND claimed_by IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_skv_ombud_company_flow
  ON public.skatteverket_ombud_authorizations (company_id, auth_flow);

ALTER TABLE public.skatteverket_ombud_authorizations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS skv_ombud_select ON public.skatteverket_ombud_authorizations;
CREATE POLICY skv_ombud_select ON public.skatteverket_ombud_authorizations
  FOR SELECT USING (public.user_can_access_company_v2(company_id));

-- No insert/update/delete policies, and no grants beyond SELECT: the only
-- writer is the SECURITY DEFINER function below.
REVOKE ALL ON TABLE public.skatteverket_ombud_authorizations FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.skatteverket_ombud_authorizations FROM authenticated;
GRANT SELECT ON TABLE public.skatteverket_ombud_authorizations TO authenticated;

COMMENT ON TABLE public.skatteverket_ombud_authorizations IS
  'What Skatteverket answered about a company''s ombud/firmatecknare authorisation, '
  'per auth flow. status=active is only reachable from an observed provider response; '
  'a user assertion is recorded as claimed. Written only by record_skv_ombud_observation().';

-- -----------------------------------------------------------------------------
-- Write guard
--
-- The function below sets a transaction-local flag before writing. Anything
-- else — including another service-role code path that decides to UPDATE the
-- table directly — is refused. Without this, "only the RPC writes it" would be
-- a comment rather than a rule.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.skv_ombud_guard_direct_writes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF coalesce(current_setting('nordklart.skv_ombud_write', true), '') <> 'on' THEN
    RAISE EXCEPTION
      'skatteverket_ombud_authorizations skrivs bara via record_skv_ombud_observation().'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_skv_ombud_guard ON public.skatteverket_ombud_authorizations;
CREATE TRIGGER trg_skv_ombud_guard
  BEFORE INSERT OR UPDATE ON public.skatteverket_ombud_authorizations
  FOR EACH ROW EXECUTE FUNCTION public.skv_ombud_guard_direct_writes();

-- -----------------------------------------------------------------------------
-- record_skv_ombud_observation
--
-- p_observation is what happened, not what to store:
--   { "kind": "skv_response", "authorized": true|false,
--     "correlation_id": "...", "status_code": 200, "skv_error_code": "..." }
--   { "kind": "manual_attestation", "claimed_by": "<uuid>" }
--
-- The status is derived here so no caller can assert one.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_skv_ombud_observation(
  p_company_id  uuid,
  p_org_number  text,
  p_auth_flow   text,
  p_observation jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_kind        text := p_observation->>'kind';
  v_status      text;
  v_source      text;
  v_claimed_by  uuid;
  v_evidence    jsonb;
  v_now         timestamptz := now();
  v_existing    public.skatteverket_ombud_authorizations;
  v_row         public.skatteverket_ombud_authorizations;
BEGIN
  PERFORM public.require_service_role();

  IF p_company_id IS NULL OR p_org_number IS NULL OR btrim(p_org_number) = '' THEN
    RAISE EXCEPTION 'company_id och org_number krävs' USING ERRCODE = '22023';
  END IF;

  IF v_kind = 'skv_response' THEN
    v_source := 'skv_response';
    v_status := CASE WHEN (p_observation->>'authorized')::boolean THEN 'active' ELSE 'denied' END;
    -- Deliberately no response body: this row is retained, and SKV bodies can
    -- carry personal data.
    v_evidence := jsonb_strip_nulls(jsonb_build_object(
      'correlation_id', p_observation->>'correlation_id',
      'status_code',    (p_observation->>'status_code')::int,
      'skv_error_code', p_observation->>'skv_error_code',
      'operation',      p_observation->>'operation'
    ));
  ELSIF v_kind = 'manual_attestation' THEN
    v_source := 'manual_attestation';
    v_status := 'claimed';
    v_claimed_by := (p_observation->>'claimed_by')::uuid;
    IF v_claimed_by IS NULL THEN
      RAISE EXCEPTION 'claimed_by krävs för manual_attestation' USING ERRCODE = '22023';
    END IF;
    v_evidence := '{}'::jsonb;
  ELSE
    RAISE EXCEPTION 'okänd observationstyp: %', coalesce(v_kind, '(null)') USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing
    FROM public.skatteverket_ombud_authorizations
   WHERE company_id = p_company_id AND auth_flow = p_auth_flow
   FOR UPDATE;

  -- A user's claim must never overwrite what Skatteverket said — in either
  -- direction. Once there is a real answer, only another real answer changes it.
  IF v_existing.id IS NOT NULL
     AND v_source = 'manual_attestation'
     AND v_existing.source = 'skv_response' THEN
    RETURN jsonb_build_object(
      'status', v_existing.status, 'source', v_existing.source, 'changed', false
    );
  END IF;

  PERFORM set_config('nordklart.skv_ombud_write', 'on', true);

  INSERT INTO public.skatteverket_ombud_authorizations AS a
    (company_id, org_number, auth_flow, status, source, evidence,
     claimed_by, claimed_at, observed_at, updated_at)
  VALUES
    (p_company_id, btrim(p_org_number), p_auth_flow, v_status, v_source, v_evidence,
     v_claimed_by,
     CASE WHEN v_source = 'manual_attestation' THEN v_now END,
     CASE WHEN v_source = 'skv_response' THEN v_now END,
     v_now)
  ON CONFLICT (company_id, auth_flow) DO UPDATE
    SET org_number  = EXCLUDED.org_number,
        status      = EXCLUDED.status,
        source      = EXCLUDED.source,
        evidence    = EXCLUDED.evidence,
        claimed_by  = coalesce(EXCLUDED.claimed_by, a.claimed_by),
        claimed_at  = coalesce(EXCLUDED.claimed_at, a.claimed_at),
        observed_at = coalesce(EXCLUDED.observed_at, a.observed_at),
        updated_at  = v_now
  RETURNING * INTO v_row;

  PERFORM set_config('nordklart.skv_ombud_write', 'off', true);

  RETURN jsonb_build_object(
    'status', v_row.status, 'source', v_row.source, 'changed', true
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_skv_ombud_observation(uuid,text,text,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_skv_ombud_observation(uuid,text,text,jsonb)
  TO service_role;

REVOKE ALL ON FUNCTION public.skv_ombud_guard_direct_writes() FROM PUBLIC, anon, authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
