-- pg-real local bootstrap for PLAIN PostgreSQL (non-Supabase image).
--
-- The CI workflow runs against supabase/postgres which ships the auth schema,
-- Supabase roles and the supabase_realtime publication. When running the
-- pg-real suite against a locally installed PostgreSQL (e.g. apt postgresql-16
-- with pgvector + pg_cron), run this file BEFORE tests/pg/bootstrap.sql and
-- before applying supabase/migrations/*.sql. It is idempotent.
--
-- Usage:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/pg/bootstrap-plain-postgres.sql
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/pg/bootstrap.sql
--   for f in supabase/migrations/*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done

-- ---------------------------------------------------------------------------
-- Roles (Supabase ships these; plain Postgres does not)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    CREATE ROLE supabase_admin NOLOGIN BYPASSRLS;
  END IF;
END
$$;

-- The test harness switches into these roles via SET LOCAL ROLE.
GRANT anon, authenticated, service_role TO CURRENT_USER;

-- ---------------------------------------------------------------------------
-- Schemas
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS extensions;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;

-- Migrations create objects in public and grant per-object; tests also need
-- default access to sequences created later.
--
-- `anon` is included deliberately, and this is the one place where matching
-- production matters more than looking safe. A Supabase project ships with
--
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT ALL ON TABLES/FUNCTIONS/SEQUENCES TO anon, authenticated, service_role
--
-- from both `postgres` and `supabase_admin`, so in production `anon` holds
-- ~2000 table privileges and EXECUTE on everything in `public`. RLS is what
-- actually stops it — that is Supabase's model, and it holds today: 0 of 280
-- tables lack RLS, no policy names anon, and anon does not bypass RLS.
--
-- This bootstrap used to omit anon, which made the replay grant LESS than
-- production. That is the dangerous direction: a table shipped without RLS, or
-- a SECURITY DEFINER function that forgot its REVOKE, would be unreachable for
-- anon here and wide open there — and the test suite would go green either way.
-- Granting anon the same defaults means a test that passes locally passes for
-- the same reason production is safe, not for a reason production does not have.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- auth.users — minimal shape our migrations reference (FKs + email join)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth.users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id        uuid,
  aud                text,
  role               text,
  email              text,
  encrypted_password text,
  raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
  raw_app_meta_data  jsonb DEFAULT '{}'::jsonb,
  email_confirmed_at timestamptz,
  phone              text,
  created_at         timestamptz DEFAULT now(),
  updated_at         timestamptz DEFAULT now()
);

GRANT SELECT ON auth.users TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- auth.uid() / auth.jwt() / auth.role() — mirror Supabase semantics
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.sub', true), ''),
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;

CREATE OR REPLACE FUNCTION auth.jwt()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  )
$$;

-- auth.role() reads `request.jwt.claim.role` ONLY, with no fallback to the
-- claims blob — matching the `supabase/postgres` image CI runs against, not the
-- more forgiving shape in Supabase's current docs.
--
-- Stricter on purpose. With the fallback, a test that set only
-- `request.jwt.claims` got a working auth.role() here and NULL in CI, so
-- `commit-journal-entry-authorization` passed locally while the anon guard it
-- exists to prove was silently skipped on the runner — red in CI for twelve
-- days, green on every developer machine. The replay must never be more
-- forgiving than the environment it stands in for; that is the same lesson as
-- the anon default-grants above, and it costs one extra set_config in
-- `withAnonContext`.
CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.role', true), '')
$$;

GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.jwt() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Realtime publication (migrations ALTER PUBLICATION supabase_realtime ...)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Extensions the migrations expect (available in contrib / pgvector / pg_cron)
-- Supabase installs them into the `extensions` schema and puts that schema on
-- the default search_path.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

ALTER DATABASE postgres SET search_path TO "$user", public, extensions;
SET search_path TO "$user", public, extensions;
