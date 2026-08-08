-- Pin search_path on the last three SECURITY DEFINER functions that lacked it.
--
-- A SECURITY DEFINER function with a mutable search_path runs its body with the
-- definer's privileges but resolves object names against the CALLER's
-- search_path. Anyone who can create objects in a schema that sorts earlier can
-- shadow a table or function the body references and have it executed with
-- elevated rights. That is the standard PostgreSQL privilege-escalation shape
-- and the reason `function_search_path_mutable` is a Supabase advisor finding.
--
-- 20260807120000 pinned the twelve accounting-critical functions. These three
-- were missed and are not less sensitive:
--
--   validate_and_increment_api_key  — resolves an API key hash to a user and
--     company and enforces the rate limit. Shadowing api_keys here would let a
--     caller mint their own authorization result.
--   block_document_deletion         — the WORM trigger enforcing BFL 7 kap
--     retention. Shadowing journal_entries would let it approve a deletion the
--     law forbids.
--   seed_chart_of_accounts          — writes a company's chart of accounts.
--
-- All three reference only objects in `public`, so `public, pg_temp` is the
-- correct pin — no extension schema is needed. pg_temp is listed last
-- explicitly; leaving it out entirely still lets PostgreSQL search it first.
--
-- ALTER FUNCTION ... SET is used rather than CREATE OR REPLACE on purpose: it
-- changes only the configuration and cannot accidentally drop a branch from a
-- body this migration does not restate. Redefining a function to change one
-- setting is precisely how six behavioural regressions reached production in
-- this repository.
--
-- pg-test: covered-by tests/pg/security-definer-search-path.pg.test.ts

BEGIN;

ALTER FUNCTION public.validate_and_increment_api_key(text)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.block_document_deletion()
  SET search_path = public, pg_temp;

ALTER FUNCTION public.seed_chart_of_accounts(uuid, text)
  SET search_path = public, pg_temp;

COMMIT;

NOTIFY pgrst, 'reload schema';
