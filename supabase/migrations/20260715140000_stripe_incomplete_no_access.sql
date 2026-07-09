-- Deliberate handling of Stripe's `incomplete` subscription status.
--
-- `incomplete` means the FIRST payment has not succeeded yet (SCA pending or
-- initial charge failed). The previous mapping translated it to `past_due`,
-- which company_feature_access treats as access-with-grace — i.e. a customer
-- whose first payment never went through got up to 7 days of full product
-- access without ever paying.
--
-- New mapping: `incomplete` → `paused` (no feature access). When the payment
-- succeeds Stripe emits customer.subscription.updated with status `active`
-- and access opens normally; if it never succeeds, `incomplete_expired` →
-- `expired` as before. Genuine renewals that fail still map `past_due` →
-- grace, unchanged.
--
-- pg-test: covered-by tests/pg/billing-subscription-access.pg.test.ts

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
    when 'incomplete_expired' then 'expired' when 'incomplete' then 'paused' else 'paused' end;

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
