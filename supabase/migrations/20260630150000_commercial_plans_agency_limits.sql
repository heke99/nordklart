-- Nordklart commercial plans + agency limits hardening.
-- Production-minded, non-destructive: extends the existing commercial model
-- instead of creating a parallel billing system.

-- This migration seeds and reshapes commercial plan data. The existing
-- commercial guard intentionally blocks direct changes to published plan
-- versions unless this controlled migration flag is enabled. Keep the flag
-- scoped to this SQL run and reset it at the end.
select set_config('nordklart.commercial_mutation', 'on', false);

-- -----------------------------------------------------------------------------
-- 1. Plan taxonomy for company vs agency offers and public pricing.
-- -----------------------------------------------------------------------------

alter table public.platform_price_plans
  add column if not exists audience_type text not null default 'company',
  add column if not exists company_form_scope text not null default 'company_all',
  add column if not exists is_public boolean not null default false,
  add column if not exists public_name text,
  add column if not exists public_summary text,
  add column if not exists public_badge text,
  add column if not exists public_sort_order integer not null default 100,
  add column if not exists cta_label text not null default 'Kom igång',
  add column if not exists cta_href text not null default '/register',
  add column if not exists marketing_metadata jsonb not null default '{}'::jsonb;

alter table public.platform_price_plans
  drop constraint if exists platform_price_plans_audience_type_check;
alter table public.platform_price_plans
  add constraint platform_price_plans_audience_type_check
  check (audience_type in ('company', 'agency', 'both', 'addon', 'internal'));

alter table public.platform_price_plans
  drop constraint if exists platform_price_plans_company_form_scope_check;
alter table public.platform_price_plans
  add constraint platform_price_plans_company_form_scope_check
  check (company_form_scope in ('limited_company', 'sole_trader', 'company_all', 'agency', 'not_applicable'));

create index if not exists platform_price_plans_public_idx
  on public.platform_price_plans(audience_type, is_public, status, public_sort_order);

alter table public.company_members
  add column if not exists membership_kind text not null default 'internal';

alter table public.company_members
  drop constraint if exists company_members_membership_kind_check;
alter table public.company_members
  add constraint company_members_membership_kind_check
  check (membership_kind in ('internal', 'external', 'agency_delegated', 'platform'));

alter table public.company_invitations
  add column if not exists membership_kind text not null default 'internal';

alter table public.company_invitations
  drop constraint if exists company_invitations_membership_kind_check;
alter table public.company_invitations
  add constraint company_invitations_membership_kind_check
  check (membership_kind in ('internal', 'external'));

alter table public.agency_members
  add column if not exists status text not null default 'active';

alter table public.agency_members
  drop constraint if exists agency_members_status_check;
alter table public.agency_members
  add constraint agency_members_status_check
  check (status in ('pending', 'active', 'suspended', 'revoked'));

create index if not exists agency_members_agency_status_idx
  on public.agency_members(agency_id, status, user_id);

alter table public.agency_clients
  add column if not exists billing_owner text not null default 'agency',
  add column if not exists access_level text not null default 'bookkeeping',
  add column if not exists approved_by_client_user_id uuid references auth.users(id) on delete set null,
  add column if not exists approved_at timestamptz,
  add column if not exists ended_by uuid references auth.users(id) on delete set null,
  add column if not exists ended_at timestamptz,
  add column if not exists relationship_metadata jsonb not null default '{}'::jsonb;

alter table public.agency_clients
  drop constraint if exists agency_clients_status_check;
alter table public.agency_clients
  add constraint agency_clients_status_check
  check (status in ('pending', 'active', 'paused', 'suspended', 'ended'));

alter table public.agency_clients
  drop constraint if exists agency_clients_billing_owner_check;
alter table public.agency_clients
  add constraint agency_clients_billing_owner_check
  check (billing_owner in ('agency', 'client', 'shared'));

alter table public.agency_clients
  drop constraint if exists agency_clients_access_level_check;
alter table public.agency_clients
  add constraint agency_clients_access_level_check
  check (access_level in ('bookkeeping', 'review', 'audit', 'full_service'));

create index if not exists agency_clients_agency_status_idx
  on public.agency_clients(agency_id, status, created_at desc);

-- -----------------------------------------------------------------------------
-- 2. Standard feature keys and limits.
-- -----------------------------------------------------------------------------

insert into public.platform_products (code, name, description, product_type, status, sort_order)
values
  ('company_accounting', 'Nordklart Företag', 'Automatisk bokföring och bokslut för aktiebolag och enskilda firmor.', 'subscription', 'active', 5),
  ('agency_accounting', 'Nordklart Byrå', 'Byråabonnemang för redovisnings- och revisionsbyråer med flera kundbolag.', 'subscription', 'active', 6),
  ('commercial_addons', 'Nordklart Tillägg', 'Tillägg för extra användare, löner, kundbolag, Bankgiro, AI och API.', 'addon', 'active', 60)
on conflict (code) do update set
  name = excluded.name,
  description = excluded.description,
  product_type = excluded.product_type,
  status = excluded.status,
  sort_order = excluded.sort_order,
  updated_at = now();

insert into public.platform_features (code, name, category, description, risk_level, requires_human_review)
values
  ('bookkeeping.core', 'Bokföring', 'bookkeeping', 'Grundläggande bokföring och verifikationer.', 'normal', false),
  ('year_end.projects', 'Bokslut', 'year_end', 'Bokslutsprojekt och årsavslut.', 'normal', false),
  ('year_end.product', 'Bokslutsprodukt', 'year_end', 'Bokslutsfunktioner i produkten.', 'normal', false),
  ('reports.core', 'Rapporter', 'reports', 'Resultat, balans och grundrapporter.', 'normal', false),
  ('company.users', 'Bolagsanvändare', 'limits', 'Max antal interna användare i ett företagsworkspace.', 'low', false),
  ('external.advisors', 'Externa rådgivare/revisorer', 'limits', 'Max antal externa rådgivare, revisorer eller redovisningskonsulter direkt inbjudna till bolaget.', 'low', false),
  ('payroll.employees', 'Löneanställda', 'salary', 'Max antal aktiva anställda som kan hanteras i lönefunktionen.', 'normal', false),
  ('agency.clients', 'Byråkunder', 'agency', 'Max antal aktiva kundbolag under en byrå.', 'normal', false),
  ('agency.staff', 'Byråmedarbetare', 'agency', 'Max antal aktiva medarbetare i byråarbetsytan.', 'normal', false),
  ('agency.client_portal', 'Kundportal för byrå', 'agency', 'Kundbolag kan bjudas in och samverka med byrån.', 'normal', false),
  ('agency.review_queue', 'Byråns granskningskö', 'agency', 'Gemensam granskningskö för kundbolag.', 'normal', false),
  ('agency.deadlines', 'Byrådeadlines', 'agency', 'Deadline- och statusöversikt för byråkunder.', 'normal', false),
  ('bookkeeping.automation', 'Automatisk bokföring', 'automation', 'Automatiserad bokföring, bankmatchning och förslag.', 'normal', false),
  ('vat.reports', 'Momsrapport', 'tax', 'Momsrapport och momsunderlag.', 'normal', false),
  ('skatteverket.submissions', 'Skatteverket-flöden', 'tax', 'Förberedda/insända ärenden mot Skatteverket där integration finns.', 'high', true),
  ('salary.runs', 'Lönekörningar', 'salary', 'Skapa lönekörningar och AGI-underlag.', 'high', true),
  ('api.access', 'API-åtkomst', 'api', 'API-nycklar och integrationsåtkomst.', 'high', true),
  ('ai.assistant', 'AI-assistent', 'automation', 'AI-stöd för bokföring, avvikelsegranskning och förslag.', 'normal', false)
on conflict (code) do update set
  name = excluded.name,
  category = excluded.category,
  description = excluded.description,
  risk_level = excluded.risk_level,
  requires_human_review = excluded.requires_human_review,
  updated_at = now();

-- -----------------------------------------------------------------------------
-- 3. Seed editable company and agency plans. Superadmin can change prices later.
-- -----------------------------------------------------------------------------

with plan_seed as (
  select p.id as product_id, v.*
  from (values
    ('company_start', 'company_accounting', 'Företag Start', 'Automatisk bokföring och bokslut för enskild firma och mindre AB.', 199::numeric, 10, 'company', 'company_all', true, 'Företag Start', 'För enskild firma och mindre AB.', 'Från start', 10, '/register?plan=company_start', '{"users":"1 användare","payroll":"0 löneanställda","advisors":"1 extern rådgivare"}'::jsonb),
    ('company_plus', 'company_accounting', 'Företag Plus', 'Mer kapacitet för växande AB med fler användare och lön.', 399::numeric, 20, 'company', 'company_all', true, 'Företag Plus', 'För växande bolag med lön och fler användare.', 'Populär', 20, '/register?plan=company_plus', '{"users":"3 användare","payroll":"5 löneanställda","advisors":"2 externa rådgivare"}'::jsonb),
    ('company_pro', 'company_accounting', 'Företag Pro', 'Högre kapacitet, mer automation och integrationsstöd.', 799::numeric, 30, 'company', 'company_all', true, 'Företag Pro', 'För större bolag med fler anställda och mer automation.', 'Skalbar', 30, '/register?plan=company_pro', '{"users":"10 användare","payroll":"25 löneanställda","advisors":"5 externa rådgivare"}'::jsonb),
    ('agency_start', 'agency_accounting', 'Byrå Start', 'Byråabonnemang för mindre redovisnings- och revisionsbyråer.', 799::numeric, 40, 'agency', 'agency', true, 'Byrå Start', 'För mindre byråer som vill samla kundbolag.', 'För byrå', 10, '/register?workspace=agency&plan=agency_start', '{"staff":"2 byråmedarbetare","clients":"5 kundbolag"}'::jsonb),
    ('agency_plus', 'agency_accounting', 'Byrå Plus', 'Fler kundbolag, fler medarbetare och tydligare arbetskö.', 1999::numeric, 50, 'agency', 'agency', true, 'Byrå Plus', 'För växande byråer med flera konsulter och kundbolag.', 'Populär byrå', 20, '/register?workspace=agency&plan=agency_plus', '{"staff":"10 byråmedarbetare","clients":"25 kundbolag"}'::jsonb),
    ('agency_pro', 'agency_accounting', 'Byrå Pro', 'Högre volymer, integrationsstöd och avancerad byråstyrning.', 3999::numeric, 60, 'agency', 'agency', true, 'Byrå Pro', 'För etablerade byråer med många kundbolag.', 'Skalbar byrå', 30, '/register?workspace=agency&plan=agency_pro', '{"staff":"Obegränsat","clients":"100 kundbolag"}'::jsonb)
  ) as v(code, product_code, name, description, price_excl_vat, sort_order, audience_type, company_form_scope, is_public, public_name, public_summary, public_badge, public_sort_order, cta_href, marketing_metadata)
  join public.platform_products p on p.code = v.product_code
)
insert into public.platform_price_plans (
  product_id, code, name, description, billing_interval, currency, price_excl_vat,
  status, trial_days, sort_order, target_audience, is_default, audience_type,
  company_form_scope, is_public, public_name, public_summary, public_badge,
  public_sort_order, cta_label, cta_href, marketing_metadata
)
select
  product_id, code, name, description, 'month', 'SEK', price_excl_vat,
  'active', 14, sort_order, audience_type, code in ('company_plus','agency_plus'), audience_type,
  company_form_scope, is_public, public_name, public_summary, public_badge,
  public_sort_order, 'Kom igång', cta_href, marketing_metadata
from plan_seed
on conflict (code) do update set
  product_id = excluded.product_id,
  name = excluded.name,
  description = excluded.description,
  billing_interval = excluded.billing_interval,
  currency = excluded.currency,
  price_excl_vat = excluded.price_excl_vat,
  status = excluded.status,
  trial_days = excluded.trial_days,
  sort_order = excluded.sort_order,
  target_audience = excluded.target_audience,
  is_default = excluded.is_default,
  audience_type = excluded.audience_type,
  company_form_scope = excluded.company_form_scope,
  is_public = excluded.is_public,
  public_name = excluded.public_name,
  public_summary = excluded.public_summary,
  public_badge = excluded.public_badge,
  public_sort_order = excluded.public_sort_order,
  cta_label = excluded.cta_label,
  cta_href = excluded.cta_href,
  marketing_metadata = excluded.marketing_metadata,
  updated_at = now();

-- Ensure a current active version exists for the seeded plans. Existing active
-- versions are kept to avoid rewriting subscriptions.
insert into public.platform_plan_versions (
  plan_id, version_number, status, effective_from, currency, price_excl_vat,
  vat_rate, billing_interval, trial_days, monthly_included_clients,
  price_metadata, metadata, created_at, updated_at
)
select
  pp.id,
  1,
  'active',
  now(),
  pp.currency,
  pp.price_excl_vat,
  25,
  pp.billing_interval,
  pp.trial_days,
  case pp.code
    when 'agency_start' then 5
    when 'agency_plus' then 25
    when 'agency_pro' then 100
    else null
  end,
  jsonb_build_object('seeded_by', '20260630150000', 'price_from', true),
  jsonb_build_object('audience_type', pp.audience_type, 'public_plan', pp.is_public),
  now(),
  now()
from public.platform_price_plans pp
where pp.code in ('company_start','company_plus','company_pro','agency_start','agency_plus','agency_pro')
  and not exists (select 1 from public.platform_plan_versions pv where pv.plan_id = pp.id and pv.status = 'active');

with active_versions as (
  select distinct on (pp.code) pp.code as plan_code, pv.id as plan_version_id
  from public.platform_price_plans pp
  join public.platform_plan_versions pv on pv.plan_id = pp.id
  where pp.code in ('company_start','company_plus','company_pro','agency_start','agency_plus','agency_pro')
    and pv.status = 'active'
  order by pp.code, pv.version_number desc
), desired(plan_code, feature_code, limit_value, limit_unit) as (
  values
    ('company_start', 'bookkeeping.core', null::numeric, null::text),
    ('company_start', 'bookkeeping.automation', null, null),
    ('company_start', 'year_end.projects', null, null),
    ('company_start', 'year_end.product', null, null),
    ('company_start', 'reports.core', null, null),
    ('company_start', 'vat.reports', null, null),
    ('company_start', 'company.users', 1, 'users'),
    ('company_start', 'external.advisors', 1, 'users'),
    ('company_start', 'payroll.employees', 0, 'employees'),

    ('company_plus', 'bookkeeping.core', null, null),
    ('company_plus', 'bookkeeping.automation', null, null),
    ('company_plus', 'year_end.projects', null, null),
    ('company_plus', 'year_end.product', null, null),
    ('company_plus', 'reports.core', null, null),
    ('company_plus', 'vat.reports', null, null),
    ('company_plus', 'skatteverket.submissions', null, null),
    ('company_plus', 'salary.runs', null, null),
    ('company_plus', 'company.users', 3, 'users'),
    ('company_plus', 'external.advisors', 2, 'users'),
    ('company_plus', 'payroll.employees', 5, 'employees'),

    ('company_pro', 'bookkeeping.core', null, null),
    ('company_pro', 'bookkeeping.automation', null, null),
    ('company_pro', 'year_end.projects', null, null),
    ('company_pro', 'year_end.product', null, null),
    ('company_pro', 'reports.core', null, null),
    ('company_pro', 'vat.reports', null, null),
    ('company_pro', 'skatteverket.submissions', null, null),
    ('company_pro', 'salary.runs', null, null),
    ('company_pro', 'api.access', null, null),
    ('company_pro', 'ai.assistant', null, null),
    ('company_pro', 'company.users', 10, 'users'),
    ('company_pro', 'external.advisors', 5, 'users'),
    ('company_pro', 'payroll.employees', 25, 'employees'),

    ('agency_start', 'bookkeeping.core', null, null),
    ('agency_start', 'bookkeeping.automation', null, null),
    ('agency_start', 'year_end.projects', null, null),
    ('agency_start', 'year_end.product', null, null),
    ('agency_start', 'reports.core', null, null),
    ('agency_start', 'vat.reports', null, null),
    ('agency_start', 'agency.clients', 5, 'clients'),
    ('agency_start', 'agency.staff', 2, 'users'),
    ('agency_start', 'agency.client_portal', null, null),
    ('agency_start', 'agency.review_queue', null, null),
    ('agency_start', 'agency.deadlines', null, null),

    ('agency_plus', 'bookkeeping.core', null, null),
    ('agency_plus', 'bookkeeping.automation', null, null),
    ('agency_plus', 'year_end.projects', null, null),
    ('agency_plus', 'year_end.product', null, null),
    ('agency_plus', 'reports.core', null, null),
    ('agency_plus', 'vat.reports', null, null),
    ('agency_plus', 'skatteverket.submissions', null, null),
    ('agency_plus', 'salary.runs', null, null),
    ('agency_plus', 'agency.clients', 25, 'clients'),
    ('agency_plus', 'agency.staff', 10, 'users'),
    ('agency_plus', 'agency.client_portal', null, null),
    ('agency_plus', 'agency.review_queue', null, null),
    ('agency_plus', 'agency.deadlines', null, null),

    ('agency_pro', 'bookkeeping.core', null, null),
    ('agency_pro', 'bookkeeping.automation', null, null),
    ('agency_pro', 'year_end.projects', null, null),
    ('agency_pro', 'year_end.product', null, null),
    ('agency_pro', 'reports.core', null, null),
    ('agency_pro', 'vat.reports', null, null),
    ('agency_pro', 'skatteverket.submissions', null, null),
    ('agency_pro', 'salary.runs', null, null),
    ('agency_pro', 'api.access', null, null),
    ('agency_pro', 'ai.assistant', null, null),
    ('agency_pro', 'agency.clients', 100, 'clients'),
    ('agency_pro', 'agency.staff', null, 'users'),
    ('agency_pro', 'agency.client_portal', null, null),
    ('agency_pro', 'agency.review_queue', null, null),
    ('agency_pro', 'agency.deadlines', null, null)
)
insert into public.platform_plan_version_features (plan_version_id, feature_id, enabled, limit_value, limit_unit)
select av.plan_version_id, pf.id, true, d.limit_value, d.limit_unit
from desired d
join active_versions av on av.plan_code = d.plan_code
join public.platform_features pf on pf.code = d.feature_code
on conflict (plan_version_id, feature_id) do update set
  enabled = true,
  limit_value = excluded.limit_value,
  limit_unit = excluded.limit_unit,
  updated_at = now();

-- -----------------------------------------------------------------------------
-- 4. Usage counters and limit enforcement source of truth.
-- -----------------------------------------------------------------------------

create or replace view public.company_commercial_usage_v
as
select
  c.id as company_id,
  count(cm.id) filter (
    where cm.status = 'active'
      and coalesce(cm.membership_kind, 'internal') = 'internal'
      and cm.role in ('owner','admin','member','accountant')
  )::numeric as company_users,
  count(cm.id) filter (
    where cm.status = 'active'
      and (coalesce(cm.membership_kind, 'internal') = 'external' or cm.role in ('viewer','auditor'))
  )::numeric as external_advisors,
  count(e.id) filter (where coalesce(e.is_active, true) = true)::numeric as payroll_employees
from public.companies c
left join public.company_members cm on cm.company_id = c.id
left join public.employees e on e.company_id = c.id
group by c.id;

grant select on public.company_commercial_usage_v to authenticated, service_role;

create or replace view public.agency_commercial_usage_v
as
select
  a.id as agency_id,
  a.company_id as agency_company_id,
  count(distinct ac.id) filter (where ac.status = 'active')::numeric as agency_clients,
  count(distinct am.id) filter (where am.status = 'active')::numeric as agency_staff
from public.agencies a
left join public.agency_clients ac on ac.agency_id = a.id
left join public.agency_members am on am.agency_id = a.id
group by a.id, a.company_id;

grant select on public.agency_commercial_usage_v to authenticated, service_role;

create or replace function public.company_feature_usage(
  p_company_id uuid,
  p_feature_code text
)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_usage numeric := 0;
  v_agency_id uuid;
begin
  if p_feature_code = 'company.users' then
    select coalesce(company_users, 0) into v_usage from public.company_commercial_usage_v where company_id = p_company_id;
  elsif p_feature_code = 'external.advisors' then
    select coalesce(external_advisors, 0) into v_usage from public.company_commercial_usage_v where company_id = p_company_id;
  elsif p_feature_code = 'payroll.employees' then
    select coalesce(payroll_employees, 0) into v_usage from public.company_commercial_usage_v where company_id = p_company_id;
  elsif p_feature_code in ('agency.clients', 'agency.staff') then
    select a.id into v_agency_id
    from public.agencies a
    where a.company_id = p_company_id
    order by a.created_at desc
    limit 1;

    if v_agency_id is null then
      v_usage := 0;
    elsif p_feature_code = 'agency.clients' then
      select coalesce(agency_clients, 0) into v_usage from public.agency_commercial_usage_v where agency_id = v_agency_id;
    else
      select coalesce(agency_staff, 0) into v_usage from public.agency_commercial_usage_v where agency_id = v_agency_id;
    end if;
  else
    v_usage := 0;
  end if;

  return coalesce(v_usage, 0);
end;
$$;

grant execute on function public.company_feature_usage(uuid, text) to authenticated, service_role;

create or replace function public.company_commercial_limit(
  p_company_id uuid,
  p_feature_code text
)
returns table (
  allowed boolean,
  reason text,
  feature_code text,
  limit_value numeric,
  limit_unit text,
  usage_value numeric,
  remaining_value numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_access record;
  v_usage numeric := 0;
  v_effective_limit numeric;
  v_effective_unit text;
  v_subscription_has_unlimited boolean := false;
begin
  select * into v_access
  from public.company_feature_access(p_company_id, p_feature_code)
  limit 1;

  if not found then
    return query select false, 'missing_entitlement'::text, p_feature_code, null::numeric, null::text, null::numeric, null::numeric;
    return;
  end if;

  if coalesce(v_access.allowed, false) is false then
    return query select false, coalesce(v_access.reason, 'missing_entitlement'), p_feature_code, null::numeric, null::text, null::numeric, null::numeric;
    return;
  end if;

  v_usage := public.company_feature_usage(p_company_id, p_feature_code);
  v_effective_limit := v_access.limit_value;
  v_effective_unit := v_access.limit_unit;

  -- Subscription items may represent a base plan plus paid add-ons. For numeric
  -- commercial limits, the effective limit is the sum of all active subscription
  -- item limits for the same feature. A null limit in any active item means the
  -- feature is unlimited. Manual grants still keep priority through
  -- company_feature_access; this sum only improves normal subscription/add-on math.
  if v_access.source_type = 'subscription_item' then
    select
      coalesce(bool_or(pvf.limit_value is null), false),
      sum(coalesce(pvf.limit_value, 0)),
      max(pvf.limit_unit)
    into v_subscription_has_unlimited, v_effective_limit, v_effective_unit
    from public.company_subscription_items csi
    join public.company_subscriptions cs on cs.id = csi.subscription_id
    join public.platform_plan_version_features pvf on pvf.plan_version_id = csi.plan_version_id and pvf.enabled = true
    join public.platform_features pf on pf.id = pvf.feature_id
    where csi.company_id = p_company_id
      and cs.company_id = p_company_id
      and pf.code = p_feature_code
      and (
        csi.status in ('trialing', 'active')
        or (csi.status = 'past_due' and csi.grace_ends_at > now())
      )
      and (
        cs.status in ('trialing', 'active')
        or (cs.status = 'past_due' and cs.grace_ends_at > now())
      )
      and csi.starts_at <= now()
      and cs.starts_at <= now()
      and (
        csi.current_period_end is null
        or csi.current_period_end > now()
        or (csi.status = 'past_due' and csi.grace_ends_at > now())
      )
      and (
        cs.current_period_end is null
        or cs.current_period_end > now()
        or (cs.status = 'past_due' and cs.grace_ends_at > now())
      )
      and (cs.trial_ends_at is null or cs.status <> 'trialing' or cs.trial_ends_at > now());

    if v_subscription_has_unlimited then
      v_effective_limit := null;
    end if;
  end if;

  if v_effective_limit is null then
    return query select true, 'unlimited', p_feature_code, null::numeric, v_effective_unit, v_usage, null::numeric;
    return;
  end if;

  return query select
    v_usage < v_effective_limit,
    case when v_usage < v_effective_limit then 'within_limit' else 'limit_reached' end,
    p_feature_code,
    v_effective_limit,
    v_effective_unit,
    v_usage,
    greatest(v_effective_limit - v_usage, 0);
end;
$$;

grant execute on function public.company_commercial_limit(uuid, text) to authenticated, service_role;

create or replace function public.assert_company_commercial_limit(
  p_company_id uuid,
  p_feature_code text,
  p_error_message text default null
)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_limit record;
begin
  select * into v_limit
  from public.company_commercial_limit(p_company_id, p_feature_code)
  limit 1;

  if not coalesce(v_limit.allowed, false) then
    raise exception '%', coalesce(p_error_message, 'Planen tillåter inte åtgärden eller gränsen är nådd.')
      using errcode = 'P0001', detail = jsonb_build_object(
        'feature_code', p_feature_code,
        'reason', coalesce(v_limit.reason, 'unknown'),
        'limit_value', v_limit.limit_value,
        'usage_value', v_limit.usage_value
      )::text;
  end if;
end;
$$;

grant execute on function public.assert_company_commercial_limit(uuid, text, text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5. Public pricing view for nordklart.se/priser.
-- -----------------------------------------------------------------------------

create or replace view public.public_price_plans_v
as
with current_versions as (
  select distinct on (pv.plan_id)
    pv.*
  from public.platform_plan_versions pv
  where pv.status = 'active'
    and pv.effective_from <= now()
    and (pv.effective_until is null or pv.effective_until > now())
  order by pv.plan_id, pv.version_number desc, pv.effective_from desc
), version_features as (
  select
    pvf.plan_version_id,
    jsonb_agg(
      jsonb_build_object(
        'code', pf.code,
        'name', pf.name,
        'category', pf.category,
        'limitValue', pvf.limit_value,
        'limitUnit', pvf.limit_unit
      ) order by pf.category, pf.code
    ) filter (where coalesce(pvf.enabled, true)) as features_json,
    jsonb_object_agg(pf.code, jsonb_build_object('value', pvf.limit_value, 'unit', pvf.limit_unit)) filter (
      where pf.code in ('company.users','external.advisors','payroll.employees','agency.clients','agency.staff')
    ) as limits_json
  from public.platform_plan_version_features pvf
  join public.platform_features pf on pf.id = pvf.feature_id
  group by pvf.plan_version_id
)
select
  pp.id as plan_id,
  cv.id as plan_version_id,
  pp.code as plan_code,
  coalesce(pp.public_name, pp.name) as public_name,
  coalesce(pp.public_summary, pp.description) as public_summary,
  pp.public_badge,
  pp.audience_type,
  pp.company_form_scope,
  pp.cta_label,
  pp.cta_href,
  pp.marketing_metadata,
  cv.currency,
  cv.price_excl_vat as monthly_price_ex_vat,
  cv.billing_interval,
  ('Från ' || trim(to_char(cv.price_excl_vat, 'FM999999990')) || ' kr/mån') as price_from_label,
  coalesce(vf.features_json, '[]'::jsonb) as features_json,
  coalesce(vf.limits_json, '{}'::jsonb) as limits_json,
  pp.public_sort_order,
  pp.sort_order
from public.platform_price_plans pp
join current_versions cv on cv.plan_id = pp.id
left join version_features vf on vf.plan_version_id = cv.id
where pp.status = 'active'
  and pp.is_public = true
  and pp.audience_type in ('company', 'agency')
order by pp.audience_type, pp.public_sort_order, pp.sort_order;

grant select on public.public_price_plans_v to anon, authenticated, service_role;

create or replace view public.public_price_start_v
as
select audience_type, min(monthly_price_ex_vat) as price_from_ex_vat
from public.public_price_plans_v
group by audience_type;

grant select on public.public_price_start_v to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 6. Platform admin RPC for plan commercial profile.
-- -----------------------------------------------------------------------------

create or replace function public.platform_set_price_plan_commercial_profile(
  p_plan_id uuid,
  p_audience_type text,
  p_company_form_scope text,
  p_is_public boolean,
  p_public_name text default null,
  p_public_summary text default null,
  p_public_badge text default null,
  p_public_sort_order integer default 100,
  p_cta_label text default 'Kom igång',
  p_cta_href text default '/register',
  p_marketing_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Endast superadmin kan ändra planernas publika/kommersiella profil.';
  end if;

  if p_audience_type not in ('company', 'agency', 'both', 'addon', 'internal') then
    raise exception 'Ogiltig målgrupp för plan.';
  end if;

  if p_company_form_scope not in ('limited_company', 'sole_trader', 'company_all', 'agency', 'not_applicable') then
    raise exception 'Ogiltigt bolagsforms-scope för plan.';
  end if;

  update public.platform_price_plans
  set
    audience_type = p_audience_type,
    company_form_scope = p_company_form_scope,
    is_public = coalesce(p_is_public, false),
    public_name = nullif(trim(coalesce(p_public_name, '')), ''),
    public_summary = nullif(trim(coalesce(p_public_summary, '')), ''),
    public_badge = nullif(trim(coalesce(p_public_badge, '')), ''),
    public_sort_order = coalesce(p_public_sort_order, 100),
    cta_label = coalesce(nullif(trim(coalesce(p_cta_label, '')), ''), 'Kom igång'),
    cta_href = coalesce(nullif(trim(coalesce(p_cta_href, '')), ''), '/register'),
    marketing_metadata = coalesce(p_marketing_metadata, '{}'::jsonb),
    updated_at = now()
  where id = p_plan_id;

  if not found then
    raise exception 'Planen finns inte.';
  end if;
end;
$$;

revoke all on function public.platform_set_price_plan_commercial_profile(uuid, text, text, boolean, text, text, text, integer, text, text, jsonb) from public;
grant execute on function public.platform_set_price_plan_commercial_profile(uuid, text, text, boolean, text, text, text, integer, text, text, jsonb) to authenticated;

notify pgrst, 'reload schema';

-- -----------------------------------------------------------------------------
-- 7. Access resolver understands external advisors/auditors and active agency staff.
-- -----------------------------------------------------------------------------

create or replace function public.user_can_access_company_v2(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_platform_admin()
    or exists (
      select 1
      from public.company_members cm
      where cm.company_id = p_company_id
        and cm.user_id = auth.uid()
        and public.company_member_is_active(cm.status)
    )
    or exists (
      select 1
      from public.agency_clients ac
      join public.agency_members am on am.agency_id = ac.agency_id
      where ac.company_id = p_company_id
        and ac.status = 'active'
        and am.status = 'active'
        and am.user_id = auth.uid()
    );
$$;

grant execute on function public.user_can_access_company_v2(uuid) to authenticated;

create or replace function public.resolve_company_access(p_company_id uuid)
returns table (
  company_id uuid,
  access_source text,
  agency_id uuid,
  effective_role text,
  can_read boolean,
  can_write boolean,
  can_review boolean,
  can_manage_company boolean,
  can_manage_agency boolean,
  can_manage_platform boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with candidates as (
    select
      p_company_id as company_id,
      'platform'::text as access_source,
      null::uuid as agency_id,
      'platform_admin'::text as effective_role,
      null::text as membership_status,
      100 as role_rank
    where public.is_platform_admin()

    union all

    select
      cm.company_id,
      'direct'::text,
      null::uuid,
      case cm.role
        when 'owner' then 'company_owner'
        when 'admin' then 'company_admin'
        when 'accountant' then 'accountant'
        when 'auditor' then 'auditor'
        when 'viewer' then 'read_only'
        when 'member' then 'client_user'
        else 'read_only'
      end,
      cm.status,
      case cm.role when 'owner' then 90 when 'admin' then 80 when 'accountant' then 55 when 'member' then 50 when 'auditor' then 35 else 10 end
    from public.company_members cm
    where cm.company_id = p_company_id
      and cm.user_id = auth.uid()
      and public.company_member_is_active(cm.status)

    union all

    select
      ac.company_id,
      'agency'::text,
      am.agency_id,
      case am.role
        when 'agency_owner' then 'company_admin'
        when 'agency_admin' then 'company_admin'
        when 'accountant' then 'accountant'
        when 'reviewer' then 'reviewer'
        else 'read_only'
      end,
      'active'::text,
      case am.role
        when 'agency_owner' then 75
        when 'agency_admin' then 70
        when 'accountant' then 60
        when 'reviewer' then 40
        else 10
      end
    from public.agency_clients ac
    join public.agency_members am on am.agency_id = ac.agency_id
    where ac.company_id = p_company_id
      and ac.status = 'active'
      and am.status = 'active'
      and am.user_id = auth.uid()
  ), selected as (
    select * from candidates order by role_rank desc, access_source asc limit 1
  )
  select
    company_id,
    access_source,
    agency_id,
    effective_role,
    true as can_read,
    effective_role in ('platform_admin', 'company_owner', 'company_admin', 'accountant', 'client_user')
      and coalesce(membership_status, 'active') = 'active' as can_write,
    effective_role in ('platform_admin', 'company_owner', 'company_admin', 'accountant', 'reviewer', 'auditor')
      and coalesce(membership_status, 'active') = 'active' as can_review,
    effective_role in ('platform_admin', 'company_owner', 'company_admin')
      and coalesce(membership_status, 'active') = 'active' as can_manage_company,
    effective_role = 'platform_admin' or (access_source = 'agency' and effective_role = 'company_admin') as can_manage_agency,
    effective_role = 'platform_admin' as can_manage_platform
  from selected;
$$;

grant execute on function public.resolve_company_access(uuid) to authenticated;
notify pgrst, 'reload schema';

-- Reset commercial mutation bypass after controlled migration work.
select set_config('nordklart.commercial_mutation', 'off', false);
notify pgrst, 'reload schema';
