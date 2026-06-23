-- Nordklart commercial completion patch.
-- Non-destructive completion of commercial add-ons, agency staff invitations,
-- effective limit math and workspace-role clarity.

select set_config('nordklart.commercial_mutation', 'on', false);

-- -----------------------------------------------------------------------------
-- 1. Agency staff invitations. Kept separate from company invitations so a user
-- can be invited to a byrå without becoming a direct member of a customer company.
-- -----------------------------------------------------------------------------

create table if not exists public.agency_invitations (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  email text not null,
  role text not null check (role in ('agency_admin', 'accountant', 'reviewer', 'read_only')),
  token_hash text not null unique,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked', 'expired')),
  invited_by uuid references auth.users(id) on delete set null,
  accepted_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  expires_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agency_invitations_email_normalized check (email = lower(trim(email)))
);

create unique index if not exists agency_invitations_one_pending_email_idx
  on public.agency_invitations(agency_id, email)
  where status = 'pending';

create index if not exists agency_invitations_agency_status_idx
  on public.agency_invitations(agency_id, status, expires_at);

alter table public.agency_invitations enable row level security;

drop policy if exists agency_invitations_select_admin on public.agency_invitations;
create policy agency_invitations_select_admin on public.agency_invitations
  for select using (
    public.is_platform_admin()
    or exists (
      select 1
      from public.agency_members am
      where am.agency_id = agency_invitations.agency_id
        and am.user_id = auth.uid()
        and am.status = 'active'
        and am.role in ('agency_owner', 'agency_admin')
    )
  );

drop policy if exists agency_invitations_platform_write on public.agency_invitations;
create policy agency_invitations_platform_write on public.agency_invitations
  for all using (public.is_platform_admin()) with check (public.is_platform_admin());


update public.platform_price_plans
set
  cta_href = case code
    when 'company_start' then '/register?intent=company&plan=company_start'
    when 'company_plus' then '/register?intent=company&plan=company_plus'
    when 'company_pro' then '/register?intent=company&plan=company_pro'
    when 'agency_start' then '/register?intent=agency&workspace=agency&plan=agency_start'
    when 'agency_plus' then '/register?intent=agency&workspace=agency&plan=agency_plus'
    when 'agency_pro' then '/register?intent=agency&workspace=agency&plan=agency_pro'
    else cta_href
  end,
  updated_at = now()
where code in ('company_start','company_plus','company_pro','agency_start','agency_plus','agency_pro');

-- -----------------------------------------------------------------------------
-- 2. Add-on feature keys and products/plans.
-- -----------------------------------------------------------------------------

insert into public.platform_features (code, name, category, description, risk_level, requires_human_review)
values
  ('api.webhooks', 'API-webhooks', 'api', 'Utgående webhooks och integrationshändelser.', 'high', true),
  ('webhooks.delivery', 'Webhook-leverans', 'api', 'Leverans, omförsök och loggning av webhooks.', 'high', true),
  ('bankgiro.operations', 'Bankgiro-drift', 'bankgiro', 'Bankgiro- och betalningsoperationer efter slutförd provider-setup.', 'high', true),
  ('bankgiro.onboarding', 'Bankgiro-onboarding', 'bankgiro', 'Ansökan och onboarding för Bankgiro/Autogiro.', 'normal', true),
  ('bankgiro.application', 'Bankgiro-ansökan', 'bankgiro', 'Hantera Bankgiro-ansökan och dokument.', 'normal', true)
on conflict (code) do update set
  name = excluded.name,
  category = excluded.category,
  description = excluded.description,
  risk_level = excluded.risk_level,
  requires_human_review = excluded.requires_human_review,
  updated_at = now();

insert into public.platform_products (code, name, description, product_type, status, sort_order)
values
  ('commercial_addons', 'Nordklart Tillägg', 'Tillägg för extra användare, löner, byråkunder, Bankgiro, API och AI.', 'addon', 'active', 60)
on conflict (code) do update set
  name = excluded.name,
  description = excluded.description,
  product_type = excluded.product_type,
  status = excluded.status,
  sort_order = excluded.sort_order,
  updated_at = now();

with addon_seed as (
  select p.id as product_id, v.*
  from (values
    ('addon_extra_company_user', 'Extra bolagsanvändare', 'Lägg till en extra intern användare i ett företagsworkspace.', 79::numeric, 610, 'company.users', 1::numeric, 'users', '{"addon_kind":"capacity","capacity_feature":"company.users"}'::jsonb),
    ('addon_extra_external_advisor', 'Extra extern rådgivare', 'Lägg till en extra extern rådgivare eller revisor.', 49::numeric, 620, 'external.advisors', 1::numeric, 'users', '{"addon_kind":"capacity","capacity_feature":"external.advisors"}'::jsonb),
    ('addon_extra_payroll_5_employees', 'Extra 5 löneanställda', 'Öka lönekapaciteten med fem aktiva löneanställda.', 149::numeric, 630, 'payroll.employees', 5::numeric, 'employees', '{"addon_kind":"capacity","capacity_feature":"payroll.employees"}'::jsonb),
    ('addon_extra_agency_10_clients', 'Extra 10 byråkunder', 'Öka byråplanens kapacitet med tio aktiva kundbolag.', 499::numeric, 640, 'agency.clients', 10::numeric, 'clients', '{"addon_kind":"capacity","capacity_feature":"agency.clients"}'::jsonb),
    ('addon_extra_agency_staff', 'Extra byråmedarbetare', 'Lägg till en extra medarbetare i byråarbetsytan.', 199::numeric, 650, 'agency.staff', 1::numeric, 'users', '{"addon_kind":"capacity","capacity_feature":"agency.staff"}'::jsonb),
    ('addon_bankgiro_operations', 'Bankgiro-tillägg', 'Bankgiro/Autogiro-stöd när provider-setup är klar.', 99::numeric, 660, 'bankgiro.operations', null::numeric, null::text, '{"addon_kind":"feature"}'::jsonb),
    ('addon_api_webhooks', 'API & webhooks', 'API-åtkomst och webhooks för integrationer.', 299::numeric, 670, 'api.access', null::numeric, null::text, '{"addon_kind":"feature"}'::jsonb),
    ('addon_ai_automation', 'AI & automation plus', 'Mer AI-stöd och automatiseringsfunktioner.', 199::numeric, 680, 'ai.assistant', null::numeric, null::text, '{"addon_kind":"feature"}'::jsonb)
  ) as v(code, name, description, price_excl_vat, sort_order, primary_feature_code, limit_value, limit_unit, metadata)
  join public.platform_products p on p.code = 'commercial_addons'
)
insert into public.platform_price_plans (
  product_id, code, name, description, billing_interval, currency, price_excl_vat,
  status, trial_days, sort_order, target_audience, is_default, audience_type,
  company_form_scope, is_public, public_name, public_summary, public_badge,
  public_sort_order, cta_label, cta_href, marketing_metadata
)
select
  product_id, code, name, description, 'month', 'SEK', price_excl_vat,
  'active', 0, sort_order, 'addon', false, 'addon',
  'not_applicable', false, name, description, null,
  sort_order, 'Lägg till', '/platform/price-plans', metadata
from addon_seed
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
  is_default = false,
  audience_type = 'addon',
  company_form_scope = 'not_applicable',
  is_public = false,
  public_name = excluded.public_name,
  public_summary = excluded.public_summary,
  cta_label = excluded.cta_label,
  cta_href = excluded.cta_href,
  marketing_metadata = excluded.marketing_metadata,
  updated_at = now();

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
  0,
  null,
  jsonb_build_object('seeded_by', '20260701120000', 'addon', true),
  jsonb_build_object('audience_type', 'addon', 'addon_code', pp.code),
  now(),
  now()
from public.platform_price_plans pp
where pp.code in (
  'addon_extra_company_user',
  'addon_extra_external_advisor',
  'addon_extra_payroll_5_employees',
  'addon_extra_agency_10_clients',
  'addon_extra_agency_staff',
  'addon_bankgiro_operations',
  'addon_api_webhooks',
  'addon_ai_automation'
)
  and not exists (select 1 from public.platform_plan_versions pv where pv.plan_id = pp.id and pv.status = 'active');

with active_versions as (
  select distinct on (pp.code) pp.code as plan_code, pv.id as plan_version_id
  from public.platform_price_plans pp
  join public.platform_plan_versions pv on pv.plan_id = pp.id
  where pp.code in (
    'addon_extra_company_user',
    'addon_extra_external_advisor',
    'addon_extra_payroll_5_employees',
    'addon_extra_agency_10_clients',
    'addon_extra_agency_staff',
    'addon_bankgiro_operations',
    'addon_api_webhooks',
    'addon_ai_automation'
  )
    and pv.status = 'active'
  order by pp.code, pv.version_number desc
), desired(plan_code, feature_code, limit_value, limit_unit) as (
  values
    ('addon_extra_company_user', 'company.users', 1::numeric, 'users'),
    ('addon_extra_external_advisor', 'external.advisors', 1::numeric, 'users'),
    ('addon_extra_payroll_5_employees', 'payroll.employees', 5::numeric, 'employees'),
    ('addon_extra_payroll_5_employees', 'salary.runs', null::numeric, null::text),
    ('addon_extra_agency_10_clients', 'agency.clients', 10::numeric, 'clients'),
    ('addon_extra_agency_staff', 'agency.staff', 1::numeric, 'users'),
    ('addon_bankgiro_operations', 'bankgiro.onboarding', null::numeric, null::text),
    ('addon_bankgiro_operations', 'bankgiro.application', null::numeric, null::text),
    ('addon_bankgiro_operations', 'bankgiro.operations', null::numeric, null::text),
    ('addon_api_webhooks', 'api.access', null::numeric, null::text),
    ('addon_api_webhooks', 'api.webhooks', null::numeric, null::text),
    ('addon_api_webhooks', 'webhooks.delivery', null::numeric, null::text),
    ('addon_ai_automation', 'ai.assistant', null::numeric, null::text),
    ('addon_ai_automation', 'bookkeeping.automation', null::numeric, null::text)
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
-- 3. Usage counters: count distinct rows and include pending invitations so
-- admins cannot overbook by sending several pending invites at once.
-- -----------------------------------------------------------------------------

create or replace view public.company_commercial_usage_v
as
select
  c.id as company_id,
  (
    count(distinct cm.id) filter (
      where cm.status = 'active'
        and coalesce(cm.membership_kind, 'internal') = 'internal'
        and cm.role in ('owner','admin','member','accountant')
    )
    + count(distinct ci.id) filter (
      where ci.status = 'pending'
        and ci.expires_at > now()
        and coalesce(ci.membership_kind, 'internal') = 'internal'
        and ci.role in ('admin','member')
    )
  )::numeric as company_users,
  (
    count(distinct cm.id) filter (
      where cm.status = 'active'
        and (coalesce(cm.membership_kind, 'internal') = 'external' or cm.role in ('viewer','auditor'))
    )
    + count(distinct ci.id) filter (
      where ci.status = 'pending'
        and ci.expires_at > now()
        and (coalesce(ci.membership_kind, 'internal') = 'external' or ci.role in ('viewer','accountant','auditor'))
    )
  )::numeric as external_advisors,
  count(distinct e.id) filter (where coalesce(e.is_active, true) = true)::numeric as payroll_employees
from public.companies c
left join public.company_members cm on cm.company_id = c.id
left join public.company_invitations ci on ci.company_id = c.id
left join public.employees e on e.company_id = c.id
group by c.id;

grant select on public.company_commercial_usage_v to authenticated, service_role;

create or replace view public.agency_commercial_usage_v
as
select
  a.id as agency_id,
  a.company_id as agency_company_id,
  (
    count(distinct ac.id) filter (where ac.status = 'active')
  )::numeric as agency_clients,
  (
    count(distinct am.id) filter (where am.status = 'active')
    + count(distinct ai.id) filter (where ai.status = 'pending' and ai.expires_at > now())
  )::numeric as agency_staff
from public.agencies a
left join public.agency_clients ac on ac.agency_id = a.id
left join public.agency_members am on am.agency_id = a.id
left join public.agency_invitations ai on ai.agency_id = a.id
group by a.id, a.company_id;

grant select on public.agency_commercial_usage_v to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4. Effective commercial limit math. Quantity on add-ons now multiplies numeric
-- limits. Grace checks use item grace first, then subscription grace.
-- -----------------------------------------------------------------------------

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

  if v_access.source_type = 'subscription_item' then
    select
      coalesce(bool_or(pvf.limit_value is null), false),
      sum(coalesce(pvf.limit_value, 0) * greatest(coalesce(csi.quantity, 1), 0)),
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
        or (csi.status = 'past_due' and coalesce(csi.grace_ends_at, cs.grace_ends_at) > now())
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
        or (csi.status = 'past_due' and coalesce(csi.grace_ends_at, cs.grace_ends_at) > now())
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

create or replace view public.company_effective_commercial_limits_v
as
select
  c.id as company_id,
  f.code as feature_code,
  l.allowed,
  l.reason,
  l.limit_value,
  l.limit_unit,
  l.usage_value,
  l.remaining_value
from public.companies c
cross join public.platform_features f
cross join lateral public.company_commercial_limit(c.id, f.code) l
where f.code in ('company.users','external.advisors','payroll.employees','agency.clients','agency.staff');

grant select on public.company_effective_commercial_limits_v to authenticated, service_role;

notify pgrst, 'reload schema';
select set_config('nordklart.commercial_mutation', 'off', false);
notify pgrst, 'reload schema';
