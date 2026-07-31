BEGIN;

CREATE SCHEMA IF NOT EXISTS extensions;

CREATE EXTENSION IF NOT EXISTS pgcrypto
WITH SCHEMA extensions;

ALTER FUNCTION public.register_year_end_fx_rate_snapshots(
  uuid,
  uuid,
  uuid,
  date,
  jsonb
)
SET search_path = public, extensions, pg_temp;

ALTER FUNCTION public.post_currency_revaluation(
  uuid,
  uuid,
  uuid,
  date,
  text,
  jsonb,
  jsonb
)
SET search_path = public, extensions, pg_temp;

NOTIFY pgrst, 'reload schema';

COMMIT;