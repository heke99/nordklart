-- =============================================================================
-- Drop user_identity_verifications
--
-- Added alongside bankid_sessions and signed_consents in 20260710120000 as
-- "BankID identity-verification events per user", and never written by
-- anything. No insert, no read, no route — an empty table in both the local
-- replay and production (verified 0 rows in each before this migration).
--
-- It is also redundant now: bankid_sessions records exactly the same facts for
-- every BankID order, including the login orders it did not cover before
-- 20260821170000 — provider, personnummer hash and mask, verified name, and
-- completion time, per user. Two tables claiming to be the identity-
-- verification history, one of them always empty, is worse than one.
--
-- Its only inbound reference is its own FK to bankid_sessions, so nothing
-- depends on it. If per-user verification history is ever wanted as a distinct
-- concept, it should be a view over bankid_sessions rather than a second
-- write path that can disagree with the first.
--
-- Safe to drop rather than deprecate: dropping an empty, unreferenced,
-- never-written table removes no bookkeeping record and no personal data.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_rows bigint;
BEGIN
  IF to_regclass('public.user_identity_verifications') IS NULL THEN
    RETURN;
  END IF;

  -- Never drop data on an assumption. If a deployment somehow started writing
  -- to this table, stop and make that a conscious decision instead.
  EXECUTE 'SELECT count(*) FROM public.user_identity_verifications' INTO v_rows;
  IF v_rows > 0 THEN
    RAISE EXCEPTION
      'user_identity_verifications holds % row(s); refusing to drop. Migrate them into bankid_sessions first.',
      v_rows;
  END IF;

  EXECUTE 'DROP TABLE public.user_identity_verifications';
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
