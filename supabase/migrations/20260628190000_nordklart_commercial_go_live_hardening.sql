-- Nordklart commercial go-live hardening.
-- Completes VAT/tax evidence, controlled subscription changes, platform role
-- administration and server-side commercial guards without weakening the
-- phase 1-2 entitlement source of truth.

-- -----------------------------------------------------------------------------
-- 1. Tax configuration and invoice-quality Stripe evidence
-- -----------------------------------------------------------------------------
alter table public.platform_products
  add column if not exists stripe_tax_code text,
  add column if not exists stripe_tax_behavior text not null default 'exclusive'
    check (stripe_tax_behavior in ('exclusive', 'inclusive'));

alter table public.platform_plan_versions
  add column if not exists stripe_tax_behavior text not null default 'exclusive'
    check (stripe_tax_behavior in ('exclusive', 'inclusive'));

alter table public.billing_checkout_sessions
  add column if not exists amount_tax numeric(12,2),
  add column if not exists amount_incl_vat numeric(12,2),
  add column if not exists tax_mode text not null default 'automatic'
    check (tax_mode in ('automatic', 'manual')),
  add column if not exists stripe_invoice_id text;

create table if not exists public.stripe_invoice_records (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  stripe_invoice_id text not null unique,
  stripe_customer_id text,
  stripe_subscription_id text,
  status text,
  currency text not null default 'SEK',
  amount_excl_vat numeric(12,2),
  tax_amount numeric(12,2),
  amount_incl_vat numeric(12,2),
  hosted_invoice_url text,
  invoice_pdf_url text,
  invoice_date timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists stripe_invoice_records_company_date_idx
  on public.stripe_invoice_records(company_id, invoice_date desc nulls last, created_at desc);

-- Persist tax data as a commercial snapshot. Existing rows intentionally retain
-- their original history; only active Stripe prices are governed going forward.
update public.platform_plan_versions pv
set stripe_tax_behavior = coalesce(pr.stripe_tax_behavior, 'exclusive')
from public.platform_price_plans pp
join public.platform_products pr on pr.id = pp.product_id
where pp.id = pv.plan_id
  and (pv.stripe_tax_behavior is null or pv.stripe_tax_behavior not in ('exclusive', 'inclusive'));

-- -----------------------------------------------------------------------------
-- 2. Controlled plan changes and cancellation requests
-- -----------------------------------------------------------------------------
alter table public.company_subscriptions
  add column if not exists cancel_at_period_end boolean not null default false;
alter table public.company_subscription_items
  add column if not exists cancel_at_period_end boolean not null default false;

create table if not exists public.company_subscription_change_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  subscription_id uuid not null references public.company_subscriptions(id) on delete cascade,
  request_type text not null check (request_type in ('change_plan', 'cancel_subscription')),
  target_plan_version_id uuid references public.platform_plan_versions(id) on delete restrict,
  status text not null default 'requested'
    check (status in ('requested', 'approved', 'rejected', 'processing', 'scheduled', 'applied', 'cancelled', 'failed')),
  requested_by uuid references auth.users(id) on delete set null,
  requested_at timestamptz not null default now(),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  processed_at timestamptz,
  effective_at timestamptz,
  failure_reason text,
  customer_note text,
  internal_note text,
  stripe_operation_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint company_subscription_change_requests_target_check check (
    (request_type = 'change_plan' and target_plan_version_id is not null)
    or (request_type = 'cancel_subscription' and target_plan_version_id is null)
  )
);

create unique index if not exists company_subscription_change_requests_open_unique_idx
  on public.company_subscription_change_requests(subscription_id)
  where status in ('requested', 'approved', 'processing', 'scheduled');
create index if not exists company_subscription_change_requests_company_idx
  on public.company_subscription_change_requests(company_id, status, created_at desc);

-- -----------------------------------------------------------------------------
-- 3. Commercial RPCs: tax catalogue, customer request and superadmin review
-- -----------------------------------------------------------------------------
create or replace function public.platform_set_product_tax_settings(
  p_product_id uuid,
  p_stripe_tax_code text,
  p_stripe_tax_behavior text default 'exclusive'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_platform_commercial_admin();

  if nullif(trim(p_stripe_tax_code), '') is null then
    raise exception 'Stripe Tax-kod krävs. Lämna inte momsbehandlingen odefinierad.' using errcode = '22023';
  end if;
  if p_stripe_tax_behavior not in ('exclusive', 'inclusive') then
    raise exception 'Momsbehandling måste vara exclusive eller inclusive.' using errcode = '22023';
  end if;

  perform set_config('nordklart.commercial_mutation', 'on', true);
  update public.platform_products
  set
    stripe_tax_code = trim(p_stripe_tax_code),
    stripe_tax_behavior = p_stripe_tax_behavior,
    updated_at = now()
  where id = p_product_id;

  if not found then
    raise exception 'Produkten finns inte.' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.company_request_subscription_change(
  p_subscription_id uuid,
  p_request_type text,
  p_target_plan_version_id uuid default null,
  p_customer_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_subscription public.company_subscriptions%rowtype;
  v_target_product_type text;
  v_request_id uuid;
begin
  select * into v_subscription
  from public.company_subscriptions
  where id = p_subscription_id
  for update;

  if not found then
    raise exception 'Abonnemanget finns inte.' using errcode = 'P0002';
  end if;
  if not public.user_can_manage_company_billing(v_subscription.company_id) then
    raise exception 'Endast företagets ägare eller administratör kan begära abonnemangsändringar.' using errcode = '42501';
  end if;
  if v_subscription.status not in ('trialing', 'active', 'past_due', 'paused') then
    raise exception 'Det här abonnemanget kan inte ändras i sitt nuvarande läge.' using errcode = '23514';
  end if;
  if v_subscription.cancel_at_period_end and p_request_type <> 'cancel_subscription' then
    raise exception 'Abonnemanget är redan planerat att avslutas.' using errcode = '23514';
  end if;
  if p_request_type not in ('change_plan', 'cancel_subscription') then
    raise exception 'Okänd abonnemangsändring.' using errcode = '22023';
  end if;

  if p_request_type = 'change_plan' then
    if p_target_plan_version_id is null or p_target_plan_version_id = v_subscription.plan_version_id then
      raise exception 'Välj en annan aktiv abonnemangsversion.' using errcode = '22023';
    end if;

    select pr.product_type into v_target_product_type
    from public.platform_plan_versions pv
    join public.platform_price_plans pp on pp.id = pv.plan_id
    join public.platform_products pr on pr.id = pp.product_id
    where pv.id = p_target_plan_version_id
      and pv.status = 'active'
      and pp.status = 'active'
      and pr.status = 'active';

    if v_target_product_type is distinct from 'subscription' then
      raise exception 'Den valda versionen är inte en aktiv basplan.' using errcode = '23514';
    end if;
  elsif p_target_plan_version_id is not null then
    raise exception 'En uppsägning får inte innehålla en målplan.' using errcode = '22023';
  end if;

  insert into public.company_subscription_change_requests (
    company_id, subscription_id, request_type, target_plan_version_id,
    requested_by, customer_note
  ) values (
    v_subscription.company_id, v_subscription.id, p_request_type,
    p_target_plan_version_id, auth.uid(), nullif(trim(p_customer_note), '')
  ) returning id into v_request_id;

  return v_request_id;
end;
$$;

create or replace function public.platform_mark_subscription_change_request(
  p_request_id uuid,
  p_status text,
  p_internal_note text default null,
  p_failure_reason text default null,
  p_stripe_operation_id text default null,
  p_effective_at timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_platform_commercial_admin();
  if p_status not in ('approved', 'rejected', 'processing', 'scheduled', 'applied', 'cancelled', 'failed') then
    raise exception 'Otillåten status för abonnemangsändringen.' using errcode = '22023';
  end if;

  update public.company_subscription_change_requests
  set
    status = p_status,
    reviewed_by = case when p_status in ('approved', 'rejected', 'processing', 'scheduled', 'applied', 'cancelled', 'failed') then auth.uid() else reviewed_by end,
    reviewed_at = case when p_status in ('approved', 'rejected', 'processing', 'scheduled', 'applied', 'cancelled', 'failed') then coalesce(reviewed_at, now()) else reviewed_at end,
    processed_at = case when p_status in ('scheduled', 'applied', 'cancelled', 'failed') then now() else processed_at end,
    effective_at = coalesce(p_effective_at, effective_at),
    internal_note = coalesce(nullif(trim(p_internal_note), ''), internal_note),
    failure_reason = case when p_failure_reason is null then failure_reason else nullif(trim(p_failure_reason), '') end,
    stripe_operation_id = coalesce(nullif(trim(p_stripe_operation_id), ''), stripe_operation_id),
    updated_at = now()
  where id = p_request_id;

  if not found then
    raise exception 'Ändringsbegäran finns inte.' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.platform_set_subscription_cancellation_state(
  p_subscription_id uuid,
  p_cancel_at_period_end boolean,
  p_effective_at timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_platform_commercial_admin();
  perform set_config('nordklart.commercial_mutation', 'on', true);

  update public.company_subscriptions
  set
    cancel_at_period_end = p_cancel_at_period_end,
    cancelled_at = case when p_cancel_at_period_end then coalesce(p_effective_at, current_period_end, cancelled_at) else null end,
    updated_at = now()
  where id = p_subscription_id;

  if not found then
    raise exception 'Abonnemanget finns inte.' using errcode = 'P0002';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Platform role administration: one explicit global role per user
-- -----------------------------------------------------------------------------
create or replace function public.platform_set_user_role(
  p_user_id uuid,
  p_role text,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing_role text;
  v_active_admins integer;
begin
  perform public.require_platform_commercial_admin();
  if p_role not in ('platform_admin', 'platform_support', 'platform_auditor') then
    raise exception 'Ogiltig plattformsroll.' using errcode = '22023';
  end if;
  select role into v_existing_role from public.platform_roles where user_id = p_user_id and revoked_at is null for update;
  if v_existing_role = 'platform_admin' and p_role <> 'platform_admin' then
    select count(*) into v_active_admins from public.platform_roles where role = 'platform_admin' and revoked_at is null;
    if v_active_admins <= 1 then
      raise exception 'Det går inte att ändra den sista aktiva superadminrollen.' using errcode = '23514';
    end if;
  end if;
  if not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'Användaren finns inte.' using errcode = 'P0002';
  end if;

  insert into public.platform_roles (user_id, role, granted_by, granted_at, revoked_at, note)
  values (p_user_id, p_role, auth.uid(), now(), null, nullif(trim(p_note), ''))
  on conflict (user_id) do update set
    role = excluded.role,
    granted_by = auth.uid(),
    granted_at = now(),
    revoked_at = null,
    note = excluded.note;
end;
$$;

create or replace function public.platform_revoke_user_role(
  p_user_id uuid,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_role text;
  v_active_admins integer;
begin
  perform public.require_platform_commercial_admin();

  select role into v_target_role
  from public.platform_roles
  where user_id = p_user_id and revoked_at is null
  for update;
  if not found then return; end if;

  if v_target_role = 'platform_admin' then
    select count(*) into v_active_admins
    from public.platform_roles
    where role = 'platform_admin' and revoked_at is null;
    if v_active_admins <= 1 then
      raise exception 'Det går inte att återkalla den sista aktiva superadminrollen.' using errcode = '23514';
    end if;
  end if;

  update public.platform_roles
  set revoked_at = now(), note = coalesce(nullif(trim(p_note), ''), note)
  where user_id = p_user_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Service-role webhook finalizers with tax evidence and cancellation state
-- -----------------------------------------------------------------------------
create or replace function public.stripe_finalize_checkout_v2(
  p_stripe_event_id text,
  p_stripe_checkout_session_id text,
  p_stripe_customer_id text,
  p_stripe_subscription_id text default null,
  p_payment_status text default null,
  p_amount_subtotal_minor bigint default null,
  p_amount_tax_minor bigint default null,
  p_amount_total_minor bigint default null,
  p_currency text default null,
  p_stripe_invoice_id text default null
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
  v_amount_excl numeric(12,2);
  v_tax numeric(12,2);
  v_total numeric(12,2);
begin
  perform public.require_service_role();
  select * into v_checkout from public.billing_checkout_sessions
  where stripe_checkout_session_id = p_stripe_checkout_session_id for update;
  if not found then raise exception 'Checkout-session saknas i Nordklart.' using errcode = 'P0002'; end if;
  if v_checkout.status = 'completed' then return; end if;

  v_amount_excl := coalesce(p_amount_subtotal_minor::numeric / 100, v_checkout.amount_excl_vat);
  v_tax := case when p_amount_tax_minor is null then null else p_amount_tax_minor::numeric / 100 end;
  v_total := coalesce(p_amount_total_minor::numeric / 100, v_amount_excl + coalesce(v_tax, 0));

  update public.billing_checkout_sessions set
    stripe_customer_id = coalesce(nullif(trim(p_stripe_customer_id), ''), stripe_customer_id),
    stripe_subscription_id = coalesce(nullif(trim(p_stripe_subscription_id), ''), stripe_subscription_id),
    stripe_invoice_id = coalesce(nullif(trim(p_stripe_invoice_id), ''), stripe_invoice_id),
    amount_excl_vat = v_amount_excl,
    amount_tax = v_tax,
    amount_incl_vat = v_total,
    status = case when coalesce(p_payment_status, '') in ('paid', 'no_payment_required') then 'completed' else 'open' end,
    completed_at = case when coalesce(p_payment_status, '') in ('paid', 'no_payment_required') then now() else null end,
    updated_at = now()
  where id = v_checkout.id returning * into v_checkout;

  if coalesce(p_payment_status, '') not in ('paid', 'no_payment_required') then return; end if;

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
    from public.platform_price_plans pp join public.platform_products pr on pr.id = pp.product_id
    where cs.company_id = v_checkout.company_id
      and cs.plan_id = pp.id and pr.product_type = 'subscription'
      and cs.status in ('trialing', 'active', 'past_due', 'paused');

    insert into public.company_subscriptions (
      company_id, plan_id, plan_version_id, status, starts_at, current_period_start,
      external_provider, external_subscription_id, created_by, price_snapshot, override_note, cancel_at_period_end
    ) values (
      v_checkout.company_id, v_version.plan_id, v_version.id, 'active', now(), now(),
      'stripe', trim(p_stripe_subscription_id), v_checkout.created_by,
      public.plan_version_snapshot(v_version.id), 'Stripe Checkout', false
    ) returning id into v_subscription_id;
  elsif v_checkout.checkout_kind = 'addon' then
    if nullif(trim(p_stripe_subscription_id), '') is null then
      raise exception 'Stripe skickade inget abonnemangs-id för tillägget.' using errcode = '23514';
    end if;
    if v_checkout.parent_subscription_id is null or not exists (
      select 1 from public.company_subscriptions cs where cs.id = v_checkout.parent_subscription_id and cs.company_id = v_checkout.company_id
    ) then raise exception 'Tillägget saknar ett giltigt basabonnemang.' using errcode = '23514'; end if;

    select id into v_item_id from public.company_subscription_items
    where subscription_id = v_checkout.parent_subscription_id and plan_version_id = v_version.id
      and item_type = 'addon' and external_provider = 'stripe'
      and external_subscription_item_id = trim(p_stripe_subscription_id) limit 1;
    if v_item_id is null then
      insert into public.company_subscription_items (
        subscription_id, company_id, plan_version_id, item_type, status, quantity,
        starts_at, current_period_start, external_provider, external_subscription_item_id,
        price_snapshot, metadata, created_by, cancel_at_period_end
      ) values (
        v_checkout.parent_subscription_id, v_checkout.company_id, v_version.id, 'addon', 'active', 1,
        now(), now(), 'stripe', trim(p_stripe_subscription_id), public.plan_version_snapshot(v_version.id),
        jsonb_build_object('created_via', 'stripe_checkout'), v_checkout.created_by, false
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
      'paid', v_checkout.fiscal_period_id, v_amount_excl, v_version.currency,
      now(), now(), false, public.plan_version_snapshot(v_version.id),
      jsonb_build_object('created_via', 'stripe_checkout', 'stripe_checkout_session_id', p_stripe_checkout_session_id,
        'tax_amount', v_tax, 'amount_incl_vat', v_total), v_checkout.created_by
    ) on conflict (company_id, fiscal_period_id) where purchase_type = 'year_end'
      and status in ('pending_payment', 'paid', 'active', 'fulfilled') do nothing;
  else
    raise exception 'Okänd checkout-typ.' using errcode = '22023';
  end if;

  insert into public.billing_events (company_id, event_type, source_table, source_id, amount_excl_vat, currency, metadata)
  values (v_checkout.company_id, 'stripe.checkout.completed', 'billing_checkout_sessions', v_checkout.id,
    v_amount_excl, upper(coalesce(nullif(trim(p_currency), ''), v_checkout.currency)),
    jsonb_build_object('stripe_event_id', p_stripe_event_id, 'stripe_checkout_session_id', p_stripe_checkout_session_id,
      'stripe_invoice_id', p_stripe_invoice_id, 'tax_amount', v_tax, 'amount_incl_vat', v_total));
end;
$$;

create or replace function public.stripe_sync_subscription_v2(
  p_stripe_event_id text,
  p_stripe_subscription_id text,
  p_stripe_customer_id text,
  p_stripe_status text,
  p_stripe_price_id text default null,
  p_current_period_start timestamptz default null,
  p_current_period_end timestamptz default null,
  p_cancel_at_period_end boolean default false
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
  v_internal_subscription_id uuid;
  v_grace_days integer := 7;
  v_source_table text := 'company_subscriptions';
begin
  perform public.require_service_role();
  v_status := case p_stripe_status
    when 'trialing' then 'trialing' when 'active' then 'active' when 'past_due' then 'past_due'
    when 'paused' then 'paused' when 'canceled' then 'cancelled' when 'unpaid' then 'cancelled'
    when 'incomplete_expired' then 'expired' when 'incomplete' then 'past_due' else 'paused' end;

  if nullif(trim(p_stripe_price_id), '') is not null then
    select pv.id, pv.plan_id, pr.product_type, pv.grace_days into v_plan_version_id, v_plan_id, v_product_type, v_grace_days
    from public.platform_plan_versions pv join public.platform_price_plans pp on pp.id = pv.plan_id
    join public.platform_products pr on pr.id = pp.product_id where pv.stripe_price_id = p_stripe_price_id limit 1;
  end if;
  if v_product_type is null then
    select cs.plan_version_id, cs.plan_id, pr.product_type, coalesce(pv.grace_days, 7), cs.company_id
    into v_plan_version_id, v_plan_id, v_product_type, v_grace_days, v_company_id
    from public.company_subscriptions cs join public.platform_price_plans pp on pp.id = cs.plan_id
    join public.platform_products pr on pr.id = pp.product_id left join public.platform_plan_versions pv on pv.id = cs.plan_version_id
    where cs.external_provider = 'stripe' and cs.external_subscription_id = p_stripe_subscription_id limit 1;
  end if;
  if v_product_type is null then
    select csi.plan_version_id, pv.plan_id, pr.product_type, coalesce(pv.grace_days, 7), csi.company_id
    into v_plan_version_id, v_plan_id, v_product_type, v_grace_days, v_company_id
    from public.company_subscription_items csi join public.platform_plan_versions pv on pv.id = csi.plan_version_id
    join public.platform_price_plans pp on pp.id = pv.plan_id join public.platform_products pr on pr.id = pp.product_id
    where csi.external_provider = 'stripe' and csi.external_subscription_item_id = p_stripe_subscription_id limit 1;
  end if;

  if v_product_type = 'subscription' then
    update public.company_subscriptions set
      status = v_status, plan_id = coalesce(v_plan_id, plan_id), plan_version_id = coalesce(v_plan_version_id, plan_version_id),
      current_period_start = coalesce(p_current_period_start, current_period_start), current_period_end = coalesce(p_current_period_end, current_period_end),
      cancel_at_period_end = coalesce(p_cancel_at_period_end, false),
      grace_ends_at = case when v_status = 'past_due' then coalesce(grace_ends_at, now() + make_interval(days => coalesce(v_grace_days, 7))) else null end,
      cancelled_at = case when v_status in ('cancelled', 'expired') then coalesce(cancelled_at, now()) when p_cancel_at_period_end then coalesce(p_current_period_end, current_period_end, cancelled_at) else null end,
      price_snapshot = case when v_plan_version_id is null then price_snapshot else public.plan_version_snapshot(v_plan_version_id) end,
      updated_at = now()
    where external_provider = 'stripe' and external_subscription_id = p_stripe_subscription_id returning id, company_id into v_internal_subscription_id, v_company_id;
  elsif v_product_type = 'addon' then
    v_source_table := 'company_subscription_items';
    update public.company_subscription_items set
      status = v_status, plan_version_id = coalesce(v_plan_version_id, plan_version_id),
      current_period_start = coalesce(p_current_period_start, current_period_start), current_period_end = coalesce(p_current_period_end, current_period_end),
      cancel_at_period_end = coalesce(p_cancel_at_period_end, false),
      grace_ends_at = case when v_status = 'past_due' then coalesce(grace_ends_at, now() + make_interval(days => coalesce(v_grace_days, 7))) else null end,
      cancelled_at = case when v_status in ('cancelled', 'expired') then coalesce(cancelled_at, now()) when p_cancel_at_period_end then coalesce(p_current_period_end, current_period_end, cancelled_at) else null end,
      price_snapshot = case when v_plan_version_id is null then price_snapshot else public.plan_version_snapshot(v_plan_version_id) end,
      updated_at = now()
    where external_provider = 'stripe' and external_subscription_item_id = p_stripe_subscription_id returning company_id into v_company_id;
  end if;

  if v_product_type = 'subscription' and v_internal_subscription_id is not null then
    update public.company_subscription_change_requests
    set
      status = case
        when request_type = 'cancel_subscription' and v_status in ('cancelled', 'expired') then 'applied'
        when request_type = 'change_plan' and target_plan_version_id = v_plan_version_id and v_status in ('trialing', 'active') then 'applied'
        else status
      end,
      processed_at = case
        when (request_type = 'cancel_subscription' and v_status in ('cancelled', 'expired'))
          or (request_type = 'change_plan' and target_plan_version_id = v_plan_version_id and v_status in ('trialing', 'active'))
        then now() else processed_at end,
      updated_at = now()
    where subscription_id = v_internal_subscription_id
      and status = 'scheduled';
  end if;

  if v_company_id is not null then
    insert into public.company_billing_profiles (company_id, stripe_customer_id) values (v_company_id, nullif(trim(p_stripe_customer_id), ''))
    on conflict (company_id) do update set stripe_customer_id = coalesce(excluded.stripe_customer_id, company_billing_profiles.stripe_customer_id), updated_at = now();
    insert into public.billing_events (company_id, event_type, source_table, source_id, currency, metadata)
    values (v_company_id, 'stripe.subscription.' || v_status, v_source_table, null, 'SEK',
      jsonb_build_object('stripe_event_id', p_stripe_event_id, 'stripe_subscription_id', p_stripe_subscription_id,
        'cancel_at_period_end', coalesce(p_cancel_at_period_end, false)));
  end if;
end;
$$;

create or replace function public.stripe_record_invoice_event_v2(
  p_stripe_event_id text,
  p_stripe_invoice_id text,
  p_stripe_customer_id text,
  p_stripe_subscription_id text default null,
  p_invoice_status text default null,
  p_amount_subtotal_minor bigint default null,
  p_amount_tax_minor bigint default null,
  p_amount_total_minor bigint default null,
  p_currency text default null,
  p_hosted_invoice_url text default null,
  p_invoice_pdf_url text default null,
  p_invoice_date timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_company_id uuid; begin
  perform public.require_service_role();
  select cs.company_id into v_company_id from public.company_subscriptions cs
  where cs.external_provider = 'stripe' and cs.external_subscription_id = p_stripe_subscription_id limit 1;
  if v_company_id is null then select c.company_id into v_company_id from public.company_billing_profiles c
    where c.stripe_customer_id = p_stripe_customer_id limit 1; end if;
  if v_company_id is null then return; end if;

  insert into public.stripe_invoice_records (
    company_id, stripe_invoice_id, stripe_customer_id, stripe_subscription_id, status, currency,
    amount_excl_vat, tax_amount, amount_incl_vat, hosted_invoice_url, invoice_pdf_url, invoice_date, metadata
  ) values (
    v_company_id, p_stripe_invoice_id, nullif(trim(p_stripe_customer_id), ''), nullif(trim(p_stripe_subscription_id), ''),
    nullif(trim(p_invoice_status), ''), upper(coalesce(nullif(trim(p_currency), ''), 'SEK')),
    case when p_amount_subtotal_minor is null then null else p_amount_subtotal_minor::numeric / 100 end,
    case when p_amount_tax_minor is null then null else p_amount_tax_minor::numeric / 100 end,
    case when p_amount_total_minor is null then null else p_amount_total_minor::numeric / 100 end,
    nullif(trim(p_hosted_invoice_url), ''), nullif(trim(p_invoice_pdf_url), ''), p_invoice_date,
    jsonb_build_object('last_stripe_event_id', p_stripe_event_id)
  ) on conflict (stripe_invoice_id) do update set
    status = excluded.status, amount_excl_vat = excluded.amount_excl_vat, tax_amount = excluded.tax_amount,
    amount_incl_vat = excluded.amount_incl_vat, hosted_invoice_url = excluded.hosted_invoice_url,
    invoice_pdf_url = excluded.invoice_pdf_url, invoice_date = excluded.invoice_date,
    metadata = stripe_invoice_records.metadata || excluded.metadata, updated_at = now();

  insert into public.billing_events (company_id, event_type, source_table, source_id, amount_excl_vat, currency, metadata)
  values (v_company_id, 'stripe.invoice.' || coalesce(nullif(trim(p_invoice_status), ''), 'updated'), 'stripe_invoice_records', null,
    case when p_amount_subtotal_minor is null then null else p_amount_subtotal_minor::numeric / 100 end,
    upper(coalesce(nullif(trim(p_currency), ''), 'SEK')),
    jsonb_build_object('stripe_event_id', p_stripe_event_id, 'stripe_invoice_id', p_stripe_invoice_id,
      'stripe_subscription_id', p_stripe_subscription_id,
      'tax_amount', case when p_amount_tax_minor is null then null else p_amount_tax_minor::numeric / 100 end,
      'amount_incl_vat', case when p_amount_total_minor is null then null else p_amount_total_minor::numeric / 100 end));
end; $$;

-- -----------------------------------------------------------------------------
-- 6. RLS, audit, grants and schema reload
-- -----------------------------------------------------------------------------
alter table public.stripe_invoice_records enable row level security;
alter table public.company_subscription_change_requests enable row level security;

drop policy if exists stripe_invoice_records_select on public.stripe_invoice_records;
create policy stripe_invoice_records_select on public.stripe_invoice_records
  for select using (public.user_can_manage_company_billing(company_id));
drop policy if exists stripe_invoice_records_platform_write on public.stripe_invoice_records;
create policy stripe_invoice_records_platform_write on public.stripe_invoice_records
  for all using (public.is_platform_admin()) with check (public.is_platform_admin());

drop policy if exists company_subscription_change_requests_select on public.company_subscription_change_requests;
create policy company_subscription_change_requests_select on public.company_subscription_change_requests
  for select using (public.user_can_manage_company_billing(company_id));
drop policy if exists company_subscription_change_requests_customer_insert on public.company_subscription_change_requests;
create policy company_subscription_change_requests_customer_insert on public.company_subscription_change_requests
  for insert with check (public.user_can_manage_company_billing(company_id) and requested_by = auth.uid());
drop policy if exists company_subscription_change_requests_platform_write on public.company_subscription_change_requests;
create policy company_subscription_change_requests_platform_write on public.company_subscription_change_requests
  for all using (public.is_platform_admin()) with check (public.is_platform_admin());

do $$
begin
  execute 'drop trigger if exists stripe_invoice_records_updated_at on public.stripe_invoice_records';
  execute 'create trigger stripe_invoice_records_updated_at before update on public.stripe_invoice_records for each row execute function public.update_updated_at_column()';
  execute 'drop trigger if exists stripe_invoice_records_audit on public.stripe_invoice_records';
  execute 'create trigger stripe_invoice_records_audit after insert or update or delete on public.stripe_invoice_records for each row execute function public.write_audit_log()';
  execute 'drop trigger if exists company_subscription_change_requests_updated_at on public.company_subscription_change_requests';
  execute 'create trigger company_subscription_change_requests_updated_at before update on public.company_subscription_change_requests for each row execute function public.update_updated_at_column()';
  execute 'drop trigger if exists company_subscription_change_requests_audit on public.company_subscription_change_requests';
  execute 'create trigger company_subscription_change_requests_audit after insert or update or delete on public.company_subscription_change_requests for each row execute function public.write_audit_log()';
end $$;

revoke all on function public.platform_set_product_tax_settings(uuid, text, text) from public;
revoke all on function public.company_request_subscription_change(uuid, text, uuid, text) from public;
revoke all on function public.platform_mark_subscription_change_request(uuid, text, text, text, text, timestamptz) from public;
revoke all on function public.platform_set_subscription_cancellation_state(uuid, boolean, timestamptz) from public;
revoke all on function public.platform_set_user_role(uuid, text, text) from public;
revoke all on function public.platform_revoke_user_role(uuid, text) from public;
revoke all on function public.stripe_finalize_checkout_v2(text, text, text, text, text, bigint, bigint, bigint, text, text) from public;
revoke all on function public.stripe_sync_subscription_v2(text, text, text, text, text, timestamptz, timestamptz, boolean) from public;
revoke all on function public.stripe_record_invoice_event_v2(text, text, text, text, text, bigint, bigint, bigint, text, text, text, timestamptz) from public;

grant execute on function public.platform_set_product_tax_settings(uuid, text, text) to authenticated;
grant execute on function public.company_request_subscription_change(uuid, text, uuid, text) to authenticated;
grant execute on function public.platform_mark_subscription_change_request(uuid, text, text, text, text, timestamptz) to authenticated;
grant execute on function public.platform_set_subscription_cancellation_state(uuid, boolean, timestamptz) to authenticated;
grant execute on function public.platform_set_user_role(uuid, text, text) to authenticated;
grant execute on function public.platform_revoke_user_role(uuid, text) to authenticated;
grant execute on function public.stripe_finalize_checkout_v2(text, text, text, text, text, bigint, bigint, bigint, text, text) to service_role;
grant execute on function public.stripe_sync_subscription_v2(text, text, text, text, text, timestamptz, timestamptz, boolean) to service_role;
grant execute on function public.stripe_record_invoice_event_v2(text, text, text, text, text, bigint, bigint, bigint, text, text, text, timestamptz) to service_role;

notify pgrst, 'reload schema';
