-- Converge the objects where production still disagrees with the migration chain.
--
-- A content fingerprint of every function, view, policy, trigger, constraint,
-- index, column, RLS flag and grant in `public` — production against a clean
-- replay of this repository into an empty database — found the two databases
-- agreeing on all but a handful of objects. Object *existence* had always
-- matched; the definitions had not, which is precisely the case migration
-- ledgers cannot see and why the reconciler was rebuilt around content.
--
-- The material finding was public.resolve_company_access(). Production carried
-- an older inline body that read company_members without consulting
-- company_member_is_active(cm.status), and joined agency_members without
-- requiring am.status = 'active'. A suspended member and a revoked agency
-- consultant therefore still resolved to a writable role — the same defect
-- class as the revoked platform_role that authorized in #21. That one is fixed
-- by deploying 20260713120000 and 20260714120000, which were never applied.
--
-- What remains, and is fixed here, is everything those two files do not own:
--
--   user_company_ids()            production omitted `archived_at is null`, so
--                                 archived companies stayed inside the tenancy
--                                 set every RLS policy is built on.
--   company_has_feature()         production carried a pre-company_feature_access
--                                 body, so entitlement answers came from a
--                                 different source than the canonical one.
--   sync_subscription_entitlements()  ditto for the subscription trigger.
--
--   agency_members_role_check     production's vocabulary lacked 'payroll'.
--   agency_invitations_role_check ditto.
--   signup_drafts_status_check    production's lacked 'access_request_pending',
--                                 which provision_authorized_signup_draft_v4
--                                 writes — the same "function writes a value its
--                                 own CHECK forbids" defect fixed three times
--                                 already (sie_import_reversal, the atomic
--                                 settlements, and 'system').
--
--   four `FOR ALL` policies       payment_collection_events_write,
--                                 payment_provider_accounts_write,
--                                 skatteverket_company_settings_write and
--                                 year_end_purchase_access_write exist only in
--                                 production. They authorize on
--                                 user_can_access_company_v2 — read-level
--                                 membership — and being FOR ALL they cover
--                                 INSERT, UPDATE and DELETE. Policies are OR'd,
--                                 so each one re-opens for its table exactly the
--                                 hole 20260808170000 and 20260810120000 closed
--                                 everywhere else. They are dropped rather than
--                                 rewritten because the canonical chain does not
--                                 define them at all; the per-command policies
--                                 that replaced them are already in place.
--
-- Every definition below is copied from the canonical replay, not composed. On
-- a database already matching the chain this migration is a no-op, which is
-- what makes it safe to carry in the chain itself.
--
-- pg-test: covered-by tests/pg/tenant-isolation-matrix.pg.test.ts

BEGIN;

-- ── tenancy helper: archived companies are not part of the tenancy set ───────
create or replace function public.user_company_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select c.id
  from public.companies c
  where c.archived_at is null
    and public.user_can_access_company_v2(c.id);
$$;

-- ── entitlement resolution ──────────────────────────────────────────────────
create or replace function public.company_has_feature(p_company_id uuid, p_feature_code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select cfa.allowed
    from public.company_feature_access(p_company_id, p_feature_code) cfa
    limit 1
  ), false);
$$;

create or replace function public.sync_subscription_entitlements()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.company_entitlements
  set
    enabled = false,
    expires_at = coalesce(new.current_period_end, new.trial_ends_at, new.grace_ends_at, now()),
    updated_at = now()
  where company_id = new.company_id
    and source = 'plan'
    and source_id = new.id
    and enabled = true;

  insert into public.company_subscription_items (
    subscription_id,
    company_id,
    plan_version_id,
    item_type,
    status,
    quantity,
    starts_at,
    current_period_start,
    current_period_end,
    cancelled_at,
    grace_ends_at,
    external_provider,
    external_subscription_item_id,
    price_snapshot,
    created_by
  )
  values (
    new.id,
    new.company_id,
    new.plan_version_id,
    'base_plan',
    new.status,
    1,
    new.starts_at,
    new.current_period_start,
    new.current_period_end,
    new.cancelled_at,
    new.grace_ends_at,
    new.external_provider,
    null,
    new.price_snapshot,
    new.created_by
  )
  on conflict (subscription_id) where item_type = 'base_plan' do update set
    company_id = excluded.company_id,
    plan_version_id = excluded.plan_version_id,
    status = excluded.status,
    starts_at = excluded.starts_at,
    current_period_start = excluded.current_period_start,
    current_period_end = excluded.current_period_end,
    cancelled_at = excluded.cancelled_at,
    grace_ends_at = excluded.grace_ends_at,
    external_provider = excluded.external_provider,
    price_snapshot = excluded.price_snapshot,
    updated_at = now();

  return new;
end;
$$;

-- ── CHECK vocabularies the writers already depend on ────────────────────────
alter table public.agency_members
  drop constraint if exists agency_members_role_check;
alter table public.agency_members
  add constraint agency_members_role_check
  check (role = any (array['agency_owner'::text, 'agency_admin'::text, 'accountant'::text, 'payroll'::text, 'reviewer'::text, 'read_only'::text]));

alter table public.agency_invitations
  drop constraint if exists agency_invitations_role_check;
alter table public.agency_invitations
  add constraint agency_invitations_role_check
  check (role = any (array['agency_admin'::text, 'accountant'::text, 'payroll'::text, 'reviewer'::text, 'read_only'::text]));

alter table public.signup_drafts
  drop constraint if exists signup_drafts_status_check;
alter table public.signup_drafts
  add constraint signup_drafts_status_check
  check (status = any (array['pending_verification'::text, 'email_verified_pending_password'::text, 'ready_for_first_login'::text, 'provisioning'::text, 'provisioned'::text, 'access_request_pending'::text, 'expired'::text, 'cancelled'::text, 'failed'::text]));

-- ── membership-only FOR ALL policies that exist only in production ──────────
drop policy if exists payment_collection_events_write on public.payment_collection_events;
drop policy if exists payment_provider_accounts_write on public.payment_provider_accounts;
drop policy if exists skatteverket_company_settings_write on public.skatteverket_company_settings;
drop policy if exists year_end_purchase_access_write on public.year_end_purchase_access;

COMMIT;

NOTIFY pgrst, 'reload schema';
