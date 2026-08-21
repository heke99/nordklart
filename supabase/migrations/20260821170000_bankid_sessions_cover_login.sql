-- =============================================================================
-- Let the login flow live in bankid_sessions too
--
-- Nordklart has one BankID abstraction (lib/auth/bankid-provider.ts) and one
-- table recording BankID orders (bankid_sessions) — and the login/signup flow
-- used neither. It called the TIC client directly and kept no record at all, so
-- the audit trail covered consent and årsredovisning signing but not the one
-- flow that hands out a session. "Which BankID orders preceded this account
-- being created?" had no answer.
--
-- The table could not hold those rows: `user_id` is NOT NULL, and at the moment
-- a login order starts there is no user yet — resolving the personnummer to an
-- account is the whole point of the order. So the column becomes nullable for
-- exactly that case and stays required for every other purpose, which is what
-- the CHECK below says.
--
-- RLS is unchanged and needs no exception: `user_id = auth.uid()` is false for
-- a NULL user_id under every role, so a pre-authentication row is invisible to
-- clients. The login routes write it with the service role, and set user_id
-- once the order completes and an account is known.
--
-- pg-test: covered-by tests/pg/bankid-login-sessions.pg.test.ts
-- =============================================================================

BEGIN;

ALTER TABLE public.bankid_sessions
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE public.bankid_sessions
  DROP CONSTRAINT IF EXISTS bankid_sessions_user_required_unless_auth;

ALTER TABLE public.bankid_sessions
  ADD CONSTRAINT bankid_sessions_user_required_unless_auth
  CHECK (user_id IS NOT NULL OR purpose = 'auth');

COMMENT ON COLUMN public.bankid_sessions.user_id IS
  'The account the order belongs to. NULL only while a purpose=''auth'' order '
  'is still resolving which account the personnummer maps to; the login '
  'completion step fills it in. Every other purpose requires it up front.';

-- The provider reference is how the poll and complete steps find the row they
-- started. Two live orders must never share one, or a poll could settle the
-- wrong session.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bankid_sessions_provider_ref_unique
  ON public.bankid_sessions (provider, provider_session_ref);

DROP INDEX IF EXISTS public.idx_bankid_sessions_provider_ref;

-- The user index carried NULLs for free before this change; keep it honest by
-- excluding the rows that have no user yet.
DROP INDEX IF EXISTS public.idx_bankid_sessions_user;
CREATE INDEX IF NOT EXISTS idx_bankid_sessions_user
  ON public.bankid_sessions (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

-- Unclaimed login orders are pre-authentication records with no owner, so they
-- cannot be retained on the account's schedule. Anything still unclaimed after
-- 30 days is abandoned; the sweep runs from the existing cleanup cron.
CREATE OR REPLACE FUNCTION public.cleanup_unclaimed_bankid_sessions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.bankid_sessions
   WHERE user_id IS NULL
     AND created_at < now() - interval '30 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_unclaimed_bankid_sessions()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_unclaimed_bankid_sessions() TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
