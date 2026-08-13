-- Second convergence pass: the objects production is MISSING.
--
-- 20260811120000 converged the objects whose definitions disagreed and dropped
-- four `FOR ALL` policies that authorized writes on read-level membership. On
-- three of those tables production turned out not to carry the canonical
-- replacement, so dropping the loose policy left the table with a SELECT policy
-- and no write path at all. That is corrected here by creating the canonical
-- policy, which is what the chain has always defined:
--
--   payment_collection_events_platform_write
--   payment_provider_accounts_platform_write
--   year_end_purchase_access_platform_write
--
-- All three are platform-admin only — `USING is_platform_admin()` — which is
-- the intended model for provider plumbing and purchased entitlements: company
-- members read their own rows, and only the platform mutates them. The dropped
-- policies let any member of the company write them, which is why they went.
-- (skatteverket_company_settings needed no restore: production already carried
-- the canonical per-command insert/update/delete policies gated on write
-- capability.)
--
-- The same content fingerprint also found three CHECK constraints missing from
-- public.bankgiro_applications. Two are value-domain guards the application
-- already writes against, and one is a numeric range:
--
--   documents_status       not_started | incomplete | ready | rejected
--   provider_setup_status  not_started | waiting_provider | active | failed | paused
--   risk_score             0..100
--
-- Without them production accepts states no reader knows how to interpret, and
-- a risk score outside the scale the UI renders. Both columns already exist and
-- production holds no bankgiro applications, so the constraints validate
-- against an empty table.
--
-- Definitions are copied from the canonical replay. On a database that already
-- matches the chain this migration is a no-op.
--
-- pg-test: covered-by tests/pg/tenant-isolation-matrix.pg.test.ts

BEGIN;

-- ── write paths the canonical chain defines ─────────────────────────────────
drop policy if exists payment_collection_events_platform_write on public.payment_collection_events;
create policy payment_collection_events_platform_write on public.payment_collection_events
  for all to public
  using (is_platform_admin())
  with check (is_platform_admin());

drop policy if exists payment_provider_accounts_platform_write on public.payment_provider_accounts;
create policy payment_provider_accounts_platform_write on public.payment_provider_accounts
  for all to public
  using (is_platform_admin())
  with check (is_platform_admin());

drop policy if exists year_end_purchase_access_platform_write on public.year_end_purchase_access;
create policy year_end_purchase_access_platform_write on public.year_end_purchase_access
  for all to public
  using (is_platform_admin())
  with check (is_platform_admin());

-- ── value domains on bankgiro_applications ──────────────────────────────────
alter table public.bankgiro_applications
  drop constraint if exists bankgiro_applications_documents_status_check;
alter table public.bankgiro_applications
  add constraint bankgiro_applications_documents_status_check
  check (documents_status = any (array['not_started'::text, 'incomplete'::text, 'ready'::text, 'rejected'::text]));

alter table public.bankgiro_applications
  drop constraint if exists bankgiro_applications_provider_setup_status_check;
alter table public.bankgiro_applications
  add constraint bankgiro_applications_provider_setup_status_check
  check (provider_setup_status = any (array['not_started'::text, 'waiting_provider'::text, 'active'::text, 'failed'::text, 'paused'::text]));

alter table public.bankgiro_applications
  drop constraint if exists bankgiro_applications_risk_score_check;
alter table public.bankgiro_applications
  add constraint bankgiro_applications_risk_score_check
  check ((risk_score >= 0) and (risk_score <= 100));

COMMIT;

NOTIFY pgrst, 'reload schema';
