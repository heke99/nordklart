-- Billing robustness.
--
-- 1. Stripe does not deliver events in order. stripe_sync_subscription_v2
--    applied whatever arrived, so a late customer.subscription.updated
--    (past_due) could overwrite a newer active state and take away access
--    the customer paid for, and an event for a subscription that had no local
--    row yet updated nothing and was still marked processed.
--    stripe_sync_subscription_v3 records the Stripe event time per
--    subscription (and add-on item), ignores anything older than what was
--    already applied, and reports a missing local row so the webhook can let
--    Stripe retry.
-- 2. Two concurrent checkouts for different base plans could both complete
--    and bill the company twice. At most one open base-plan checkout per
--    company is now allowed.
-- 3. stripe_invoice_records.status was last-write-wins, so a late
--    invoice.finalized could turn a paid invoice back into open.
--
-- pg-test: tests/pg/billing-event-ordering.pg.test.ts

-- ---------------------------------------------------------------------------
-- 1. Event ordering
-- ---------------------------------------------------------------------------
alter table public.company_subscriptions
  add column if not exists last_stripe_event_at timestamptz;
alter table public.company_subscription_items
  add column if not exists last_stripe_event_at timestamptz;

comment on column public.company_subscriptions.last_stripe_event_at is
  'Created time of the newest Stripe subscription event applied; older events are ignored.';
comment on column public.company_subscription_items.last_stripe_event_at is
  'Created time of the newest Stripe subscription event applied; older events are ignored.';

create or replace function public.stripe_sync_subscription_v3(
  p_stripe_event_id text,
  p_event_created_at timestamptz,
  p_stripe_subscription_id text,
  p_stripe_customer_id text,
  p_stripe_status text,
  p_stripe_price_id text default null,
  p_current_period_start timestamptz default null,
  p_current_period_end timestamptz default null,
  p_cancel_at_period_end boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sub_id uuid;
  v_sub_last timestamptz;
  v_item_id uuid;
  v_item_last timestamptz;
begin
  perform public.require_service_role();

  select cs.id, cs.last_stripe_event_at into v_sub_id, v_sub_last
    from public.company_subscriptions cs
   where cs.external_provider = 'stripe' and cs.external_subscription_id = p_stripe_subscription_id
   for update;

  if v_sub_id is null then
    select csi.id, csi.last_stripe_event_at into v_item_id, v_item_last
      from public.company_subscription_items csi
     where csi.external_provider = 'stripe' and csi.external_subscription_item_id = p_stripe_subscription_id
     for update;
  end if;

  if v_sub_id is null and v_item_id is null then
    return jsonb_build_object('applied', false, 'reason', 'subscription_not_found');
  end if;

  if p_event_created_at is not null
     and coalesce(v_sub_last, v_item_last) is not null
     and coalesce(v_sub_last, v_item_last) > p_event_created_at then
    return jsonb_build_object('applied', false, 'reason', 'stale_event');
  end if;

  perform public.stripe_sync_subscription_v2(
    p_stripe_event_id, p_stripe_subscription_id, p_stripe_customer_id, p_stripe_status,
    p_stripe_price_id, p_current_period_start, p_current_period_end, p_cancel_at_period_end
  );

  if p_event_created_at is not null then
    if v_sub_id is not null then
      update public.company_subscriptions
         set last_stripe_event_at = greatest(coalesce(last_stripe_event_at, p_event_created_at), p_event_created_at)
       where id = v_sub_id;
    else
      update public.company_subscription_items
         set last_stripe_event_at = greatest(coalesce(last_stripe_event_at, p_event_created_at), p_event_created_at)
       where id = v_item_id;
    end if;
  end if;

  return jsonb_build_object('applied', true);
end;
$$;

revoke all on function public.stripe_sync_subscription_v3(text, timestamptz, text, text, text, text, timestamptz, timestamptz, boolean)
  from public, anon, authenticated;
grant execute on function public.stripe_sync_subscription_v3(text, timestamptz, text, text, text, text, timestamptz, timestamptz, boolean)
  to service_role;

-- ---------------------------------------------------------------------------
-- 2. One open base-plan checkout per company
-- ---------------------------------------------------------------------------
-- Older duplicates (if any) are superseded by the newest one.
with ranked as (
  select id, row_number() over (partition by company_id order by created_at desc, id desc) as rn
    from public.billing_checkout_sessions
   where checkout_kind = 'subscription' and status in ('created', 'open')
)
update public.billing_checkout_sessions b
   set status = 'expired', updated_at = now()
  from ranked r
 where r.id = b.id and r.rn > 1;

create unique index if not exists billing_checkout_sessions_one_open_base_idx
  on public.billing_checkout_sessions (company_id)
  where checkout_kind = 'subscription' and status in ('created', 'open');

-- ---------------------------------------------------------------------------
-- 3. Invoice status never moves backwards
-- ---------------------------------------------------------------------------
create or replace function public.stripe_invoice_status_forward_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- A settled invoice stays settled; later draft/open events are late copies.
  if old.status in ('paid', 'void', 'uncollectible')
     and new.status is distinct from old.status
     and coalesce(new.status, '') in ('', 'draft', 'open', 'finalized', 'created', 'updated') then
    new.status := old.status;
  end if;
  return new;
end;
$$;

revoke all on function public.stripe_invoice_status_forward_only() from public, anon, authenticated;

drop trigger if exists stripe_invoice_status_forward_only on public.stripe_invoice_records;
create trigger stripe_invoice_status_forward_only
  before update of status on public.stripe_invoice_records
  for each row execute function public.stripe_invoice_status_forward_only();
