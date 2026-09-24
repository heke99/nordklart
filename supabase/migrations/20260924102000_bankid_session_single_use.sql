-- =============================================================================
-- BankID orders are single-use, and a link order belongs to whoever started it
--
-- /bankid/complete re-reads the order from the provider with result(), which
-- is idempotent by design, and mints a magic-link token for the account the
-- personnummer resolves to. Nothing recorded that the order had already been
-- turned into a login, so anyone holding a completed sessionId could mint
-- fresh login tokens for that account for as long as the provider kept the
-- result. /bankid/link had the same shape one level up: it accepted ANY
-- completed sessionId and attached that personnummer to the caller's account,
-- whoever had actually scanned the QR code.
--
-- consume_bankid_session() is the one gate both routes pass through. It marks
-- the order consumed in a single statement — INSERT … ON CONFLICT DO UPDATE …
-- WHERE consumed_at IS NULL — so of two concurrent requests exactly one gets
-- `true`. The start row is written best-effort (the audit log must never block
-- a login), so a missing row is created here already consumed rather than
-- treated as an error.
--
-- For link orders /bankid/start records the signed-in user as
-- initiator_user_id, and consumption refuses unless the caller is that user.
--
-- pg-test: covered-by tests/pg/bankid-session-single-use.pg.test.ts
-- =============================================================================

BEGIN;

ALTER TABLE public.bankid_sessions
  ADD COLUMN IF NOT EXISTS consumed_at timestamptz,
  ADD COLUMN IF NOT EXISTS consumed_for text,
  ADD COLUMN IF NOT EXISTS initiator_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.bankid_sessions
  DROP CONSTRAINT IF EXISTS bankid_sessions_consumed_for_check;
ALTER TABLE public.bankid_sessions
  ADD CONSTRAINT bankid_sessions_consumed_for_check
  CHECK (consumed_for IS NULL OR consumed_for IN ('login', 'link'));

CREATE OR REPLACE FUNCTION public.consume_bankid_session(
  p_provider text,
  p_session_ref text,
  p_kind text,
  p_user_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_id uuid;
  v_initiator uuid;
BEGIN
  IF p_kind NOT IN ('login', 'link') THEN
    RAISE EXCEPTION 'invalid consume kind %', p_kind USING ERRCODE = '22023';
  END IF;

  IF p_kind = 'link' THEN
    IF p_user_id IS NULL THEN
      RAISE EXCEPTION 'link consumption requires a user' USING ERRCODE = '22023';
    END IF;
    -- A link order must have been started by the same signed-in user. No row
    -- (or no recorded initiator) means we cannot prove that, so refuse.
    SELECT initiator_user_id INTO v_initiator
      FROM public.bankid_sessions
     WHERE provider = p_provider AND provider_session_ref = p_session_ref;
    IF v_initiator IS NULL OR v_initiator <> p_user_id THEN
      RETURN false;
    END IF;
  END IF;

  INSERT INTO public.bankid_sessions AS s (
    provider, provider_session_ref, purpose, status, consumed_at, consumed_for, context
  )
  VALUES (
    p_provider, p_session_ref, 'auth', 'complete', now(), p_kind,
    jsonb_build_object('kind', p_kind, 'start_row_missing', true)
  )
  ON CONFLICT (provider, provider_session_ref) DO UPDATE
     SET consumed_at = now(),
         consumed_for = p_kind,
         updated_at = now()
   WHERE s.consumed_at IS NULL
     AND s.purpose = 'auth'
  RETURNING s.id INTO v_id;

  RETURN v_id IS NOT NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.consume_bankid_session(text, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_bankid_session(text, text, text, uuid) TO service_role;

COMMIT;
