-- Nordklart commercial access foundation — phase 1 + 2.
--
-- Phase 1
--   * closes direct tenant writes to subscriptions, entitlements and payment provisioning;
--   * retires legacy plan-generated entitlements as an access source;
--   * makes Bankgiro application creation go through a constrained RPC.
--
-- Phase 2
--   * introduces immutable plan versions and versioned feature snapshots;
--   * introduces subscription items, commercial access grants and Complimentary Full Access;
--   * resolves effective access from one database source of truth.
--
-- No posted accounting data is modified by this migration.

-- -----------------------------------------------------------------------------
-- 1. Product catalogue repair and target product shape
-- -----------------------------------------------------------------------------

insert into public.platform_features (code, name, description, category, risk_level, requires_human_review)
values
  ('bankgiro.application', 'Bankgiro-ansökan', 'Ger rätt att starta och komplettera en separat Bankgiro/Autogiro-ansökan.', 'payments', 'normal', false),
  ('bankgiro.operations', 'Bankgiro-drift', 'Ger rätt att använda aktiverade Bankgiro/Autogiro-funktioner efter godkänd provisioning.', 'payments', 'high', true)
on conflict (code) do update set
  name = excluded.name,
  description = excluded.description,
  category = excluded.category,
  risk_level = excluded.risk_level,
  requires_human_review = excluded.requires_human_review,
  updated_at = now();

-- "Start" becomes the single-company bookkeeping product. The old Auto plan is
-- retained for historical subscriptions but is no longer sellable as a separate
-- product: bookkeeping now includes automation and year-end work.
update public.platform_products
set
  name = 'Nordklart Bokföring',
  description = 'Löpande bokföring med automation, fakturering, rapportering och bokslut.',
  updated_at = now()
where code = 'start';

update public.platform_price_plans
set
  name = 'Nordklart Bokföring',
  description = 'Bokföring, fakturor, bankautomation, automatisk bokföring, rapporter, bokslut och årsredovisningsunderlag.',
  target_audience = 'single_company',
  is_default = true,
  updated_at = now()
where code = 'start_monthly';

update public.platform_price_plans
set
  name = 'Nordklart Auto (äldre plan)',
  description = 'Äldre plan som behålls för historiska abonnemang. Nya kunder väljer Nordklart Bokföring.',
  status = 'archived',
  is_default = false,
  updated_at = now()
where code = 'auto_monthly';

-- Correct the formerly mismatched product-code mappings by declaring the
-- intended feature sets against the real, stable plan codes.
with desired(plan_code, feature_code, limit_value, limit_unit) as (
  values
    ('start_monthly', 'bookkeeping.core', null::numeric, null::text),
    ('start_monthly', 'invoicing.core', null, null),
    ('start_monthly', 'reports.core', null, null),
    ('start_monthly', 'onboarding.paths', null, null),
    ('start_monthly', 'bank.automation', null, null),
    ('start_monthly', 'bank.provider_model', null, null),
    ('start_monthly', 'bank.transaction_ingest', null, null),
    ('start_monthly', 'bank.matching', null, null),
    ('start_monthly', 'bank.autobook', null, null),
    ('start_monthly', 'year_end.projects', null, null),
    ('start_monthly', 'year_end.ixbrl', null, null),
    ('start_monthly', 'year_end.product', null, null),
    ('start_monthly', 'skatteverket.submissions', null, null),

    ('auto_monthly', 'bookkeeping.core', null, null),
    ('auto_monthly', 'invoicing.core', null, null),
    ('auto_monthly', 'reports.core', null, null),
    ('auto_monthly', 'onboarding.paths', null, null),
    ('auto_monthly', 'bank.automation', null, null),
    ('auto_monthly', 'bank.provider_model', null, null),
    ('auto_monthly', 'bank.transaction_ingest', null, null),
    ('auto_monthly', 'bank.matching', null, null),
    ('auto_monthly', 'bank.autobook', null, null),
    ('auto_monthly', 'year_end.projects', null, null),
    ('auto_monthly', 'year_end.ixbrl', null, null),
    ('auto_monthly', 'year_end.product', null, null),
    ('auto_monthly', 'skatteverket.submissions', null, null),

    ('agency_monthly', 'bookkeeping.core', null, null),
    ('agency_monthly', 'invoicing.core', null, null),
    ('agency_monthly', 'reports.core', null, null),
    ('agency_monthly', 'onboarding.paths', null, null),
    ('agency_monthly', 'bank.automation', null, null),
    ('agency_monthly', 'bank.provider_model', null, null),
    ('agency_monthly', 'bank.transaction_ingest', null, null),
    ('agency_monthly', 'bank.matching', null, null),
    ('agency_monthly', 'bank.autobook', null, null),
    ('agency_monthly', 'year_end.projects', null, null),
    ('agency_monthly', 'year_end.ixbrl', null, null),
    ('agency_monthly', 'year_end.product', null, null),
    ('agency_monthly', 'skatteverket.submissions', null, null),
    ('agency_monthly', 'agency.clients', 20, 'included_clients'),
    ('agency_monthly', 'agency.deadlines', null, null),
    ('agency_monthly', 'agency.review_queue', null, null),

    ('year_end_one_time', 'year_end.projects', 1, 'fiscal_year'),
    ('year_end_one_time', 'year_end.ixbrl', 1, 'fiscal_year'),
    ('year_end_one_time', 'year_end.product', 1, 'fiscal_year'),
    ('year_end_one_time', 'year_end.one_time_purchase', 1, 'fiscal_year'),

    ('bankgiro_addon_monthly', 'bankgiro.onboarding', null, null),
    ('bankgiro_addon_monthly', 'bankgiro.application', null, null),
    ('bankgiro_addon_monthly', 'bankgiro.operations', null, null),
    ('bankgiro_addon_monthly', 'bankgiro.provider_module', null, null)
), target_plans as (
  select distinct plan_code from desired
)
update public.platform_plan_features ppf
set enabled = false
from public.platform_price_plans pp
where pp.id = ppf.plan_id
  and pp.code in (select plan_code from target_plans)
  and not exists (
    select 1
    from desired d
    join public.platform_features pf on pf.code = d.feature_code
    where d.plan_code = pp.code
      and pf.id = ppf.feature_id
  );

with desired(plan_code, feature_code, limit_value, limit_unit) as (
  values
    ('start_monthly', 'bookkeeping.core', null::numeric, null::text),
    ('start_monthly', 'invoicing.core', null, null),
    ('start_monthly', 'reports.core', null, null),
    ('start_monthly', 'onboarding.paths', null, null),
    ('start_monthly', 'bank.automation', null, null),
    ('start_monthly', 'bank.provider_model', null, null),
    ('start_monthly', 'bank.transaction_ingest', null, null),
    ('start_monthly', 'bank.matching', null, null),
    ('start_monthly', 'bank.autobook', null, null),
    ('start_monthly', 'year_end.projects', null, null),
    ('start_monthly', 'year_end.ixbrl', null, null),
    ('start_monthly', 'year_end.product', null, null),
    ('start_monthly', 'skatteverket.submissions', null, null),
    ('auto_monthly', 'bookkeeping.core', null, null),
    ('auto_monthly', 'invoicing.core', null, null),
    ('auto_monthly', 'reports.core', null, null),
    ('auto_monthly', 'onboarding.paths', null, null),
    ('auto_monthly', 'bank.automation', null, null),
    ('auto_monthly', 'bank.provider_model', null, null),
    ('auto_monthly', 'bank.transaction_ingest', null, null),
    ('auto_monthly', 'bank.matching', null, null),
    ('auto_monthly', 'bank.autobook', null, null),
    ('auto_monthly', 'year_end.projects', null, null),
    ('auto_monthly', 'year_end.ixbrl', null, null),
    ('auto_monthly', 'year_end.product', null, null),
    ('auto_monthly', 'skatteverket.submissions', null, null),
    ('agency_monthly', 'bookkeeping.core', null, null),
    ('agency_monthly', 'invoicing.core', null, null),
    ('agency_monthly', 'reports.core', null, null),
    ('agency_monthly', 'onboarding.paths', null, null),
    ('agency_monthly', 'bank.automation', null, null),
    ('agency_monthly', 'bank.provider_model', null, null),
    ('agency_monthly', 'bank.transaction_ingest', null, null),
    ('agency_monthly', 'bank.matching', null, null),
    ('agency_monthly', 'bank.autobook', null, null),
    ('agency_monthly', 'year_end.projects', null, null),
    ('agency_monthly', 'year_end.ixbrl', null, null),
    ('agency_monthly', 'year_end.product', null, null),
    ('agency_monthly', 'skatteverket.submissions', null, null),
    ('agency_monthly', 'agency.clients', 20, 'included_clients'),
    ('agency_monthly', 'agency.deadlines', null, null),
    ('agency_monthly', 'agency.review_queue', null, null),
    ('year_end_one_time', 'year_end.projects', 1, 'fiscal_year'),
    ('year_end_one_time', 'year_end.ixbrl', 1, 'fiscal_year'),
    ('year_end_one_time', 'year_end.product', 1, 'fiscal_year'),
    ('year_end_one_time', 'year_end.one_time_purchase', 1, 'fiscal_year'),
    ('bankgiro_addon_monthly', 'bankgiro.onboarding', null, null),
    ('bankgiro_addon_monthly', 'bankgiro.application', null, null),
    ('bankgiro_addon_monthly', 'bankgiro.operations', null, null),
    ('bankgiro_addon_monthly', 'bankgiro.provider_module', null, null)
)
insert into public.platform_plan_features (plan_id, feature_id, enabled, limit_value, limit_unit)
select pp.id, pf.id, true, desired.limit_value, desired.limit_unit
from desired
join public.platform_price_plans pp on pp.code = desired.plan_code
join public.platform_features pf on pf.code = desired.feature_code
on conflict (plan_id, feature_id) do update set
  enabled = true,
  limit_value = excluded.limit_value,
  limit_unit = excluded.limit_unit;

-- -----------------------------------------------------------------------------
-- 2. Versioned commercial model
-- -----------------------------------------------------------------------------

create table if not exists public.platform_plan_versions (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.platform_price_plans(id) on delete restrict,
  version_number integer not null check (version_number > 0),
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'active', 'retired')),
  effective_from timestamptz not null default now(),
  effective_until timestamptz,
  currency text not null default 'SEK',
  price_excl_vat numeric(12,2) not null check (price_excl_vat >= 0),
  vat_rate numeric(5,2) not null default 25 check (vat_rate >= 0 and vat_rate <= 100),
  billing_interval text not null check (billing_interval in ('month', 'year', 'one_time')),
  trial_days integer not null default 0 check (trial_days >= 0),
  monthly_included_clients integer,
  stripe_product_id text,
  stripe_price_id text,
  setup_fee_excl_vat numeric(12,2) not null default 0 check (setup_fee_excl_vat >= 0),
  price_metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  published_by uuid references auth.users(id) on delete set null,
  published_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint platform_plan_versions_unique_version unique (plan_id, version_number),
  constraint platform_plan_versions_valid_window check (effective_until is null or effective_until > effective_from)
);

create unique index if not exists platform_plan_versions_one_active_per_plan_idx
  on public.platform_plan_versions(plan_id)
  where status = 'active';

create unique index if not exists platform_plan_versions_unique_effective_from_idx
  on public.platform_plan_versions(plan_id, effective_from);

create index if not exists platform_plan_versions_lookup_idx
  on public.platform_plan_versions(plan_id, effective_from desc, version_number desc);

create table if not exists public.platform_plan_version_features (
  id uuid primary key default gen_random_uuid(),
  plan_version_id uuid not null references public.platform_plan_versions(id) on delete cascade,
  feature_id uuid not null references public.platform_features(id) on delete restrict,
  enabled boolean not null default true,
  limit_value numeric,
  limit_unit text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint platform_plan_version_features_unique unique (plan_version_id, feature_id)
);

create index if not exists platform_plan_version_features_feature_idx
  on public.platform_plan_version_features(feature_id, plan_version_id)
  where enabled;

alter table public.company_subscriptions
  add column if not exists plan_version_id uuid references public.platform_plan_versions(id) on delete restrict,
  add column if not exists price_snapshot jsonb not null default '{}'::jsonb;

create index if not exists company_subscriptions_plan_version_idx
  on public.company_subscriptions(plan_version_id);

create table if not exists public.company_subscription_items (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.company_subscriptions(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  plan_version_id uuid not null references public.platform_plan_versions(id) on delete restrict,
  item_type text not null check (item_type in ('base_plan', 'addon')),
  status text not null default 'active' check (status in ('trialing', 'active', 'past_due', 'paused', 'cancelled', 'expired')),
  quantity numeric(12,3) not null default 1 check (quantity > 0),
  starts_at timestamptz not null default now(),
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancelled_at timestamptz,
  external_provider text,
  external_subscription_item_id text,
  price_snapshot jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint company_subscription_items_period_valid check (current_period_end is null or current_period_start is null or current_period_end > current_period_start)
);

create unique index if not exists company_subscription_items_one_base_plan_idx
  on public.company_subscription_items(subscription_id)
  where item_type = 'base_plan';

create index if not exists company_subscription_items_company_status_idx
  on public.company_subscription_items(company_id, status, current_period_end);

create index if not exists company_subscription_items_version_idx
  on public.company_subscription_items(plan_version_id, status);

create table if not exists public.commercial_access_grants (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  grant_type text not null check (grant_type in (
    'complimentary_full_access',
    'complimentary_bankgiro',
    'trial',
    'partner',
    'pilot',
    'manual_credit',
    'migration_legacy'
  )),
  status text not null default 'active' check (status in ('scheduled', 'active', 'revoked', 'expired')),
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  note text,
  metadata jsonb not null default '{}'::jsonb,
  granted_by uuid references auth.users(id) on delete set null,
  revoked_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  revoke_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commercial_access_grants_window_valid check (expires_at is null or expires_at > starts_at),
  constraint commercial_access_grants_revocation_valid check (
    (status not in ('revoked', 'expired'))
    or revoked_at is not null
    or status = 'expired'
  )
);

create index if not exists commercial_access_grants_company_status_idx
  on public.commercial_access_grants(company_id, status, starts_at, expires_at);

create table if not exists public.commercial_access_grant_features (
  id uuid primary key default gen_random_uuid(),
  grant_id uuid not null references public.commercial_access_grants(id) on delete cascade,
  feature_id uuid not null references public.platform_features(id) on delete restrict,
  enabled boolean not null default true,
  limit_value numeric,
  limit_unit text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commercial_access_grant_features_unique unique (grant_id, feature_id)
);

create index if not exists commercial_access_grant_features_feature_idx
  on public.commercial_access_grant_features(feature_id, grant_id)
  where enabled;

alter table public.one_time_purchases
  add column if not exists plan_version_id uuid references public.platform_plan_versions(id) on delete restrict,
  add column if not exists price_snapshot jsonb not null default '{}'::jsonb;

create index if not exists one_time_purchases_plan_version_idx
  on public.one_time_purchases(plan_version_id);

-- Baseline every existing plan into an immutable initial version after the
-- product mapping above has been corrected.
insert into public.platform_plan_versions (
  plan_id,
  version_number,
  status,
  effective_from,
  currency,
  price_excl_vat,
  vat_rate,
  billing_interval,
  trial_days,
  monthly_included_clients,
  price_metadata,
  metadata,
  created_at,
  updated_at
)
select
  pp.id,
  1,
  case when pp.status = 'active' then 'active' else 'retired' end,
  coalesce(pp.created_at, now()),
  pp.currency,
  pp.price_excl_vat,
  25,
  pp.billing_interval,
  pp.trial_days,
  pp.monthly_included_clients,
  jsonb_build_object('legacy_plan_id', pp.id, 'legacy_plan_code', pp.code),
  jsonb_build_object('migration', '20260628172000'),
  pp.created_at,
  now()
from public.platform_price_plans pp
where not exists (
  select 1 from public.platform_plan_versions pv where pv.plan_id = pp.id
);

insert into public.platform_plan_version_features (
  plan_version_id,
  feature_id,
  enabled,
  limit_value,
  limit_unit
)
select
  pv.id,
  ppf.feature_id,
  ppf.enabled,
  ppf.limit_value,
  ppf.limit_unit
from public.platform_plan_versions pv
join public.platform_plan_features ppf on ppf.plan_id = pv.plan_id
where pv.version_number = 1
on conflict (plan_version_id, feature_id) do update set
  enabled = excluded.enabled,
  limit_value = excluded.limit_value,
  limit_unit = excluded.limit_unit,
  updated_at = now();

-- Every historical subscription is attached to the matching plan-version
-- snapshot. Retired versions remain valid for existing subscriptions.
--
-- PostgreSQL does not allow an UPDATE target alias to be referenced from the
-- nested FROM LATERAL clause here. Resolve one deterministic preferred version
-- per plan first, then join that compact result to the target rows.
with preferred_plan_versions as (
  select distinct on (pv_inner.plan_id)
    pv_inner.id,
    pv_inner.plan_id,
    pv_inner.version_number,
    pv_inner.price_excl_vat,
    pv_inner.vat_rate,
    pv_inner.currency,
    pv_inner.billing_interval,
    pv_inner.setup_fee_excl_vat
  from public.platform_plan_versions pv_inner
  order by
    pv_inner.plan_id,
    (pv_inner.status = 'active') desc,
    pv_inner.version_number desc
)
update public.company_subscriptions cs
set
  plan_version_id = pv.id,
  price_snapshot = jsonb_build_object(
    'plan_version_id', pv.id,
    'plan_id', pv.plan_id,
    'version_number', pv.version_number,
    'price_excl_vat', pv.price_excl_vat,
    'vat_rate', pv.vat_rate,
    'currency', pv.currency,
    'billing_interval', pv.billing_interval,
    'setup_fee_excl_vat', pv.setup_fee_excl_vat
  ),
  updated_at = now()
from preferred_plan_versions pv
where cs.plan_version_id is null
  and pv.plan_id = cs.plan_id;

-- Resolve one deterministic preferred version per product for legacy one-time
-- purchases. This avoids the same invalid target-table reference pattern.
with preferred_product_plan_versions as (
  select distinct on (pp.product_id)
    pp.product_id,
    pv_inner.id,
    pv_inner.plan_id,
    pv_inner.version_number,
    pv_inner.vat_rate,
    pv_inner.billing_interval
  from public.platform_price_plans pp
  join public.platform_plan_versions pv_inner on pv_inner.plan_id = pp.id
  order by
    pp.product_id,
    (pv_inner.status = 'active') desc,
    pv_inner.version_number desc
)
update public.one_time_purchases op
set
  plan_version_id = pv.id,
  price_snapshot = jsonb_build_object(
    'plan_version_id', pv.id,
    'plan_id', pv.plan_id,
    'version_number', pv.version_number,
    'price_excl_vat', op.price_excl_vat,
    'vat_rate', pv.vat_rate,
    'currency', op.currency,
    'billing_interval', pv.billing_interval
  ),
  updated_at = now()
from preferred_product_plan_versions pv
where op.plan_version_id is null
  and pv.product_id = op.product_id;

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
  external_provider,
  price_snapshot,
  created_by,
  created_at,
  updated_at
)
select
  cs.id,
  cs.company_id,
  cs.plan_version_id,
  'base_plan',
  cs.status,
  1,
  cs.starts_at,
  cs.current_period_start,
  cs.current_period_end,
  cs.cancelled_at,
  cs.external_provider,
  cs.price_snapshot,
  cs.created_by,
  cs.created_at,
  now()
from public.company_subscriptions cs
where cs.plan_version_id is not null
on conflict (subscription_id) where item_type = 'base_plan' do update set
  plan_version_id = excluded.plan_version_id,
  status = excluded.status,
  starts_at = excluded.starts_at,
  current_period_start = excluded.current_period_start,
  current_period_end = excluded.current_period_end,
  cancelled_at = excluded.cancelled_at,
  price_snapshot = excluded.price_snapshot,
  updated_at = now();

-- -----------------------------------------------------------------------------
-- 3. Safe lifecycle triggers and authoritative access resolver
-- -----------------------------------------------------------------------------

create or replace function public.plan_version_snapshot(p_plan_version_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'plan_version_id', pv.id,
    'plan_id', pv.plan_id,
    'version_number', pv.version_number,
    'price_excl_vat', pv.price_excl_vat,
    'vat_rate', pv.vat_rate,
    'currency', pv.currency,
    'billing_interval', pv.billing_interval,
    'trial_days', pv.trial_days,
    'monthly_included_clients', pv.monthly_included_clients,
    'setup_fee_excl_vat', pv.setup_fee_excl_vat
  )
  from public.platform_plan_versions pv
  where pv.id = p_plan_version_id;
$$;

create or replace function public.hydrate_subscription_plan_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version public.platform_plan_versions%rowtype;
  v_effective_at timestamptz := coalesce(new.starts_at, now());
begin
  if new.plan_version_id is null then
    select pv.*
    into v_version
    from public.platform_plan_versions pv
    where pv.plan_id = new.plan_id
      and pv.effective_from <= v_effective_at
      and (pv.effective_until is null or pv.effective_until > v_effective_at)
      and pv.status in ('active', 'scheduled')
    order by pv.effective_from desc, pv.version_number desc
    limit 1;

    if not found then
      select pv.*
      into v_version
      from public.platform_plan_versions pv
      where pv.plan_id = new.plan_id
      order by pv.version_number desc
      limit 1;
    end if;

    if not found then
      raise exception 'Ingen prisversion finns för plan %.', new.plan_id using errcode = '23514';
    end if;

    new.plan_version_id := v_version.id;
  else
    select pv.* into v_version from public.platform_plan_versions pv where pv.id = new.plan_version_id;
    if not found or v_version.plan_id <> new.plan_id then
      raise exception 'Prisversionen tillhör inte abonnemangets plan.' using errcode = '23514';
    end if;
  end if;

  if new.price_snapshot = '{}'::jsonb then
    new.price_snapshot := public.plan_version_snapshot(new.plan_version_id);
  end if;

  return new;
end;
$$;

create or replace function public.sync_subscription_entitlements()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Legacy materialised plan entitlements must never outlive a disabled feature
  -- or a cancelled subscription. Versioned subscription items are now the plan
  -- source of truth; retain old rows only as audit history.
  update public.company_entitlements
  set
    enabled = false,
    expires_at = coalesce(new.current_period_end, new.trial_ends_at, now()),
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
    external_provider = excluded.external_provider,
    price_snapshot = excluded.price_snapshot,
    updated_at = now();

  return new;
end;
$$;

drop trigger if exists company_subscriptions_hydrate_plan_version on public.company_subscriptions;
create trigger company_subscriptions_hydrate_plan_version
  before insert or update of plan_id, plan_version_id, starts_at, price_snapshot
  on public.company_subscriptions
  for each row execute function public.hydrate_subscription_plan_version();

drop trigger if exists company_subscriptions_sync_entitlements on public.company_subscriptions;
create trigger company_subscriptions_sync_entitlements
  after insert or update on public.company_subscriptions
  for each row execute function public.sync_subscription_entitlements();

-- The new resolver intentionally ignores legacy source='plan' rows. The only
-- valid ongoing sources are versioned subscription items, active grants and
-- explicit manual/add-on overrides. One-time year-end purchases stay scoped to
-- fiscal periods and are checked by canUseYearEnd rather than granting global
-- year-end access.
create or replace function public.company_feature_access(
  p_company_id uuid,
  p_feature_code text
)
returns table (
  allowed boolean,
  reason text,
  source_type text,
  source_id uuid,
  expires_at timestamptz,
  limit_value numeric,
  limit_unit text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_source record;
  v_has_expired_source boolean := false;
  v_is_service_role boolean := coalesce(auth.role(), '') = 'service_role';
begin
  if not v_is_service_role and not public.user_can_access_company_v2(p_company_id) then
    return query select false, 'unauthorized', null::text, null::uuid, null::timestamptz, null::numeric, null::text;
    return;
  end if;

  select exists (
    select 1
    from public.company_entitlements ce
    where ce.company_id = p_company_id
      and ce.feature_code = p_feature_code
      and ce.source not in ('plan', 'one_time_purchase')
      and ce.enabled = true
      and ce.starts_at <= now()
      and ce.expires_at is not null
      and ce.expires_at <= now()
  )
  or exists (
    select 1
    from public.commercial_access_grants cag
    join public.commercial_access_grant_features cagf on cagf.grant_id = cag.id
    join public.platform_features pf on pf.id = cagf.feature_id
    where cag.company_id = p_company_id
      and pf.code = p_feature_code
      and cagf.enabled = true
      and cag.starts_at <= now()
      and cag.expires_at is not null
      and cag.expires_at <= now()
  ) into v_has_expired_source;

  select * into v_source
  from (
    select
      10 as priority,
      'manual_entitlement'::text as source_type,
      ce.id as source_id,
      ce.expires_at,
      ce.limit_value,
      ce.limit_unit
    from public.company_entitlements ce
    where ce.company_id = p_company_id
      and ce.feature_code = p_feature_code
      and ce.source not in ('plan', 'one_time_purchase')
      and ce.enabled = true
      and ce.starts_at <= now()
      and (ce.expires_at is null or ce.expires_at > now())

    union all

    select
      20,
      'commercial_grant'::text,
      cag.id,
      cag.expires_at,
      cagf.limit_value,
      cagf.limit_unit
    from public.commercial_access_grants cag
    join public.commercial_access_grant_features cagf on cagf.grant_id = cag.id
    join public.platform_features pf on pf.id = cagf.feature_id
    where cag.company_id = p_company_id
      and pf.code = p_feature_code
      and cag.status in ('scheduled', 'active')
      and cagf.enabled = true
      and cag.starts_at <= now()
      and (cag.expires_at is null or cag.expires_at > now())

    union all

    select
      30,
      'subscription_item'::text,
      csi.id,
      coalesce(csi.current_period_end, cs.current_period_end, cs.trial_ends_at),
      pvf.limit_value,
      pvf.limit_unit
    from public.company_subscription_items csi
    join public.company_subscriptions cs on cs.id = csi.subscription_id
    join public.platform_plan_version_features pvf on pvf.plan_version_id = csi.plan_version_id and pvf.enabled = true
    join public.platform_features pf on pf.id = pvf.feature_id
    where csi.company_id = p_company_id
      and cs.company_id = p_company_id
      and pf.code = p_feature_code
      and csi.status in ('trialing', 'active')
      and cs.status in ('trialing', 'active')
      and csi.starts_at <= now()
      and cs.starts_at <= now()
      and (csi.current_period_end is null or csi.current_period_end > now())
      and (cs.current_period_end is null or cs.current_period_end > now())
      and (cs.trial_ends_at is null or cs.status <> 'trialing' or cs.trial_ends_at > now())
  ) candidates
  order by priority, expires_at nulls last
  limit 1;

  if not found then
    return query select false,
      case when v_has_expired_source then 'expired' else 'missing_entitlement' end,
      null::text, null::uuid, null::timestamptz, null::numeric, null::text;
    return;
  end if;

  -- A paid/granted Bankgiro product allows application handling. Operations are
  -- deliberately blocked until both the application and provider account are
  -- fully active. No grant can bypass this provisioning safety check.
  if p_feature_code = 'bankgiro.operations'
     and not exists (
       select 1
       from public.bankgiro_applications ba
       join public.payment_provider_accounts ppa
         on ppa.company_id = ba.company_id
        and (ppa.bankgiro_application_id = ba.id or ppa.bankgiro_application_id is null)
       where ba.company_id = p_company_id
         and ba.status = 'active'
         and ba.provider_setup_status = 'active'
         and ba.documents_status = 'ready'
         and ppa.status = 'active'
     ) then
    return query select false, 'provisioning_pending', v_source.source_type, v_source.source_id,
      v_source.expires_at, v_source.limit_value, v_source.limit_unit;
    return;
  end if;

  return query select true, null::text, v_source.source_type, v_source.source_id,
    v_source.expires_at, v_source.limit_value, v_source.limit_unit;
end;
$$;

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

create or replace view public.company_feature_access_v
with (security_invoker = true)
as
select
  c.id as company_id,
  f.code as feature_code,
  f.name as feature_name,
  f.category,
  f.risk_level,
  cfa.allowed as enabled,
  cfa.limit_value,
  cfa.limit_unit
from public.companies c
cross join public.platform_features f
cross join lateral public.company_feature_access(c.id, f.code) cfa
where public.user_can_access_company_v2(c.id);

create or replace view public.company_feature_access_sources_v
with (security_invoker = true)
as
select
  ce.company_id,
  ce.feature_code,
  'manual_entitlement'::text as source_type,
  ce.id as source_id,
  ce.enabled,
  ce.starts_at,
  ce.expires_at,
  ce.limit_value,
  ce.limit_unit
from public.company_entitlements ce
where ce.source not in ('plan', 'one_time_purchase')

union all

select
  cag.company_id,
  pf.code,
  'commercial_grant'::text,
  cag.id,
  cagf.enabled,
  cag.starts_at,
  cag.expires_at,
  cagf.limit_value,
  cagf.limit_unit
from public.commercial_access_grants cag
join public.commercial_access_grant_features cagf on cagf.grant_id = cag.id
join public.platform_features pf on pf.id = cagf.feature_id

union all

select
  csi.company_id,
  pf.code,
  'subscription_item'::text,
  csi.id,
  pvf.enabled,
  csi.starts_at,
  coalesce(csi.current_period_end, cs.current_period_end, cs.trial_ends_at),
  pvf.limit_value,
  pvf.limit_unit
from public.company_subscription_items csi
join public.company_subscriptions cs on cs.id = csi.subscription_id
join public.platform_plan_version_features pvf on pvf.plan_version_id = csi.plan_version_id
join public.platform_features pf on pf.id = pvf.feature_id;

revoke all on function public.plan_version_snapshot(uuid) from public;
revoke all on function public.hydrate_subscription_plan_version() from public;
revoke all on function public.sync_subscription_entitlements() from public;
revoke all on function public.company_feature_access(uuid, text) from public;
revoke all on function public.company_has_feature(uuid, text) from public;
grant execute on function public.company_feature_access(uuid, text) to authenticated, service_role;
grant execute on function public.company_has_feature(uuid, text) to authenticated, service_role;

revoke all on public.company_feature_access_v from anon;
grant select on public.company_feature_access_v to authenticated;
revoke all on public.company_feature_access_sources_v from anon;
grant select on public.company_feature_access_sources_v to authenticated;

-- -----------------------------------------------------------------------------
-- 4. Controlled commercial mutations
-- -----------------------------------------------------------------------------

create or replace function public.require_platform_commercial_admin()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Endast superadmin får ändra Nordklarts kommersiella inställningar.' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.platform_create_price_plan_version(
  p_plan_id uuid,
  p_price_excl_vat numeric,
  p_vat_rate numeric default 25,
  p_currency text default 'SEK',
  p_billing_interval text default null,
  p_trial_days integer default null,
  p_monthly_included_clients integer default null,
  p_effective_from timestamptz default now(),
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan public.platform_price_plans%rowtype;
  v_version_id uuid;
  v_next_version integer;
begin
  perform public.require_platform_commercial_admin();

  if p_price_excl_vat is null or p_price_excl_vat < 0 or p_vat_rate < 0 or p_vat_rate > 100 then
    raise exception 'Pris eller moms är ogiltigt.' using errcode = '22023';
  end if;

  select * into v_plan from public.platform_price_plans where id = p_plan_id;
  if not found then
    raise exception 'Prisplanen finns inte.' using errcode = 'P0002';
  end if;

  select coalesce(max(version_number), 0) + 1
  into v_next_version
  from public.platform_plan_versions
  where plan_id = p_plan_id;

  insert into public.platform_plan_versions (
    plan_id, version_number, status, effective_from, currency, price_excl_vat,
    vat_rate, billing_interval, trial_days, monthly_included_clients, metadata, created_by
  ) values (
    p_plan_id,
    v_next_version,
    'draft',
    coalesce(p_effective_from, now()),
    upper(coalesce(nullif(p_currency, ''), v_plan.currency)),
    p_price_excl_vat,
    p_vat_rate,
    coalesce(p_billing_interval, v_plan.billing_interval),
    coalesce(p_trial_days, v_plan.trial_days),
    coalesce(p_monthly_included_clients, v_plan.monthly_included_clients),
    coalesce(p_metadata, '{}'::jsonb),
    auth.uid()
  ) returning id into v_version_id;

  insert into public.platform_plan_version_features (
    plan_version_id, feature_id, enabled, limit_value, limit_unit
  )
  select v_version_id, pvf.feature_id, pvf.enabled, pvf.limit_value, pvf.limit_unit
  from (
    select current_version.id
    from public.platform_plan_versions current_version
    where current_version.plan_id = p_plan_id
      and current_version.id <> v_version_id
    order by current_version.version_number desc
    limit 1
  ) previous_version
  join public.platform_plan_version_features pvf on pvf.plan_version_id = previous_version.id
  on conflict (plan_version_id, feature_id) do nothing;

  -- A first version always has a legacy feature mapping to copy.
  if not exists (select 1 from public.platform_plan_version_features where plan_version_id = v_version_id) then
    insert into public.platform_plan_version_features (
      plan_version_id, feature_id, enabled, limit_value, limit_unit
    )
    select v_version_id, ppf.feature_id, ppf.enabled, ppf.limit_value, ppf.limit_unit
    from public.platform_plan_features ppf
    where ppf.plan_id = p_plan_id;
  end if;

  return v_version_id;
end;
$$;

create or replace function public.platform_replace_plan_version_features(
  p_plan_version_id uuid,
  p_features jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_invalid_feature text;
begin
  perform public.require_platform_commercial_admin();

  if jsonb_typeof(coalesce(p_features, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_features, '[]'::jsonb)) = 0 then
    raise exception 'En planversion måste ha minst en feature.' using errcode = '22023';
  end if;

  select status into v_status from public.platform_plan_versions where id = p_plan_version_id for update;
  if not found then
    raise exception 'Planversionen finns inte.' using errcode = 'P0002';
  end if;
  if v_status <> 'draft' then
    raise exception 'Endast ett utkast kan ändra feature-innehåll.' using errcode = '23514';
  end if;

  select coalesce(nullif(trim(x.feature_code), ''), '(tom feature)') into v_invalid_feature
  from jsonb_to_recordset(p_features) as x(feature_code text, enabled boolean, limit_value numeric, limit_unit text)
  left join public.platform_features pf on pf.code = x.feature_code
  where nullif(trim(x.feature_code), '') is null or pf.id is null
  limit 1;

  if v_invalid_feature is not null then
    raise exception 'Okänd feature: %', v_invalid_feature using errcode = '22023';
  end if;

  delete from public.platform_plan_version_features where plan_version_id = p_plan_version_id;

  insert into public.platform_plan_version_features (
    plan_version_id, feature_id, enabled, limit_value, limit_unit
  )
  select
    p_plan_version_id,
    pf.id,
    coalesce(x.enabled, true),
    x.limit_value,
    x.limit_unit
  from jsonb_to_recordset(p_features) as x(feature_code text, enabled boolean, limit_value numeric, limit_unit text)
  join public.platform_features pf on pf.code = x.feature_code;
end;
$$;

create or replace function public.platform_publish_price_plan_version(
  p_plan_version_id uuid,
  p_effective_from timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version public.platform_plan_versions%rowtype;
  v_effective_from timestamptz;
begin
  perform public.require_platform_commercial_admin();

  select * into v_version from public.platform_plan_versions where id = p_plan_version_id for update;
  if not found then
    raise exception 'Planversionen finns inte.' using errcode = 'P0002';
  end if;
  if v_version.status <> 'draft' then
    raise exception 'Bara utkast kan publiceras.' using errcode = '23514';
  end if;
  if not exists (select 1 from public.platform_plan_version_features where plan_version_id = p_plan_version_id and enabled) then
    raise exception 'En publicerad planversion måste innehålla minst en aktiv feature.' using errcode = '23514';
  end if;

  v_effective_from := coalesce(p_effective_from, v_version.effective_from, now());
  perform set_config('nordklart.commercial_mutation', 'on', true);

  if v_effective_from <= now() then
    update public.platform_plan_versions
    set
      status = 'retired',
      effective_until = v_effective_from,
      updated_at = now()
    where plan_id = v_version.plan_id
      and status = 'active'
      and id <> p_plan_version_id;

    update public.platform_plan_versions
    set
      status = 'active',
      effective_from = v_effective_from,
      published_by = auth.uid(),
      published_at = now(),
      updated_at = now()
    where id = p_plan_version_id;
  else
    update public.platform_plan_versions
    set
      status = 'scheduled',
      effective_from = v_effective_from,
      published_by = auth.uid(),
      published_at = now(),
      updated_at = now()
    where id = p_plan_version_id;
  end if;
end;
$$;

create or replace function public.platform_set_company_subscription(
  p_company_id uuid,
  p_plan_version_id uuid,
  p_status text default 'active',
  p_starts_at timestamptz default now(),
  p_current_period_end timestamptz default null,
  p_trial_ends_at timestamptz default null,
  p_override_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan_version public.platform_plan_versions%rowtype;
  v_product_type text;
  v_subscription_id uuid;
begin
  perform public.require_platform_commercial_admin();

  if p_status not in ('trialing', 'active', 'past_due', 'paused', 'cancelled', 'expired') then
    raise exception 'Ogiltig abonnemangsstatus.' using errcode = '22023';
  end if;

  select * into v_plan_version from public.platform_plan_versions where id = p_plan_version_id;
  if not found then
    raise exception 'Planversionen finns inte.' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.companies where id = p_company_id) then
    raise exception 'Bolaget finns inte.' using errcode = 'P0002';
  end if;

  select pr.product_type into v_product_type
  from public.platform_price_plans pp
  join public.platform_products pr on pr.id = pp.product_id
  where pp.id = v_plan_version.plan_id;

  if v_product_type <> 'subscription' then
    raise exception 'Basabonnemang måste använda en abonnemangsplan. Tillägg läggs som subscription item.' using errcode = '23514';
  end if;

  update public.company_subscriptions cs
  set
    status = 'cancelled',
    cancelled_at = now(),
    current_period_end = coalesce(cs.current_period_end, now()),
    updated_at = now()
  from public.platform_price_plans pp
  join public.platform_products pr on pr.id = pp.product_id
  where cs.company_id = p_company_id
    and pp.id = cs.plan_id
    and pr.product_type = 'subscription'
    and cs.status in ('trialing', 'active', 'past_due', 'paused');

  insert into public.company_subscriptions (
    company_id, plan_id, plan_version_id, status, starts_at, trial_ends_at,
    current_period_start, current_period_end, external_provider, override_note,
    created_by, price_snapshot
  ) values (
    p_company_id,
    v_plan_version.plan_id,
    v_plan_version.id,
    p_status,
    coalesce(p_starts_at, now()),
    p_trial_ends_at,
    coalesce(p_starts_at, now()),
    p_current_period_end,
    'manual',
    p_override_note,
    auth.uid(),
    public.plan_version_snapshot(v_plan_version.id)
  ) returning id into v_subscription_id;

  return v_subscription_id;
end;
$$;

create or replace function public.platform_add_subscription_item(
  p_subscription_id uuid,
  p_plan_version_id uuid,
  p_status text default 'active',
  p_quantity numeric default 1,
  p_current_period_end timestamptz default null,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_plan_version public.platform_plan_versions%rowtype;
  v_product_type text;
  v_item_id uuid;
begin
  perform public.require_platform_commercial_admin();

  if p_status not in ('trialing', 'active', 'past_due', 'paused', 'cancelled', 'expired') or p_quantity is null or p_quantity <= 0 then
    raise exception 'Ogiltigt subscription item.' using errcode = '22023';
  end if;

  select company_id into v_company_id
  from public.company_subscriptions
  where id = p_subscription_id;
  if not found then
    raise exception 'Abonnemanget finns inte.' using errcode = 'P0002';
  end if;

  select * into v_plan_version
  from public.platform_plan_versions
  where id = p_plan_version_id;
  if not found then
    raise exception 'Planversionen finns inte.' using errcode = 'P0002';
  end if;

  select pr.product_type into v_product_type
  from public.platform_price_plans pp
  join public.platform_products pr on pr.id = pp.product_id
  where pp.id = v_plan_version.plan_id;

  if v_product_type <> 'addon' then
    raise exception 'Subscription item måste använda en tilläggsplan.' using errcode = '23514';
  end if;

  select id into v_item_id
  from public.company_subscription_items
  where subscription_id = p_subscription_id
    and plan_version_id = p_plan_version_id
    and item_type = 'addon'
    and status in ('trialing', 'active', 'past_due', 'paused')
  order by created_at desc
  limit 1;

  if v_item_id is not null then
    update public.company_subscription_items
    set
      status = p_status,
      quantity = p_quantity,
      current_period_end = p_current_period_end,
      metadata = metadata || jsonb_strip_nulls(jsonb_build_object('note', p_note)),
      updated_at = now()
    where id = v_item_id;
    return v_item_id;
  end if;

  insert into public.company_subscription_items (
    subscription_id, company_id, plan_version_id, item_type, status, quantity,
    starts_at, current_period_start, current_period_end, external_provider,
    price_snapshot, metadata, created_by
  ) values (
    p_subscription_id,
    v_company_id,
    p_plan_version_id,
    'addon',
    p_status,
    p_quantity,
    now(),
    now(),
    p_current_period_end,
    'manual',
    public.plan_version_snapshot(p_plan_version_id),
    jsonb_strip_nulls(jsonb_build_object('note', p_note, 'created_via', 'platform')),
    auth.uid()
  ) returning id into v_item_id;

  return v_item_id;
end;
$$;

create or replace function public.platform_set_subscription_item_status(
  p_subscription_item_id uuid,
  p_status text,
  p_current_period_end timestamptz default null,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_platform_commercial_admin();

  if p_status not in ('trialing', 'active', 'past_due', 'paused', 'cancelled', 'expired') then
    raise exception 'Ogiltig item-status.' using errcode = '22023';
  end if;

  update public.company_subscription_items
  set
    status = p_status,
    current_period_end = coalesce(p_current_period_end, current_period_end),
    cancelled_at = case when p_status = 'cancelled' then now() else cancelled_at end,
    metadata = metadata || jsonb_strip_nulls(jsonb_build_object('note', p_note)),
    updated_at = now()
  where id = p_subscription_item_id;

  if not found then
    raise exception 'Subscription item finns inte.' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.platform_create_one_time_purchase(
  p_company_id uuid,
  p_plan_version_id uuid,
  p_fiscal_period_id uuid default null,
  p_status text default 'pending_payment',
  p_permanent_access boolean default false,
  p_access_expires_at timestamptz default null,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan_version public.platform_plan_versions%rowtype;
  v_product public.platform_products%rowtype;
  v_purchase_id uuid;
begin
  perform public.require_platform_commercial_admin();

  if p_status not in ('pending_payment', 'paid', 'active', 'fulfilled', 'refunded', 'cancelled', 'expired') then
    raise exception 'Ogiltig köpstatus.' using errcode = '22023';
  end if;

  select pv.* into v_plan_version from public.platform_plan_versions pv where pv.id = p_plan_version_id;
  if not found then
    raise exception 'Planversionen finns inte.' using errcode = 'P0002';
  end if;

  select pr.* into v_product
  from public.platform_price_plans pp
  join public.platform_products pr on pr.id = pp.product_id
  where pp.id = v_plan_version.plan_id;

  if not found or v_product.product_type <> 'one_time' then
    raise exception 'Planversionen avser inte en engångsprodukt.' using errcode = '23514';
  end if;

  if v_product.code = 'year_end' and p_fiscal_period_id is null then
    raise exception 'Bokslutsköp måste kopplas till ett räkenskapsår.' using errcode = '23514';
  end if;

  if v_product.code = 'year_end'
     and p_fiscal_period_id is not null
     and exists (
       select 1
       from public.one_time_purchases op
       where op.company_id = p_company_id
         and op.purchase_type = 'year_end'
         and op.fiscal_period_id = p_fiscal_period_id
         and op.status in ('pending_payment', 'paid', 'active', 'fulfilled')
     ) then
    raise exception 'Det finns redan ett aktivt eller väntande bokslutsköp för räkenskapsåret.' using errcode = '23505';
  end if;

  insert into public.one_time_purchases (
    company_id, product_id, plan_version_id, purchase_type, status, fiscal_period_id,
    price_excl_vat, currency, paid_at, access_starts_at, access_expires_at,
    permanent_access, price_snapshot, metadata, created_by
  ) values (
    p_company_id,
    v_product.id,
    v_plan_version.id,
    case when v_product.code = 'year_end' then 'year_end' else 'custom' end,
    p_status,
    p_fiscal_period_id,
    v_plan_version.price_excl_vat,
    v_plan_version.currency,
    case when p_status in ('paid', 'active', 'fulfilled') then now() else null end,
    case when p_status in ('paid', 'active', 'fulfilled') then now() else null end,
    p_access_expires_at,
    coalesce(p_permanent_access, false),
    public.plan_version_snapshot(v_plan_version.id),
    jsonb_strip_nulls(jsonb_build_object('note', p_note, 'created_via', 'platform')),
    auth.uid()
  ) returning id into v_purchase_id;

  return v_purchase_id;
end;
$$;

create or replace function public.platform_grant_complimentary_full_access(
  p_company_id uuid,
  p_starts_at timestamptz default now(),
  p_expires_at timestamptz default null,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grant_id uuid;
  v_status text := case when coalesce(p_starts_at, now()) <= now() then 'active' else 'scheduled' end;
begin
  perform public.require_platform_commercial_admin();

  if not exists (select 1 from public.companies where id = p_company_id) then
    raise exception 'Bolaget finns inte.' using errcode = 'P0002';
  end if;
  if p_expires_at is not null and p_expires_at <= coalesce(p_starts_at, now()) then
    raise exception 'Slutdatum måste vara senare än startdatum.' using errcode = '22023';
  end if;

  insert into public.commercial_access_grants (
    company_id, grant_type, status, starts_at, expires_at, note, granted_by, metadata
  ) values (
    p_company_id,
    'complimentary_full_access',
    v_status,
    coalesce(p_starts_at, now()),
    p_expires_at,
    nullif(trim(p_note), ''),
    auth.uid(),
    jsonb_build_object('label', 'Complimentary Full Access')
  ) returning id into v_grant_id;

  -- Complimentary Full Access deliberately excludes all Bankgiro/Autogiro
  -- access. Those features have separate commercial and provisioning grants.
  insert into public.commercial_access_grant_features (grant_id, feature_id, enabled)
  select v_grant_id, pf.id, true
  from public.platform_features pf
  where pf.code not like 'bankgiro.%'
    and pf.code <> 'bankgiro.provider_module';

  return v_grant_id;
end;
$$;

create or replace function public.platform_grant_complimentary_bankgiro(
  p_company_id uuid,
  p_starts_at timestamptz default now(),
  p_expires_at timestamptz default null,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grant_id uuid;
  v_status text := case when coalesce(p_starts_at, now()) <= now() then 'active' else 'scheduled' end;
begin
  perform public.require_platform_commercial_admin();

  if not exists (select 1 from public.companies where id = p_company_id) then
    raise exception 'Bolaget finns inte.' using errcode = 'P0002';
  end if;

  insert into public.commercial_access_grants (
    company_id, grant_type, status, starts_at, expires_at, note, granted_by, metadata
  ) values (
    p_company_id,
    'complimentary_bankgiro',
    v_status,
    coalesce(p_starts_at, now()),
    p_expires_at,
    nullif(trim(p_note), ''),
    auth.uid(),
    jsonb_build_object('label', 'Complimentary Bankgiro')
  ) returning id into v_grant_id;

  insert into public.commercial_access_grant_features (grant_id, feature_id, enabled)
  select v_grant_id, pf.id, true
  from public.platform_features pf
  where pf.code in ('bankgiro.onboarding', 'bankgiro.application', 'bankgiro.operations', 'bankgiro.provider_module');

  return v_grant_id;
end;
$$;

create or replace function public.platform_revoke_commercial_access_grant(
  p_grant_id uuid,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_platform_commercial_admin();

  update public.commercial_access_grants
  set
    status = 'revoked',
    revoked_at = now(),
    revoked_by = auth.uid(),
    revoke_reason = nullif(trim(p_reason), ''),
    updated_at = now()
  where id = p_grant_id
    and status in ('scheduled', 'active');

  if not found then
    raise exception 'Grant saknas eller kan inte återkallas.' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.request_bankgiro_application(
  p_company_id uuid,
  p_provider_id uuid default null,
  p_status text default 'draft',
  p_expected_monthly_volume numeric default null,
  p_use_case text default null,
  p_beneficial_owners jsonb default '[]'::jsonb,
  p_company_questions jsonb default '{}'::jsonb,
  p_volume_answers jsonb default '{}'::jsonb,
  p_requested_by uuid default null
)
returns table (
  id uuid,
  status text,
  provider_setup_status text,
  documents_status text,
  expected_monthly_volume numeric,
  risk_score integer,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_is_service_role boolean := coalesce(auth.role(), '') = 'service_role';
begin
  if v_is_service_role then
    v_actor_id := p_requested_by;
  end if;

  if v_actor_id is null then
    raise exception 'En autentiserad användare krävs.' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.company_members cm
    where cm.company_id = p_company_id
      and cm.user_id = v_actor_id
      and cm.role in ('owner', 'admin')
  ) then
    raise exception 'Endast bolagets ägare eller administratör får starta Bankgiro-ansökan.' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.company_feature_access(p_company_id, 'bankgiro.application') access
    where access.allowed
  ) then
    raise exception 'Bankgiro-ansökan kräver aktiv Bankgiro-tjänst eller uttrycklig Complimentary Bankgiro-access.' using errcode = '42501';
  end if;

  if p_status not in ('draft', 'submitted') then
    raise exception 'En kund kan endast skapa ett utkast eller skicka in en ansökan.' using errcode = '22023';
  end if;

  if jsonb_typeof(coalesce(p_beneficial_owners, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_company_questions, '{}'::jsonb)) <> 'object'
     or jsonb_typeof(coalesce(p_volume_answers, '{}'::jsonb)) <> 'object' then
    raise exception 'Bankgiro-ansökan innehåller ogiltigt dataformat.' using errcode = '22023';
  end if;

  if p_provider_id is not null and not exists (
    select 1 from public.payment_providers pp where pp.id = p_provider_id and pp.status = 'active'
  ) then
    raise exception 'Vald betalprovider är inte aktiv.' using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.bankgiro_applications ba
    where ba.company_id = p_company_id
      and ba.status in ('submitted', 'needs_information', 'under_review', 'approved', 'provider_setup', 'active')
  ) then
    raise exception 'Det finns redan en aktiv Bankgiro-ansökan för bolaget.' using errcode = '23505';
  end if;

  return query
  insert into public.bankgiro_applications (
    company_id, provider_id, status, expected_monthly_volume, use_case,
    beneficial_owners, company_questions, volume_answers,
    documents_status, provider_setup_status, submitted_at, created_by
  ) values (
    p_company_id,
    p_provider_id,
    p_status,
    p_expected_monthly_volume,
    nullif(trim(p_use_case), ''),
    coalesce(p_beneficial_owners, '[]'::jsonb),
    coalesce(p_company_questions, '{}'::jsonb),
    coalesce(p_volume_answers, '{}'::jsonb),
    'not_started',
    'not_started',
    case when p_status = 'submitted' then now() else null end,
    v_actor_id
  )
  returning
    bankgiro_applications.id,
    bankgiro_applications.status,
    bankgiro_applications.provider_setup_status,
    bankgiro_applications.documents_status,
    bankgiro_applications.expected_monthly_volume,
    bankgiro_applications.risk_score,
    bankgiro_applications.created_at,
    bankgiro_applications.updated_at;
end;
$$;

-- Plan versions are immutable after publication. A superadmin can still create
-- a draft, but price changes and feature changes must go through version RPCs.
create or replace function public.guard_plan_version_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if current_setting('nordklart.commercial_mutation', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'INSERT' and new.status <> 'draft' then
    raise exception 'Nya planversioner måste skapas som utkast.' using errcode = '23514';
  end if;

  if tg_op in ('UPDATE', 'DELETE') and old.status <> 'draft' then
    raise exception 'Publicerade eller historiska planversioner är immutabla.' using errcode = '23514';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create or replace function public.guard_plan_version_feature_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan_version_id uuid;
  v_status text;
begin
  if current_setting('nordklart.commercial_mutation', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  v_plan_version_id := case when tg_op = 'DELETE' then old.plan_version_id else new.plan_version_id end;
  select status into v_status from public.platform_plan_versions where id = v_plan_version_id;
  if v_status <> 'draft' then
    raise exception 'Feature-innehåll kan bara ändras i en planversions utkast.' using errcode = '23514';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create or replace function public.guard_legacy_plan_commercial_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if current_setting('nordklart.commercial_mutation', true) = 'on' then
    return new;
  end if;

  if exists (select 1 from public.platform_plan_versions pv where pv.plan_id = old.id)
     and (
       new.price_excl_vat is distinct from old.price_excl_vat
       or new.currency is distinct from old.currency
       or new.billing_interval is distinct from old.billing_interval
       or new.trial_days is distinct from old.trial_days
       or new.monthly_included_clients is distinct from old.monthly_included_clients
     ) then
    raise exception 'Kommersiella planfält ändras genom en ny planversion, inte direkt på planen.' using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists platform_plan_versions_guard on public.platform_plan_versions;
create trigger platform_plan_versions_guard
  before insert or update or delete on public.platform_plan_versions
  for each row execute function public.guard_plan_version_mutation();

drop trigger if exists platform_plan_version_features_guard on public.platform_plan_version_features;
create trigger platform_plan_version_features_guard
  before insert or update or delete on public.platform_plan_version_features
  for each row execute function public.guard_plan_version_feature_mutation();

drop trigger if exists platform_price_plans_commercial_guard on public.platform_price_plans;
create trigger platform_price_plans_commercial_guard
  before update on public.platform_price_plans
  for each row execute function public.guard_legacy_plan_commercial_mutation();

-- -----------------------------------------------------------------------------
-- 5. RLS hardening and audit coverage
-- -----------------------------------------------------------------------------

alter table public.platform_plan_versions enable row level security;
alter table public.platform_plan_version_features enable row level security;
alter table public.company_subscription_items enable row level security;
alter table public.commercial_access_grants enable row level security;
alter table public.commercial_access_grant_features enable row level security;

-- Version history is readable to authenticated users for their own billing UI;
-- drafts are platform-only. All writes remain superadmin-only.
drop policy if exists platform_plan_versions_select on public.platform_plan_versions;
create policy platform_plan_versions_select on public.platform_plan_versions
  for select using (status <> 'draft' or public.is_platform_admin());
drop policy if exists platform_plan_versions_admin_write on public.platform_plan_versions;
create policy platform_plan_versions_admin_write on public.platform_plan_versions
  for all using (public.is_platform_admin()) with check (public.is_platform_admin());

drop policy if exists platform_plan_version_features_select on public.platform_plan_version_features;
create policy platform_plan_version_features_select on public.platform_plan_version_features
  for select using (
    public.is_platform_admin()
    or exists (
      select 1 from public.platform_plan_versions pv
      where pv.id = platform_plan_version_features.plan_version_id
        and pv.status <> 'draft'
    )
  );
drop policy if exists platform_plan_version_features_admin_write on public.platform_plan_version_features;
create policy platform_plan_version_features_admin_write on public.platform_plan_version_features
  for all using (public.is_platform_admin()) with check (public.is_platform_admin());

drop policy if exists company_subscription_items_select on public.company_subscription_items;
create policy company_subscription_items_select on public.company_subscription_items
  for select using (public.user_can_access_company_v2(company_id));
drop policy if exists company_subscription_items_platform_write on public.company_subscription_items;
create policy company_subscription_items_platform_write on public.company_subscription_items
  for all using (public.is_platform_admin()) with check (public.is_platform_admin());

drop policy if exists commercial_access_grants_select on public.commercial_access_grants;
create policy commercial_access_grants_select on public.commercial_access_grants
  for select using (public.user_can_access_company_v2(company_id));
drop policy if exists commercial_access_grants_platform_write on public.commercial_access_grants;
create policy commercial_access_grants_platform_write on public.commercial_access_grants
  for all using (public.is_platform_admin()) with check (public.is_platform_admin());

drop policy if exists commercial_access_grant_features_select on public.commercial_access_grant_features;
create policy commercial_access_grant_features_select on public.commercial_access_grant_features
  for select using (
    exists (
      select 1
      from public.commercial_access_grants cag
      where cag.id = commercial_access_grant_features.grant_id
        and public.user_can_access_company_v2(cag.company_id)
    )
  );
drop policy if exists commercial_access_grant_features_platform_write on public.commercial_access_grant_features;
create policy commercial_access_grant_features_platform_write on public.commercial_access_grant_features
  for all using (public.is_platform_admin()) with check (public.is_platform_admin());

-- Tenant users may read commercial state for their company, but never grant
-- themselves product access, create purchases or alter provider provisioning.
do $$
declare
  t text;
begin
  foreach t in array array[
    'company_subscriptions',
    'company_entitlements',
    'one_time_purchases',
    'billing_events',
    'usage_metering',
    'year_end_purchase_access',
    'bankgiro_applications',
    'bankgiro_application_documents',
    'bankgiro_provider_status_events',
    'payment_provider_accounts',
    'payment_mandates',
    'payment_collections',
    'payment_reconciliation_items',
    'payment_collection_events'
  ] loop
    -- The live schema may predate optional Batch 8+ tables. A missing legacy
    -- table must never prevent hardening the commercial tables that do exist.
    if to_regclass(format('public.%I', t)) is null then
      continue;
    end if;

    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format('drop policy if exists %I on public.%I', t || '_platform_write', t);
    execute format(
      'create policy %I on public.%I for all using (public.is_platform_admin()) with check (public.is_platform_admin())',
      t || '_platform_write', t
    );
  end loop;
end $$;

-- New tables and grant records receive the standard immutable audit trail.
do $$
declare
  t text;
begin
  foreach t in array array[
    'company_subscription_items',
    'commercial_access_grants',
    'commercial_access_grant_features'
  ] loop
    execute format('drop trigger if exists %I on public.%I', t || '_updated_at', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.update_updated_at_column()', t || '_updated_at', t);
    execute format('drop trigger if exists %I on public.%I', t || '_audit', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.write_audit_log()', t || '_audit', t);
  end loop;
end $$;

drop trigger if exists platform_plan_versions_updated_at on public.platform_plan_versions;
create trigger platform_plan_versions_updated_at
  before update on public.platform_plan_versions
  for each row execute function public.update_updated_at_column();

drop trigger if exists platform_plan_version_features_updated_at on public.platform_plan_version_features;
create trigger platform_plan_version_features_updated_at
  before update on public.platform_plan_version_features
  for each row execute function public.update_updated_at_column();

drop trigger if exists platform_plan_versions_audit on public.platform_plan_versions;
create trigger platform_plan_versions_audit
  after insert or update or delete on public.platform_plan_versions
  for each row execute function public.write_audit_log();

drop trigger if exists platform_plan_version_features_audit on public.platform_plan_version_features;
create trigger platform_plan_version_features_audit
  after insert or update or delete on public.platform_plan_version_features
  for each row execute function public.write_audit_log();

revoke all on function public.require_platform_commercial_admin() from public;
revoke all on function public.platform_create_price_plan_version(uuid, numeric, numeric, text, text, integer, integer, timestamptz, jsonb) from public;
revoke all on function public.platform_replace_plan_version_features(uuid, jsonb) from public;
revoke all on function public.platform_publish_price_plan_version(uuid, timestamptz) from public;
revoke all on function public.platform_set_company_subscription(uuid, uuid, text, timestamptz, timestamptz, timestamptz, text) from public;
revoke all on function public.platform_add_subscription_item(uuid, uuid, text, numeric, timestamptz, text) from public;
revoke all on function public.platform_set_subscription_item_status(uuid, text, timestamptz, text) from public;
revoke all on function public.platform_create_one_time_purchase(uuid, uuid, uuid, text, boolean, timestamptz, text) from public;
revoke all on function public.platform_grant_complimentary_full_access(uuid, timestamptz, timestamptz, text) from public;
revoke all on function public.platform_grant_complimentary_bankgiro(uuid, timestamptz, timestamptz, text) from public;
revoke all on function public.platform_revoke_commercial_access_grant(uuid, text) from public;
revoke all on function public.request_bankgiro_application(uuid, uuid, text, numeric, text, jsonb, jsonb, jsonb, uuid) from public;

grant execute on function public.platform_create_price_plan_version(uuid, numeric, numeric, text, text, integer, integer, timestamptz, jsonb) to authenticated;
grant execute on function public.platform_replace_plan_version_features(uuid, jsonb) to authenticated;
grant execute on function public.platform_publish_price_plan_version(uuid, timestamptz) to authenticated;
grant execute on function public.platform_set_company_subscription(uuid, uuid, text, timestamptz, timestamptz, timestamptz, text) to authenticated;
grant execute on function public.platform_add_subscription_item(uuid, uuid, text, numeric, timestamptz, text) to authenticated;
grant execute on function public.platform_set_subscription_item_status(uuid, text, timestamptz, text) to authenticated;
grant execute on function public.platform_create_one_time_purchase(uuid, uuid, uuid, text, boolean, timestamptz, text) to authenticated;
grant execute on function public.platform_grant_complimentary_full_access(uuid, timestamptz, timestamptz, text) to authenticated;
grant execute on function public.platform_grant_complimentary_bankgiro(uuid, timestamptz, timestamptz, text) to authenticated;
grant execute on function public.platform_revoke_commercial_access_grant(uuid, text) to authenticated;
grant execute on function public.request_bankgiro_application(uuid, uuid, text, numeric, text, jsonb, jsonb, jsonb, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
