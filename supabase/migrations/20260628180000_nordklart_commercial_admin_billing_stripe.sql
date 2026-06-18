-- Nordklart commercial phases 3-5: superadmin controls, customer billing UI and
-- Stripe checkout/webhook reconciliation. The database remains the access source
-- of truth; Stripe only confirms payments and subscription lifecycle events.

-- -----------------------------------------------------------------------------
-- 1. Billing identity, checkout intent and webhook idempotency
-- -----------------------------------------------------------------------------
create table if not exists public.company_billing_profiles (
  company_id uuid primary key references public.companies(id) on delete cascade,
  stripe_customer_id text unique,
  billing_email text,
  billing_name text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_checkout_sessions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  plan_version_id uuid not null references public.platform_plan_versions(id) on delete restrict,
  checkout_kind text not null check (checkout_kind in ('subscription', 'addon', 'one_time')),
  parent_subscription_id uuid references public.company_subscriptions(id) on delete set null,
  fiscal_period_id uuid references public.fiscal_periods(id) on delete set null,
  stripe_checkout_session_id text unique,
  stripe_customer_id text,
  stripe_subscription_id text,
  status text not null default 'created' check (status in ('created', 'open', 'completed', 'expired', 'failed')),
  amount_excl_vat numeric(12,2) not null check (amount_excl_vat >= 0),
  currency text not null default 'SEK',
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  completed_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_checkout_sessions_parent_required check (
    checkout_kind <> 'addon' or parent_subscription_id is not null
  )
);

-- A fiscal period is mandatory only for the year-end product, not all future
-- one-time products. The webhook finalizer validates that product-specific rule.
alter table public.billing_checkout_sessions
  drop constraint if exists billing_checkout_sessions_year_end_period;

create index if not exists billing_checkout_sessions_company_status_idx
  on public.billing_checkout_sessions(company_id, status, created_at desc);
create index if not exists billing_checkout_sessions_stripe_subscription_idx
  on public.billing_checkout_sessions(stripe_subscription_id)
  where stripe_subscription_id is not null;

create table if not exists public.stripe_webhook_events (
  id uuid primary key default gen_random_uuid(),
  stripe_event_id text not null unique,
  event_type text not null,
  livemode boolean,
  stripe_api_version text,
  company_id uuid references public.companies(id) on delete set null,
  status text not null default 'received' check (status in ('received', 'processed', 'ignored', 'failed')),
  attempt_count integer not null default 1 check (attempt_count > 0),
  payload jsonb not null,
  processing_error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists stripe_webhook_events_status_idx
  on public.stripe_webhook_events(status, received_at desc);
create index if not exists stripe_webhook_events_company_idx
  on public.stripe_webhook_events(company_id, received_at desc)
  where company_id is not null;

-- A paid/active book-closing purchase is singular per accounting period.
-- Older installations can contain duplicate provisional rows. Keep the newest
-- active record and retain older records as cancelled audit history before the
-- unique partial index is enforced.
with ranked_year_end_purchases as (
  select
    id,
    row_number() over (
      partition by company_id, fiscal_period_id
      order by coalesce(paid_at, access_starts_at, created_at) desc, created_at desc, id desc
    ) as row_number
  from public.one_time_purchases
  where purchase_type = 'year_end'
    and fiscal_period_id is not null
    and status in ('pending_payment', 'paid', 'active', 'fulfilled')
)
update public.one_time_purchases otp
set
  status = 'cancelled',
  metadata = otp.metadata || jsonb_build_object(
    'commercial_deduplicated_at', now(),
    'commercial_deduplication_reason', 'duplicate_active_year_end_purchase'
  ),
  updated_at = now()
from ranked_year_end_purchases ranked
where ranked.id = otp.id
  and ranked.row_number > 1;

create unique index if not exists one_time_purchases_year_end_active_period_unique_idx
  on public.one_time_purchases(company_id, fiscal_period_id)
  where purchase_type = 'year_end'
    and status in ('pending_payment', 'paid', 'active', 'fulfilled');

-- -----------------------------------------------------------------------------
-- 2. Narrow helpers and commercial management RPCs
-- -----------------------------------------------------------------------------
create or replace function public.user_can_manage_company_billing(p_company_id uuid)
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
        and cm.role in ('owner', 'admin')
    );
$$;

create or replace function public.require_service_role()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Åtgärden får bara köras av Nordklarts betrodda serverprocess.' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.platform_create_price_plan(
  p_product_id uuid,
  p_code text,
  p_name text,
  p_description text default null,
  p_billing_interval text default 'month',
  p_currency text default 'SEK',
  p_trial_days integer default 0,
  p_monthly_included_clients integer default null,
  p_sort_order integer default 100
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan_id uuid;
  v_product_status text;
begin
  perform public.require_platform_commercial_admin();

  if nullif(trim(p_code), '') is null
     or p_code !~ '^[a-z0-9]+(?:_[a-z0-9]+)*$'
     or nullif(trim(p_name), '') is null then
    raise exception 'Plankod och namn måste vara giltiga.' using errcode = '22023';
  end if;
  if p_billing_interval not in ('month', 'year', 'one_time') then
    raise exception 'Ogiltigt faktureringsintervall.' using errcode = '22023';
  end if;
  if p_trial_days < 0 or (p_monthly_included_clients is not null and p_monthly_included_clients < 0) then
    raise exception 'Planens gränsvärden är ogiltiga.' using errcode = '22023';
  end if;

  select status into v_product_status from public.platform_products where id = p_product_id;
  if not found then
    raise exception 'Produkten finns inte.' using errcode = 'P0002';
  end if;
  if v_product_status = 'archived' then
    raise exception 'En arkiverad produkt kan inte få nya planer.' using errcode = '23514';
  end if;

  perform set_config('nordklart.commercial_mutation', 'on', true);
  insert into public.platform_price_plans (
    product_id, code, name, description, billing_interval, currency,
    price_excl_vat, status, trial_days, monthly_included_clients, sort_order
  ) values (
    p_product_id,
    lower(trim(p_code)),
    trim(p_name),
    nullif(trim(p_description), ''),
    p_billing_interval,
    upper(coalesce(nullif(trim(p_currency), ''), 'SEK')),
    0,
    'active',
    coalesce(p_trial_days, 0),
    p_monthly_included_clients,
    coalesce(p_sort_order, 100)
  ) returning id into v_plan_id;

  return v_plan_id;
end;
$$;

create or replace function public.platform_update_price_plan_catalog(
  p_plan_id uuid,
  p_name text default null,
  p_description text default null,
  p_status text default null,
  p_sort_order integer default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_platform_commercial_admin();

  if p_status is not null and p_status not in ('active', 'paused', 'archived') then
    raise exception 'Ogiltig planstatus.' using errcode = '22023';
  end if;
  if p_name is not null and nullif(trim(p_name), '') is null then
    raise exception 'Plannamnet får inte vara tomt.' using errcode = '22023';
  end if;

  perform set_config('nordklart.commercial_mutation', 'on', true);
  update public.platform_price_plans
  set
    name = coalesce(nullif(trim(p_name), ''), name),
    description = case when p_description is null then description else nullif(trim(p_description), '') end,
    status = coalesce(p_status, status),
    sort_order = coalesce(p_sort_order, sort_order),
    updated_at = now()
  where id = p_plan_id;

  if not found then
    raise exception 'Prisplanen finns inte.' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.platform_bind_stripe_price(
  p_plan_version_id uuid,
  p_stripe_product_id text,
  p_stripe_price_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  perform public.require_platform_commercial_admin();
  if nullif(trim(p_stripe_product_id), '') is null or nullif(trim(p_stripe_price_id), '') is null then
    raise exception 'Stripe produkt- och pris-id krävs.' using errcode = '22023';
  end if;

  select status into v_status from public.platform_plan_versions where id = p_plan_version_id for update;
  if not found then
    raise exception 'Planversionen finns inte.' using errcode = 'P0002';
  end if;
  if v_status <> 'draft' then
    raise exception 'Stripe-pris får endast kopplas till ett planutkast.' using errcode = '23514';
  end if;

  perform set_config('nordklart.commercial_mutation', 'on', true);
  update public.platform_plan_versions
  set stripe_product_id = trim(p_stripe_product_id), stripe_price_id = trim(p_stripe_price_id), updated_at = now()
  where id = p_plan_version_id;
end;
$$;

create or replace function public.platform_retire_price_plan_version(p_plan_version_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  perform public.require_platform_commercial_admin();
  select status into v_status from public.platform_plan_versions where id = p_plan_version_id for update;
  if not found then
    raise exception 'Planversionen finns inte.' using errcode = 'P0002';
  end if;
  if v_status = 'retired' then return; end if;

  perform set_config('nordklart.commercial_mutation', 'on', true);
  update public.platform_plan_versions
  set status = 'retired', effective_until = coalesce(effective_until, now()), updated_at = now()
  where id = p_plan_version_id;
end;
$$;

-- Applies a completed Checkout only from a verified Stripe webhook. It never
-- accepts frontend data as proof of payment.
create or replace function public.stripe_finalize_checkout(
  p_stripe_event_id text,
  p_stripe_checkout_session_id text,
  p_stripe_customer_id text,
  p_stripe_subscription_id text default null,
  p_payment_status text default null,
  p_amount_total_minor bigint default null,
  p_currency text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_checkout public.billing_checkout_sessions%rowtype;
  v_version public.platform_plan_versions%rowtype;
  v_plan public.platform_price_plans%rowtype;
  v_product public.platform_products%rowtype;
  v_subscription_id uuid;
  v_item_id uuid;
begin
  perform public.require_service_role();

  select * into v_checkout
  from public.billing_checkout_sessions
  where stripe_checkout_session_id = p_stripe_checkout_session_id
  for update;
  if not found then
    raise exception 'Checkout-session saknas i Nordklart.' using errcode = 'P0002';
  end if;
  if v_checkout.status = 'completed' then return; end if;

  update public.billing_checkout_sessions
  set
    stripe_customer_id = coalesce(nullif(trim(p_stripe_customer_id), ''), stripe_customer_id),
    stripe_subscription_id = coalesce(nullif(trim(p_stripe_subscription_id), ''), stripe_subscription_id),
    status = case when coalesce(p_payment_status, '') in ('paid', 'no_payment_required') then 'completed' else 'open' end,
    completed_at = case when coalesce(p_payment_status, '') in ('paid', 'no_payment_required') then now() else null end,
    updated_at = now()
  where id = v_checkout.id
  returning * into v_checkout;

  if coalesce(p_payment_status, '') not in ('paid', 'no_payment_required') then
    return;
  end if;

  insert into public.company_billing_profiles (company_id, stripe_customer_id, metadata)
  values (v_checkout.company_id, nullif(trim(p_stripe_customer_id), ''), jsonb_build_object('last_checkout_event_id', p_stripe_event_id))
  on conflict (company_id) do update set
    stripe_customer_id = coalesce(excluded.stripe_customer_id, company_billing_profiles.stripe_customer_id),
    metadata = company_billing_profiles.metadata || excluded.metadata,
    updated_at = now();

  select pv.* into v_version from public.platform_plan_versions pv where pv.id = v_checkout.plan_version_id;
  select pp.* into v_plan from public.platform_price_plans pp where pp.id = v_version.plan_id;
  select pr.* into v_product from public.platform_products pr where pr.id = v_plan.product_id;
  if v_product.status <> 'active' or v_plan.status <> 'active' then
    raise exception 'Köpet avser en plan som inte längre är aktiv.' using errcode = '23514';
  end if;
  if v_product.code = 'year_end' and v_checkout.fiscal_period_id is null then
    raise exception 'Bokslutsköp måste vara kopplat till ett räkenskapsår.' using errcode = '23514';
  end if;

  if v_checkout.checkout_kind = 'subscription' then
    if nullif(trim(p_stripe_subscription_id), '') is null then
      raise exception 'Stripe skickade inget abonnemangs-id för abonnemangsköpet.' using errcode = '23514';
    end if;

    update public.company_subscriptions cs
    set status = 'cancelled', cancelled_at = now(), current_period_end = coalesce(cs.current_period_end, now()), updated_at = now()
    from public.platform_price_plans pp
    join public.platform_products pr on pr.id = pp.product_id
    where cs.company_id = v_checkout.company_id
      and cs.plan_id = pp.id
      and pr.product_type = 'subscription'
      and cs.status in ('trialing', 'active', 'past_due', 'paused');

    insert into public.company_subscriptions (
      company_id, plan_id, plan_version_id, status, starts_at, current_period_start,
      external_provider, external_subscription_id, created_by, price_snapshot, override_note
    ) values (
      v_checkout.company_id, v_version.plan_id, v_version.id, 'active', now(), now(),
      'stripe', trim(p_stripe_subscription_id), v_checkout.created_by,
      public.plan_version_snapshot(v_version.id), 'Stripe Checkout'
    ) returning id into v_subscription_id;

  elsif v_checkout.checkout_kind = 'addon' then
    if nullif(trim(p_stripe_subscription_id), '') is null then
      raise exception 'Stripe skickade inget abonnemangs-id för tillägget.' using errcode = '23514';
    end if;
    if v_checkout.parent_subscription_id is null or not exists (
      select 1 from public.company_subscriptions cs
      where cs.id = v_checkout.parent_subscription_id and cs.company_id = v_checkout.company_id
    ) then
      raise exception 'Tillägget saknar ett giltigt basabonnemang.' using errcode = '23514';
    end if;

    select id into v_item_id
    from public.company_subscription_items
    where subscription_id = v_checkout.parent_subscription_id
      and plan_version_id = v_version.id
      and item_type = 'addon'
      and external_provider = 'stripe'
      and external_subscription_item_id = trim(p_stripe_subscription_id)
    limit 1;

    if v_item_id is null then
      insert into public.company_subscription_items (
        subscription_id, company_id, plan_version_id, item_type, status, quantity,
        starts_at, current_period_start, external_provider, external_subscription_item_id,
        price_snapshot, metadata, created_by
      ) values (
        v_checkout.parent_subscription_id, v_checkout.company_id, v_version.id, 'addon', 'active', 1,
        now(), now(), 'stripe', trim(p_stripe_subscription_id), public.plan_version_snapshot(v_version.id),
        jsonb_build_object('created_via', 'stripe_checkout'), v_checkout.created_by
      ) returning id into v_item_id;
    end if;

  elsif v_checkout.checkout_kind = 'one_time' then
    insert into public.one_time_purchases (
      company_id, product_id, plan_version_id, purchase_type, status, fiscal_period_id,
      price_excl_vat, currency, paid_at, access_starts_at, permanent_access, price_snapshot,
      metadata, created_by
    ) values (
      v_checkout.company_id, v_product.id, v_version.id,
      case when v_product.code = 'year_end' then 'year_end' else 'custom' end,
      'paid', v_checkout.fiscal_period_id, v_version.price_excl_vat, v_version.currency,
      now(), now(), false, public.plan_version_snapshot(v_version.id),
      jsonb_build_object('created_via', 'stripe_checkout', 'stripe_checkout_session_id', p_stripe_checkout_session_id),
      v_checkout.created_by
    ) on conflict (company_id, fiscal_period_id) where purchase_type = 'year_end'
      and status in ('pending_payment', 'paid', 'active', 'fulfilled') do nothing;
  else
    raise exception 'Okänd checkout-typ.' using errcode = '22023';
  end if;

  insert into public.billing_events (company_id, event_type, source_table, source_id, amount_excl_vat, currency, metadata)
  values (
    v_checkout.company_id, 'stripe.checkout.completed', 'billing_checkout_sessions', v_checkout.id,
    coalesce(p_amount_total_minor, round(v_checkout.amount_excl_vat * 100)) / 100.0,
    upper(coalesce(nullif(trim(p_currency), ''), v_checkout.currency)),
    jsonb_build_object('stripe_event_id', p_stripe_event_id, 'stripe_checkout_session_id', p_stripe_checkout_session_id)
  );
end;
$$;

create or replace function public.stripe_sync_subscription(
  p_stripe_event_id text,
  p_stripe_subscription_id text,
  p_stripe_customer_id text,
  p_stripe_status text,
  p_stripe_price_id text default null,
  p_current_period_start timestamptz default null,
  p_current_period_end timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_plan_version_id uuid;
  v_plan_id uuid;
  v_product_type text;
  v_company_id uuid;
begin
  perform public.require_service_role();

  v_status := case p_stripe_status
    when 'trialing' then 'trialing'
    when 'active' then 'active'
    when 'past_due' then 'past_due'
    when 'paused' then 'paused'
    when 'canceled' then 'cancelled'
    when 'unpaid' then 'cancelled'
    when 'incomplete_expired' then 'expired'
    when 'incomplete' then 'past_due'
    else 'paused'
  end;

  select pv.id, pv.plan_id, pr.product_type
  into v_plan_version_id, v_plan_id, v_product_type
  from public.platform_plan_versions pv
  join public.platform_price_plans pp on pp.id = pv.plan_id
  join public.platform_products pr on pr.id = pp.product_id
  where p_stripe_price_id is not null and pv.stripe_price_id = p_stripe_price_id
  limit 1;

  update public.company_billing_profiles
  set stripe_customer_id = coalesce(nullif(trim(p_stripe_customer_id), ''), stripe_customer_id), updated_at = now()
  where stripe_customer_id = p_stripe_customer_id;

  if v_product_type = 'subscription' then
    update public.company_subscriptions
    set
      status = v_status,
      plan_id = coalesce(v_plan_id, plan_id),
      plan_version_id = coalesce(v_plan_version_id, plan_version_id),
      current_period_start = coalesce(p_current_period_start, current_period_start),
      current_period_end = coalesce(p_current_period_end, current_period_end),
      cancelled_at = case when v_status in ('cancelled', 'expired') then coalesce(cancelled_at, now()) else null end,
      price_snapshot = case when v_plan_version_id is null then price_snapshot else public.plan_version_snapshot(v_plan_version_id) end,
      updated_at = now()
    where external_provider = 'stripe'
      and external_subscription_id = p_stripe_subscription_id
    returning company_id into v_company_id;
  elsif v_product_type = 'addon' then
    update public.company_subscription_items
    set
      status = v_status,
      plan_version_id = coalesce(v_plan_version_id, plan_version_id),
      current_period_start = coalesce(p_current_period_start, current_period_start),
      current_period_end = coalesce(p_current_period_end, current_period_end),
      cancelled_at = case when v_status in ('cancelled', 'expired') then coalesce(cancelled_at, now()) else null end,
      price_snapshot = case when v_plan_version_id is null then price_snapshot else public.plan_version_snapshot(v_plan_version_id) end,
      updated_at = now()
    where external_provider = 'stripe'
      and external_subscription_item_id = p_stripe_subscription_id
    returning company_id into v_company_id;
  end if;

  if v_company_id is not null then
    insert into public.billing_events (company_id, event_type, source_table, source_id, currency, metadata)
    values (
      v_company_id, 'stripe.subscription.' || v_status, 'company_subscriptions', null, 'SEK',
      jsonb_build_object('stripe_event_id', p_stripe_event_id, 'stripe_subscription_id', p_stripe_subscription_id)
    );
  end if;
end;
$$;

create or replace function public.stripe_mark_checkout_expired(
  p_stripe_event_id text,
  p_stripe_checkout_session_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_checkout_id uuid;
begin
  perform public.require_service_role();
  update public.billing_checkout_sessions
  set status = 'expired', updated_at = now()
  where stripe_checkout_session_id = p_stripe_checkout_session_id
    and status in ('created', 'open')
  returning id, company_id into v_checkout_id, v_company_id;

  if v_company_id is not null then
    insert into public.billing_events (company_id, event_type, source_table, source_id, currency, metadata)
    values (v_company_id, 'stripe.checkout.expired', 'billing_checkout_sessions', v_checkout_id, 'SEK',
      jsonb_build_object('stripe_event_id', p_stripe_event_id, 'stripe_checkout_session_id', p_stripe_checkout_session_id));
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. RLS and audit coverage
-- -----------------------------------------------------------------------------
alter table public.company_billing_profiles enable row level security;
alter table public.billing_checkout_sessions enable row level security;
alter table public.stripe_webhook_events enable row level security;

drop policy if exists company_billing_profiles_select on public.company_billing_profiles;
create policy company_billing_profiles_select on public.company_billing_profiles
  for select using (public.user_can_manage_company_billing(company_id));
drop policy if exists company_billing_profiles_platform_write on public.company_billing_profiles;
create policy company_billing_profiles_platform_write on public.company_billing_profiles
  for all using (public.is_platform_admin()) with check (public.is_platform_admin());

drop policy if exists billing_checkout_sessions_select on public.billing_checkout_sessions;
create policy billing_checkout_sessions_select on public.billing_checkout_sessions
  for select using (public.user_can_manage_company_billing(company_id));
drop policy if exists billing_checkout_sessions_platform_write on public.billing_checkout_sessions;
create policy billing_checkout_sessions_platform_write on public.billing_checkout_sessions
  for all using (public.is_platform_admin()) with check (public.is_platform_admin());

drop policy if exists stripe_webhook_events_platform_select on public.stripe_webhook_events;
create policy stripe_webhook_events_platform_select on public.stripe_webhook_events
  for select using (public.is_platform_admin());
drop policy if exists stripe_webhook_events_platform_write on public.stripe_webhook_events;
create policy stripe_webhook_events_platform_write on public.stripe_webhook_events
  for all using (public.is_platform_admin()) with check (public.is_platform_admin());

-- Updated-at and immutable audit events cover external billing reconciliation.
do $$
declare
  t text;
begin
  foreach t in array array['company_billing_profiles', 'billing_checkout_sessions', 'stripe_webhook_events'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_updated_at', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.update_updated_at_column()', t || '_updated_at', t);
    execute format('drop trigger if exists %I on public.%I', t || '_audit', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.write_audit_log()', t || '_audit', t);
  end loop;
end $$;

revoke all on function public.user_can_manage_company_billing(uuid) from public;
revoke all on function public.require_service_role() from public;
revoke all on function public.platform_create_price_plan(uuid, text, text, text, text, text, integer, integer, integer) from public;
revoke all on function public.platform_update_price_plan_catalog(uuid, text, text, text, integer) from public;
revoke all on function public.platform_bind_stripe_price(uuid, text, text) from public;
revoke all on function public.platform_retire_price_plan_version(uuid) from public;
revoke all on function public.stripe_finalize_checkout(text, text, text, text, text, bigint, text) from public;
revoke all on function public.stripe_sync_subscription(text, text, text, text, text, timestamptz, timestamptz) from public;
revoke all on function public.stripe_mark_checkout_expired(text, text) from public;

grant execute on function public.user_can_manage_company_billing(uuid) to authenticated, service_role;
grant execute on function public.platform_create_price_plan(uuid, text, text, text, text, text, integer, integer, integer) to authenticated;
grant execute on function public.platform_update_price_plan_catalog(uuid, text, text, text, integer) to authenticated;
grant execute on function public.platform_bind_stripe_price(uuid, text, text) to authenticated;
grant execute on function public.platform_retire_price_plan_version(uuid) to authenticated;
grant execute on function public.stripe_finalize_checkout(text, text, text, text, text, bigint, text) to service_role;
grant execute on function public.stripe_sync_subscription(text, text, text, text, text, timestamptz, timestamptz) to service_role;
grant execute on function public.stripe_mark_checkout_expired(text, text) to service_role;

notify pgrst, 'reload schema';

-- -----------------------------------------------------------------------------
-- 4. Payment grace, invoice history and resilient Stripe lifecycle sync
-- -----------------------------------------------------------------------------
-- A past-due subscription remains usable only during its explicit, finite grace
-- window. The entitlement resolver remains database-enforced; a UI state alone
-- can never extend service access.
alter table public.platform_plan_versions
  add column if not exists grace_days integer not null default 7
  check (grace_days >= 0 and grace_days <= 90);

alter table public.company_subscriptions
  add column if not exists grace_ends_at timestamptz;
alter table public.company_subscription_items
  add column if not exists grace_ends_at timestamptz;

create index if not exists company_subscriptions_grace_idx
  on public.company_subscriptions(company_id, grace_ends_at)
  where status = 'past_due' and grace_ends_at is not null;
create index if not exists company_subscription_items_grace_idx
  on public.company_subscription_items(company_id, grace_ends_at)
  where status = 'past_due' and grace_ends_at is not null;

create or replace function public.platform_set_price_plan_version_grace_days(
  p_plan_version_id uuid,
  p_grace_days integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  perform public.require_platform_commercial_admin();
  if p_grace_days is null or p_grace_days < 0 or p_grace_days > 90 then
    raise exception 'Grace-perioden måste vara mellan 0 och 90 dagar.' using errcode = '22023';
  end if;

  select status into v_status
  from public.platform_plan_versions
  where id = p_plan_version_id
  for update;
  if not found then
    raise exception 'Planversionen finns inte.' using errcode = 'P0002';
  end if;
  if v_status <> 'draft' then
    raise exception 'Grace-perioden kan bara ändras i ett planutkast.' using errcode = '23514';
  end if;

  perform set_config('nordklart.commercial_mutation', 'on', true);
  update public.platform_plan_versions
  set grace_days = p_grace_days, updated_at = now()
  where id = p_plan_version_id;
end;
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
  ) or exists (
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
      case
        when csi.status = 'past_due' then coalesce(csi.grace_ends_at, cs.grace_ends_at)
        else coalesce(csi.current_period_end, cs.current_period_end, cs.trial_ends_at)
      end,
      pvf.limit_value,
      pvf.limit_unit
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

create or replace function public.stripe_sync_subscription(
  p_stripe_event_id text,
  p_stripe_subscription_id text,
  p_stripe_customer_id text,
  p_stripe_status text,
  p_stripe_price_id text default null,
  p_current_period_start timestamptz default null,
  p_current_period_end timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_plan_version_id uuid;
  v_plan_id uuid;
  v_product_type text;
  v_company_id uuid;
  v_grace_days integer := 7;
  v_source_table text := 'company_subscriptions';
begin
  perform public.require_service_role();

  v_status := case p_stripe_status
    when 'trialing' then 'trialing'
    when 'active' then 'active'
    when 'past_due' then 'past_due'
    when 'paused' then 'paused'
    when 'canceled' then 'cancelled'
    when 'unpaid' then 'cancelled'
    when 'incomplete_expired' then 'expired'
    when 'incomplete' then 'past_due'
    else 'paused'
  end;

  if nullif(trim(p_stripe_price_id), '') is not null then
    select pv.id, pv.plan_id, pr.product_type, pv.grace_days
    into v_plan_version_id, v_plan_id, v_product_type, v_grace_days
    from public.platform_plan_versions pv
    join public.platform_price_plans pp on pp.id = pv.plan_id
    join public.platform_products pr on pr.id = pp.product_id
    where pv.stripe_price_id = p_stripe_price_id
    limit 1;
  end if;

  if v_product_type is null then
    select cs.plan_version_id, cs.plan_id, pr.product_type, coalesce(pv.grace_days, 7), cs.company_id
    into v_plan_version_id, v_plan_id, v_product_type, v_grace_days, v_company_id
    from public.company_subscriptions cs
    join public.platform_price_plans pp on pp.id = cs.plan_id
    join public.platform_products pr on pr.id = pp.product_id
    left join public.platform_plan_versions pv on pv.id = cs.plan_version_id
    where cs.external_provider = 'stripe'
      and cs.external_subscription_id = p_stripe_subscription_id
    limit 1;
  end if;

  if v_product_type is null then
    select csi.plan_version_id, pv.plan_id, pr.product_type, coalesce(pv.grace_days, 7), csi.company_id
    into v_plan_version_id, v_plan_id, v_product_type, v_grace_days, v_company_id
    from public.company_subscription_items csi
    join public.platform_plan_versions pv on pv.id = csi.plan_version_id
    join public.platform_price_plans pp on pp.id = pv.plan_id
    join public.platform_products pr on pr.id = pp.product_id
    where csi.external_provider = 'stripe'
      and csi.external_subscription_item_id = p_stripe_subscription_id
    limit 1;
  end if;

  if v_product_type = 'subscription' then
    update public.company_subscriptions
    set
      status = v_status,
      plan_id = coalesce(v_plan_id, plan_id),
      plan_version_id = coalesce(v_plan_version_id, plan_version_id),
      current_period_start = coalesce(p_current_period_start, current_period_start),
      current_period_end = coalesce(p_current_period_end, current_period_end),
      grace_ends_at = case
        when v_status = 'past_due' then coalesce(grace_ends_at, now() + make_interval(days => coalesce(v_grace_days, 7)))
        else null
      end,
      cancelled_at = case when v_status in ('cancelled', 'expired') then coalesce(cancelled_at, now()) else null end,
      price_snapshot = case when v_plan_version_id is null then price_snapshot else public.plan_version_snapshot(v_plan_version_id) end,
      updated_at = now()
    where external_provider = 'stripe'
      and external_subscription_id = p_stripe_subscription_id
    returning company_id into v_company_id;
  elsif v_product_type = 'addon' then
    v_source_table := 'company_subscription_items';
    update public.company_subscription_items
    set
      status = v_status,
      plan_version_id = coalesce(v_plan_version_id, plan_version_id),
      current_period_start = coalesce(p_current_period_start, current_period_start),
      current_period_end = coalesce(p_current_period_end, current_period_end),
      grace_ends_at = case
        when v_status = 'past_due' then coalesce(grace_ends_at, now() + make_interval(days => coalesce(v_grace_days, 7)))
        else null
      end,
      cancelled_at = case when v_status in ('cancelled', 'expired') then coalesce(cancelled_at, now()) else null end,
      price_snapshot = case when v_plan_version_id is null then price_snapshot else public.plan_version_snapshot(v_plan_version_id) end,
      updated_at = now()
    where external_provider = 'stripe'
      and external_subscription_item_id = p_stripe_subscription_id
    returning company_id into v_company_id;
  end if;

  if v_company_id is not null then
    insert into public.company_billing_profiles (company_id, stripe_customer_id)
    values (v_company_id, nullif(trim(p_stripe_customer_id), ''))
    on conflict (company_id) do update set
      stripe_customer_id = coalesce(excluded.stripe_customer_id, company_billing_profiles.stripe_customer_id),
      updated_at = now();

    insert into public.billing_events (company_id, event_type, source_table, source_id, currency, metadata)
    values (
      v_company_id, 'stripe.subscription.' || v_status, v_source_table, null, 'SEK',
      jsonb_build_object('stripe_event_id', p_stripe_event_id, 'stripe_subscription_id', p_stripe_subscription_id)
    );
  end if;
end;
$$;

create or replace function public.stripe_record_invoice_event(
  p_stripe_event_id text,
  p_stripe_invoice_id text,
  p_stripe_customer_id text,
  p_stripe_subscription_id text default null,
  p_invoice_status text default null,
  p_amount_paid_minor bigint default null,
  p_currency text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
begin
  perform public.require_service_role();

  select cs.company_id into v_company_id
  from public.company_subscriptions cs
  where cs.external_provider = 'stripe'
    and cs.external_subscription_id = p_stripe_subscription_id
  limit 1;

  if v_company_id is null then
    select c.company_id into v_company_id
    from public.company_billing_profiles c
    where c.stripe_customer_id = p_stripe_customer_id
    limit 1;
  end if;

  if v_company_id is null then
    return;
  end if;

  insert into public.billing_events (company_id, event_type, source_table, source_id, amount_excl_vat, currency, metadata)
  values (
    v_company_id,
    'stripe.invoice.' || coalesce(nullif(trim(p_invoice_status), ''), 'updated'),
    'stripe_invoice',
    null,
    case when p_amount_paid_minor is null then null else p_amount_paid_minor / 100.0 end,
    upper(coalesce(nullif(trim(p_currency), ''), 'SEK')),
    jsonb_build_object(
      'stripe_event_id', p_stripe_event_id,
      'stripe_invoice_id', p_stripe_invoice_id,
      'stripe_subscription_id', p_stripe_subscription_id
    )
  );
end;
$$;

revoke all on function public.platform_set_price_plan_version_grace_days(uuid, integer) from public;
revoke all on function public.stripe_record_invoice_event(text, text, text, text, text, bigint, text) from public;
grant execute on function public.platform_set_price_plan_version_grace_days(uuid, integer) to authenticated;
grant execute on function public.stripe_record_invoice_event(text, text, text, text, text, bigint, text) to service_role;

notify pgrst, 'reload schema';

create or replace function public.company_effective_feature_access(p_company_id uuid)
returns table (
  feature_code text,
  feature_name text,
  category text,
  allowed boolean,
  reason text,
  source_type text,
  source_id uuid,
  expires_at timestamptz,
  limit_value numeric,
  limit_unit text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    pf.code,
    pf.name,
    pf.category,
    access.allowed,
    access.reason,
    access.source_type,
    access.source_id,
    access.expires_at,
    access.limit_value,
    access.limit_unit
  from public.platform_features pf
  cross join lateral public.company_feature_access(p_company_id, pf.code) access
  where public.user_can_access_company_v2(p_company_id)
  order by pf.category, pf.code;
$$;

revoke all on function public.company_effective_feature_access(uuid) from public;
grant execute on function public.company_effective_feature_access(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';

-- Scheduled prices become active only through this service-role function. A
-- cron route calls it regularly; normal tenant/admin sessions cannot promote
-- a future price by changing the client clock or calling a public endpoint.
create or replace function public.platform_activate_due_price_plan_versions()
returns table (activated_count integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version record;
  v_count integer := 0;
begin
  perform public.require_service_role();
  perform set_config('nordklart.commercial_mutation', 'on', true);

  for v_version in
    select distinct on (pv.plan_id)
      pv.id,
      pv.plan_id,
      pv.effective_from
    from public.platform_plan_versions pv
    where pv.status = 'scheduled'
      and pv.effective_from <= now()
    order by pv.plan_id, pv.effective_from desc, pv.version_number desc
  loop
    update public.platform_plan_versions
    set
      status = 'retired',
      effective_until = coalesce(effective_until, v_version.effective_from),
      updated_at = now()
    where plan_id = v_version.plan_id
      and status = 'active'
      and id <> v_version.id;

    update public.platform_plan_versions
    set
      status = 'retired',
      effective_until = coalesce(effective_until, v_version.effective_from),
      updated_at = now()
    where plan_id = v_version.plan_id
      and status = 'scheduled'
      and effective_from <= now()
      and id <> v_version.id;

    update public.platform_plan_versions
    set
      status = 'active',
      published_at = coalesce(published_at, now()),
      updated_at = now()
    where id = v_version.id;

    v_count := v_count + 1;
  end loop;

  return query select v_count;
end;
$$;

revoke all on function public.platform_activate_due_price_plan_versions() from public;
grant execute on function public.platform_activate_due_price_plan_versions() to service_role;

notify pgrst, 'reload schema';
