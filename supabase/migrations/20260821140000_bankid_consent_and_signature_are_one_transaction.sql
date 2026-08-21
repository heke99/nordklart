-- =============================================================================
-- A BankID consent and the signature it completes are written together
--
-- Two defects in the årsredovisning signing flow, both in the same seam.
--
-- 1. THE EVIDENCE COLUMNS WERE NEVER WRITTEN. markSignatureSigned() set
--    status, signed_at and a bankid_signature_data blob — and left
--    signer_personnummer_hash and signer_personnummer_encrypted NULL, despite
--    both existing precisely so "who signed this" is provable, and despite
--    20260517090000 extending the immutability trigger to protect them. The
--    identity binding lived only inside a JSONB blob and a linked consent row.
--
-- 2. A FAILURE THERE WAS SWALLOWED. consent-service caught the error and only
--    logged it. The consent was recorded, the session went to 'complete', the
--    user saw a successful BankID signature — and the signature request stayed
--    'pending', so the årsredovisning was not signed off and the UI offered the
--    manual "Markera som signerad" button as if nothing had happened.
--
-- Both go away if the consent, its audit row and the signature request are one
-- transaction. Either the signature is evidenced everywhere or nowhere.
--
-- Replay-safe by construction: a second poll for the same session returns the
-- consent that already exists rather than inserting a second one, which is the
-- property the previous ordering ("consent first, then session status") was
-- built to get and which this keeps.
--
-- pg-test: covered-by tests/pg/bankid-consent-signature-atomicity.pg.test.ts
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.record_bankid_consent_v1(
  p_session_id uuid,
  p_actor_user_id uuid,
  p_consent_type text,
  p_title text,
  p_consent_text text,
  p_personal_number_hash text,
  p_personal_number_masked text,
  p_signer_name text,
  p_context jsonb,
  p_completed_at timestamptz,
  p_signature_request_id uuid DEFAULT NULL,
  p_signer_personnummer_encrypted bytea DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session public.bankid_sessions%ROWTYPE;
  v_consent_id uuid;
  v_signature public.arsredovisning_signature_requests%ROWTYPE;
  v_signature_data jsonb;
BEGIN
  PERFORM public.require_service_role();

  IF p_session_id IS NULL OR p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'Invalid consent input.'
      USING ERRCODE = '22023', DETAIL = '{"code":"VALIDATION_ERROR"}';
  END IF;

  -- The session is the authorization: it was created for this user, and the
  -- provider confirmed the completion against its order reference.
  SELECT * INTO v_session FROM public.bankid_sessions
  WHERE id = p_session_id AND user_id = p_actor_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'BankID session not found for this user.'
      USING ERRCODE = 'P0002', DETAIL = '{"code":"BANKID_SESSION_NOT_FOUND"}';
  END IF;

  -- Replay: a concurrent poll already recorded this signature.
  SELECT id INTO v_consent_id FROM public.signed_consents
  WHERE bankid_session_id = p_session_id;
  IF FOUND THEN
    RETURN v_consent_id;
  END IF;

  INSERT INTO public.signed_consents (
    company_id, user_id, consent_type, title, consent_text, signed_via,
    bankid_session_id, personal_number_hash, personal_number_masked,
    signer_name, status, context
  ) VALUES (
    v_session.company_id, v_session.user_id, p_consent_type, p_title,
    coalesce(p_consent_text, ''), 'bankid', p_session_id,
    p_personal_number_hash, p_personal_number_masked, p_signer_name,
    'active', coalesce(p_context, '{}'::jsonb)
  ) RETURNING id INTO v_consent_id;

  INSERT INTO public.audit_log (
    user_id, company_id, action, table_name, record_id, actor_id, description, new_state
  ) VALUES (
    v_session.user_id, v_session.company_id, 'SECURITY_EVENT', 'signed_consents',
    v_consent_id, v_session.user_id,
    format('BankID-signerat samtycke: %s (%s), signerat av %s %s',
           p_title, p_consent_type,
           coalesce(p_signer_name, 'okänd'), coalesce(p_personal_number_masked, '')),
    jsonb_build_object(
      'consent_type', p_consent_type,
      'signer_name', p_signer_name,
      'personal_number_masked', p_personal_number_masked)
  );

  IF p_signature_request_id IS NOT NULL THEN
    SELECT * INTO v_signature FROM public.arsredovisning_signature_requests
    WHERE id = p_signature_request_id AND company_id = v_session.company_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Signature request not found for this company.'
        USING ERRCODE = 'P0002', DETAIL = '{"code":"SIGNATURE_REQUEST_NOT_FOUND"}';
    END IF;

    IF v_signature.status = 'signed' THEN
      -- Only a replay of THIS session may find it already signed. Anything else
      -- means two different signatures are competing for one request, and
      -- silently accepting that would attribute the wrong signer.
      IF coalesce(v_signature.bankid_signature_data->>'bankid_session_id', '') <> p_session_id::text THEN
        RAISE EXCEPTION 'Signature request was already signed by another session.'
          USING ERRCODE = 'P0001', DETAIL = '{"code":"SIGNATURE_REQUEST_ALREADY_SIGNED"}';
      END IF;
      RETURN v_consent_id;
    END IF;

    v_signature_data := jsonb_build_object(
      'consent_id', v_consent_id,
      'bankid_session_id', p_session_id,
      'signer_name', p_signer_name,
      'personal_number_masked', p_personal_number_masked,
      'signed_at', p_completed_at
    );

    -- The evidence columns are filled here, in the same statement that flips
    -- the status. After this the immutability trigger freezes all of them.
    UPDATE public.arsredovisning_signature_requests
       SET status = 'signed',
           signed_at = coalesce(p_completed_at, now()),
           signer_name = coalesce(p_signer_name, signer_name),
           signer_personnummer_hash = coalesce(p_personal_number_hash, signer_personnummer_hash),
           signer_personnummer_encrypted =
             coalesce(p_signer_personnummer_encrypted, signer_personnummer_encrypted),
           bankid_signature_data = v_signature_data,
           updated_at = now()
     WHERE id = p_signature_request_id;
  END IF;

  RETURN v_consent_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_bankid_consent_v1(uuid,uuid,text,text,text,text,text,text,jsonb,timestamptz,uuid,bytea)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_bankid_consent_v1(uuid,uuid,text,text,text,text,text,text,jsonb,timestamptz,uuid,bytea)
  TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
