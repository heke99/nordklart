-- Database-owned historical open items, FX verification and durable year-end failures.
--
-- Security goals:
--   * the economic FX RPC is server-only;
--   * every invoice amount is reconstructed from locked company data in Postgres;
--   * journal lines, item amounts and snapshot keys are derived in Postgres;
--   * a client-balanced but manipulated payload is rejected;
--   * failed year-end attempts are persisted through a dedicated audited RPC.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. Richer year-end run diagnostics/state machine (forward-only).
-- ---------------------------------------------------------------------------
alter table public.year_end_runs
  add column if not exists current_step text,
  add column if not exists error_code text,
  add column if not exists technical_error text,
  add column if not exists user_message text,
  add column if not exists correlation_id text,
  add column if not exists retry_count integer not null default 0,
  add column if not exists last_retry_at timestamptz;

alter table public.year_end_runs
  drop constraint if exists year_end_runs_status_check;

alter table public.year_end_runs
  add constraint year_end_runs_status_check check (
    status in (
      'open', 'validating', 'closing', 'failed', 'recovery_required',
      'closed', 'reopening', 'reopened', 'superseded'
    )
  );

create index if not exists idx_year_end_runs_failure_recovery
  on public.year_end_runs (company_id, fiscal_period_id, status, created_at desc)
  where status in ('failed', 'recovery_required');

-- ---------------------------------------------------------------------------
-- 2. Canonical historical open-item reconstruction.
-- ---------------------------------------------------------------------------
create or replace function public.historical_open_items_at(
  p_company_id uuid,
  p_as_of_date date
)
returns table (
  source_type text,
  source_id uuid,
  reference text,
  currency text,
  exchange_rate numeric,
  invoice_date date,
  due_date date,
  customer_id uuid,
  supplier_id uuid,
  total numeric,
  open_amount numeric,
  current_status text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text := coalesce(auth.role(), current_user::text);
begin
  if p_company_id is null or p_as_of_date is null then
    raise exception 'HISTORICAL_OPEN_ITEMS_INVALID_ARGUMENT';
  end if;

  if auth.uid() is not null then
    if not exists (
      select 1 from public.resolve_company_access(p_company_id) a where a.can_read
    ) then
      raise exception 'FORBIDDEN: no read access to company' using errcode = '42501';
    end if;
  elsif v_role not in ('service_role', 'postgres') then
    raise exception 'FORBIDDEN: unauthenticated caller' using errcode = '42501';
  end if;

  return query
  with customer_payments as (
    select ip.invoice_id, round(sum(coalesce(ip.amount, 0)), 2) as amount
    from public.invoice_payments ip
    where ip.company_id = p_company_id
      and ip.payment_date <= p_as_of_date
    group by ip.invoice_id
  ),
  customer_credits as (
    select ci.credited_invoice_id as invoice_id,
           round(sum(abs(coalesce(ci.total, 0))), 2) as amount
    from public.invoices ci
    where ci.company_id = p_company_id
      and ci.credited_invoice_id is not null
      and ci.invoice_date <= p_as_of_date
      and ci.status not in ('draft', 'cancelled')
    group by ci.credited_invoice_id
  ),
  customer_adjustments as (
    select ipa.invoice_id,
      round(sum(
        case
          when ipa.adjustment_type in ('write_off', 'discount', 'rounding', 'credit_note_offset')
            then abs(coalesce(ipa.amount, 0))
          when ipa.adjustment_type = 'refund'
            then -abs(coalesce(ipa.amount, 0))
          else 0
        end
      ), 2) as amount
    from public.invoice_payment_adjustments ipa
    where ipa.company_id = p_company_id
      and ipa.adjustment_date <= p_as_of_date
      and ipa.status in ('posted', 'resolved')
    group by ipa.invoice_id
  ),
  customer_open as (
    select
      'invoice'::text as source_type,
      i.id as source_id,
      coalesce(nullif(i.invoice_number, ''), nullif(i.external_invoice_number, ''), i.id::text) as reference,
      coalesce(i.currency, 'SEK')::text as currency,
      i.exchange_rate,
      i.invoice_date,
      i.due_date,
      i.customer_id,
      null::uuid as supplier_id,
      round(coalesce(i.total, 0), 2) as total,
      case
        when i.written_off_at is not null and i.written_off_at::date <= p_as_of_date then 0::numeric
        else round(
          coalesce(i.total, 0)
          - coalesce(cp.amount, 0)
          - coalesce(cc.amount, 0)
          - coalesce(ca.amount, 0),
          2
        )
      end as open_amount,
      i.status::text as current_status
    from public.invoices i
    left join customer_payments cp on cp.invoice_id = i.id
    left join customer_credits cc on cc.invoice_id = i.id
    left join customer_adjustments ca on ca.invoice_id = i.id
    where i.company_id = p_company_id
      and i.invoice_date <= p_as_of_date
      and i.credited_invoice_id is null
      and i.status not in ('draft', 'cancelled')
  ),
  supplier_payments as (
    select sip.supplier_invoice_id,
           round(sum(coalesce(sip.amount, 0)), 2) as amount
    from public.supplier_invoice_payments sip
    where sip.company_id = p_company_id
      and sip.payment_date <= p_as_of_date
    group by sip.supplier_invoice_id
  ),
  supplier_credits as (
    select sci.credited_invoice_id as supplier_invoice_id,
           round(sum(abs(coalesce(sci.total, 0))), 2) as amount
    from public.supplier_invoices sci
    where sci.company_id = p_company_id
      and sci.is_credit_note
      and sci.credited_invoice_id is not null
      and sci.invoice_date <= p_as_of_date
      and (sci.reversed_at is null or sci.reversed_at::date > p_as_of_date)
    group by sci.credited_invoice_id
  ),
  supplier_open as (
    select
      'supplier_invoice'::text as source_type,
      si.id as source_id,
      coalesce(nullif(si.supplier_invoice_number, ''), si.id::text) as reference,
      coalesce(si.currency, 'SEK')::text as currency,
      si.exchange_rate,
      si.invoice_date,
      si.due_date,
      null::uuid as customer_id,
      si.supplier_id,
      round(coalesce(si.total, 0), 2) as total,
      case
        when si.reversed_at is not null and si.reversed_at::date <= p_as_of_date then 0::numeric
        else round(
          coalesce(si.total, 0)
          - coalesce(sp.amount, 0)
          - coalesce(sc.amount, 0),
          2
        )
      end as open_amount,
      si.status::text as current_status
    from public.supplier_invoices si
    left join supplier_payments sp on sp.supplier_invoice_id = si.id
    left join supplier_credits sc on sc.supplier_invoice_id = si.id
    where si.company_id = p_company_id
      and si.invoice_date <= p_as_of_date
      and not coalesce(si.is_credit_note, false)
      and (si.reversed_at is null or si.reversed_at::date > p_as_of_date)
  )
  select * from customer_open where abs(open_amount) >= 0.005
  union all
  select * from supplier_open where abs(open_amount) >= 0.005
  order by source_type, source_id;
end;
$$;

revoke all on function public.historical_open_items_at(uuid, date) from public;
revoke all on function public.historical_open_items_at(uuid, date) from anon;
grant execute on function public.historical_open_items_at(uuid, date) to authenticated, service_role;

-- Shared service-side actor authorization for economic year-end RPCs.
create or replace function public.__year_end_actor_can_write(
  p_actor_user_id uuid,
  p_company_id uuid,
  p_fiscal_period_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with actor_access as (
    select *
    from public.resolve_company_access_for_user(p_actor_user_id, p_company_id)
  ), entitlement as (
    select public.company_has_feature(p_company_id, 'year_end.projects') as has_subscription,
      exists (
        select 1
        from public.one_time_purchases otp
        where otp.company_id = p_company_id
          and otp.purchase_type = 'year_end'
          and otp.fiscal_period_id = p_fiscal_period_id
          and otp.status in ('paid', 'active', 'fulfilled')
          and coalesce(otp.access_starts_at, otp.paid_at, otp.created_at) <= now()
          and (otp.permanent_access or otp.access_expires_at is null or otp.access_expires_at > now())
      ) as has_one_off
  )
  select coalesce(bool_or(
    a.can_manage_platform
    or (
      a.can_write
      and (e.has_subscription or e.has_one_off)
    )
  ), false)
  from actor_access a
  cross join entitlement e;
$$;

revoke all on function public.__year_end_actor_can_write(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.__year_end_actor_can_write(uuid, uuid, uuid) to service_role;

-- Locked official-rate observations. The posting RPC never accepts a free
-- closing rate as economic truth; it reads the rate from this table.
create table if not exists public.year_end_fx_rate_snapshots (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  fiscal_period_id uuid not null references public.fiscal_periods(id) on delete cascade,
  balance_date date not null,
  currency text not null,
  observed_date date not null,
  rate numeric not null check (rate > 0),
  source text not null check (source = 'riksbanken'),
  source_reference text not null,
  source_payload_hash text not null,
  captured_by uuid references auth.users(id) on delete set null,
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, fiscal_period_id, balance_date, currency),
  check (currency <> 'SEK'),
  check (observed_date <= balance_date and observed_date >= balance_date - 7)
);

alter table public.year_end_fx_rate_snapshots enable row level security;
revoke all on public.year_end_fx_rate_snapshots from public, anon, authenticated;
grant select on public.year_end_fx_rate_snapshots to authenticated, service_role;

drop policy if exists year_end_fx_rate_snapshots_select on public.year_end_fx_rate_snapshots;
create policy year_end_fx_rate_snapshots_select
  on public.year_end_fx_rate_snapshots for select to authenticated
  using (
    exists (
      select 1 from public.resolve_company_access(company_id) access
      where access.can_read
    )
  );

create index if not exists idx_year_end_fx_rate_snapshots_period
  on public.year_end_fx_rate_snapshots(company_id, fiscal_period_id, balance_date);

create table if not exists public.year_end_fx_rate_snapshot_history (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.year_end_fx_rate_snapshots(id) on delete cascade,
  company_id uuid not null,
  fiscal_period_id uuid not null,
  balance_date date not null,
  currency text not null,
  observed_date date not null,
  rate numeric not null,
  source text not null,
  source_reference text not null,
  source_payload_hash text not null,
  captured_by uuid,
  captured_at timestamptz not null,
  superseded_at timestamptz not null default now()
);

alter table public.year_end_fx_rate_snapshot_history enable row level security;
revoke all on public.year_end_fx_rate_snapshot_history from public, anon, authenticated;
grant select on public.year_end_fx_rate_snapshot_history to authenticated, service_role;

drop policy if exists year_end_fx_rate_snapshot_history_select on public.year_end_fx_rate_snapshot_history;
create policy year_end_fx_rate_snapshot_history_select
  on public.year_end_fx_rate_snapshot_history for select to authenticated
  using (
    exists (
      select 1 from public.resolve_company_access(company_id) access
      where access.can_read
    )
  );

create index if not exists idx_year_end_fx_rate_snapshot_history_snapshot
  on public.year_end_fx_rate_snapshot_history(snapshot_id, superseded_at desc);

create or replace function public.archive_year_end_fx_rate_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.year_end_fx_rate_snapshot_history (
    snapshot_id, company_id, fiscal_period_id, balance_date, currency,
    observed_date, rate, source, source_reference, source_payload_hash,
    captured_by, captured_at
  ) values (
    old.id, old.company_id, old.fiscal_period_id, old.balance_date, old.currency,
    old.observed_date, old.rate, old.source, old.source_reference, old.source_payload_hash,
    old.captured_by, old.captured_at
  );
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists archive_year_end_fx_rate_snapshot on public.year_end_fx_rate_snapshots;
create trigger archive_year_end_fx_rate_snapshot
  before update on public.year_end_fx_rate_snapshots
  for each row execute function public.archive_year_end_fx_rate_snapshot();

create or replace function public.register_year_end_fx_rate_snapshots(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_actor_user_id uuid,
  p_balance_date date,
  p_rates jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := coalesce(auth.role(), current_user::text);
  v_period record;
  v_required record;
  v_payload jsonb;
  v_existing record;
  v_payload_count integer;
  v_required_count integer := 0;
  v_rate numeric;
  v_observed_date date;
  v_source text;
  v_source_reference text;
begin
  if v_role not in ('service_role', 'postgres') then
    raise exception 'FORBIDDEN: FX-rate registration is server-only' using errcode = '42501';
  end if;
  if p_actor_user_id is null
     or not public.__year_end_actor_can_write(p_actor_user_id, p_company_id, p_fiscal_period_id) then
    raise exception 'FORBIDDEN: actor lacks year-end write access' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p_rates, '[]'::jsonb)) <> 'array' then
    raise exception 'FX_RATE_SNAPSHOT_INVALID: rates must be an array';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'year-end-fx-rates:' || p_company_id::text || ':' || p_fiscal_period_id::text,
    0
  ));

  select * into v_period
  from public.fiscal_periods fp
  where fp.id = p_fiscal_period_id and fp.company_id = p_company_id
  for update;

  if not found then
    raise exception 'FX_PERIOD_NOT_FOUND: fiscal period not found';
  end if;
  if v_period.is_closed or v_period.locked_at is not null then
    raise exception 'FX_PERIOD_CLOSED: cannot register rates for a closed/locked period';
  end if;
  if p_balance_date is distinct from v_period.period_end then
    raise exception 'FX_BALANCE_DATE_MISMATCH: expected %, got %', v_period.period_end, p_balance_date;
  end if;

  for v_required in
    select distinct hoi.currency
    from public.historical_open_items_at(p_company_id, p_balance_date) hoi
    where hoi.currency <> 'SEK'
      and hoi.exchange_rate is not null
      and hoi.exchange_rate > 0
      and hoi.open_amount > 0
    order by hoi.currency
  loop
    v_required_count := v_required_count + 1;

    select count(*)::integer
      into v_payload_count
    from jsonb_array_elements(coalesce(p_rates, '[]'::jsonb)) x(value)
    where upper(coalesce(x.value->>'currency', '')) = upper(v_required.currency);

    if v_payload_count <> 1 then
      raise exception 'FX_RATE_SNAPSHOT_SET_MISMATCH: currency % matched % payload rows',
        v_required.currency, v_payload_count;
    end if;

    select x.value into v_payload
    from jsonb_array_elements(p_rates) x(value)
    where upper(coalesce(x.value->>'currency', '')) = upper(v_required.currency)
    limit 1;

    v_rate := (v_payload->>'rate')::numeric;
    v_observed_date := (v_payload->>'observed_date')::date;
    v_source := lower(coalesce(v_payload->>'source', ''));
    v_source_reference := nullif(btrim(v_payload->>'source_reference'), '');

    if v_rate is null or v_rate <= 0 then
      raise exception 'FX_INVALID_CLOSING_RATE: currency %', v_required.currency;
    end if;
    if v_source <> 'riksbanken' then
      raise exception 'FX_INVALID_RATE_SOURCE: only Riksbanken rates are accepted';
    end if;
    if v_observed_date > p_balance_date or v_observed_date < p_balance_date - 7 then
      raise exception 'FX_INVALID_RATE_DATE: % is outside the accepted balance-date window', v_observed_date;
    end if;
    if v_source_reference is null then
      raise exception 'FX_RATE_SOURCE_REFERENCE_REQUIRED: currency %', v_required.currency;
    end if;

    select * into v_existing
    from public.year_end_fx_rate_snapshots s
    where s.company_id = p_company_id
      and s.fiscal_period_id = p_fiscal_period_id
      and s.balance_date = p_balance_date
      and s.currency = upper(v_required.currency)
    for update;

    if found then
      if v_existing.rate is distinct from v_rate
         or v_existing.observed_date is distinct from v_observed_date
         or v_existing.source is distinct from v_source
         or v_existing.source_reference is distinct from v_source_reference then
        update public.year_end_fx_rate_snapshots
        set observed_date = v_observed_date,
            rate = v_rate,
            source = v_source,
            source_reference = v_source_reference,
            source_payload_hash = encode(digest(convert_to(v_payload::text, 'UTF8'), 'sha256'), 'hex'),
            captured_by = p_actor_user_id,
            captured_at = now()
        where id = v_existing.id;
      end if;
    else
      insert into public.year_end_fx_rate_snapshots (
        company_id, fiscal_period_id, balance_date, currency,
        observed_date, rate, source, source_reference, source_payload_hash,
        captured_by
      ) values (
        p_company_id, p_fiscal_period_id, p_balance_date, upper(v_required.currency),
        v_observed_date, v_rate, v_source, v_source_reference,
        encode(digest(convert_to(v_payload::text, 'UTF8'), 'sha256'), 'hex'),
        p_actor_user_id
      );
    end if;
  end loop;

  if jsonb_array_length(coalesce(p_rates, '[]'::jsonb)) <> v_required_count then
    raise exception 'FX_RATE_SNAPSHOT_SET_MISMATCH: expected % rates, received %',
      v_required_count, jsonb_array_length(coalesce(p_rates, '[]'::jsonb));
  end if;

  insert into public.audit_log (
    user_id, actor_id, company_id, action, table_name, description, new_state
  ) values (
    p_actor_user_id, p_actor_user_id, p_company_id, 'INSERT',
    'year_end_fx_rate_snapshots', 'Official year-end FX-rate snapshot registered',
    jsonb_build_object(
      'fiscal_period_id', p_fiscal_period_id,
      'balance_date', p_balance_date,
      'currency_count', v_required_count
    )
  );

  return jsonb_build_object('registered', v_required_count, 'balance_date', p_balance_date);
end;
$$;

revoke all on function public.register_year_end_fx_rate_snapshots(uuid, uuid, uuid, date, jsonb)
  from public, anon, authenticated;
grant execute on function public.register_year_end_fx_rate_snapshots(uuid, uuid, uuid, date, jsonb)
  to service_role;

alter table public.currency_revaluation_items
  add column if not exists rate_closing_date date,
  add column if not exists rate_source text;

-- ---------------------------------------------------------------------------
-- 3. Database-verified, service-only FX posting.
-- ---------------------------------------------------------------------------
create or replace function public.post_currency_revaluation(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_user_id uuid,
  p_balance_date date,
  p_snapshot_key text,
  p_lines jsonb,
  p_items jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := coalesce(auth.role(), current_user::text);
  v_period record;
  v_existing record;
  v_entry_id uuid;
  v_run_id uuid;
  v_open record;
  v_payload_item jsonb;
  v_payload_count integer;
  v_canonical_count integer := 0;
  v_rate_closing numeric;
  v_rate_date date;
  v_rate_source text;
  v_original_sek numeric;
  v_closing_sek numeric;
  v_diff numeric;
  v_verified_items jsonb := '[]'::jsonb;
  v_verified_lines jsonb := '[]'::jsonb;
  v_verified_snapshot_key text;
  v_debit_1510 numeric := 0;
  v_credit_1510 numeric := 0;
  v_debit_2440 numeric := 0;
  v_credit_2440 numeric := 0;
  v_credit_3960 numeric := 0;
  v_debit_7960 numeric := 0;
begin
  if v_role not in ('service_role', 'postgres') then
    raise exception 'FORBIDDEN: currency revaluation is server-only' using errcode = '42501';
  end if;
  if p_user_id is null or not public.__year_end_actor_can_write(p_user_id, p_company_id, p_fiscal_period_id) then
    raise exception 'FORBIDDEN: actor lacks year-end write access' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) <> 'array' then
    raise exception 'FX_INVALID_PAYLOAD: items and lines must be arrays';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_company_id::text || ':fx:' || p_fiscal_period_id::text));

  select * into v_period
  from public.fiscal_periods
  where id = p_fiscal_period_id and company_id = p_company_id
  for update;
  if not found then
    raise exception 'FX_PERIOD_NOT_FOUND: fiscal period not found';
  end if;
  if v_period.is_closed or v_period.locked_at is not null then
    raise exception 'FX_PERIOD_CLOSED: cannot revalue a closed/locked period';
  end if;
  if p_balance_date is distinct from v_period.period_end then
    raise exception 'FX_BALANCE_DATE_MISMATCH: expected %, got %', v_period.period_end, p_balance_date;
  end if;

  for v_open in
    select *
    from public.historical_open_items_at(p_company_id, p_balance_date)
    where currency <> 'SEK'
      and exchange_rate is not null
      and exchange_rate > 0
      and open_amount > 0
    order by source_type, source_id
  loop
    v_canonical_count := v_canonical_count + 1;

    select count(*)::integer into v_payload_count
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x(value)
    where (v_open.source_type = 'invoice' and x.value->>'invoice_id' = v_open.source_id::text)
       or (v_open.source_type = 'supplier_invoice' and x.value->>'supplier_invoice_id' = v_open.source_id::text);

    if v_payload_count <> 1 then
      raise exception 'FX_ITEM_SET_MISMATCH: source % % matched % payload rows',
        v_open.source_type, v_open.source_id, v_payload_count;
    end if;

    select x.value into v_payload_item
    from jsonb_array_elements(p_items) x(value)
    where (v_open.source_type = 'invoice' and x.value->>'invoice_id' = v_open.source_id::text)
       or (v_open.source_type = 'supplier_invoice' and x.value->>'supplier_invoice_id' = v_open.source_id::text)
    limit 1;

    if coalesce(v_payload_item->>'currency', '') <> v_open.currency then
      raise exception 'FX_ITEM_CURRENCY_MISMATCH: source %', v_open.source_id;
    end if;
    if abs((v_payload_item->>'open_amount_currency')::numeric - round(v_open.open_amount, 2)) > 0.004 then
      raise exception 'FX_ITEM_OPEN_AMOUNT_MISMATCH: source %', v_open.source_id;
    end if;
    if abs((v_payload_item->>'rate_original')::numeric - v_open.exchange_rate) > 0.000001 then
      raise exception 'FX_ITEM_ORIGINAL_RATE_MISMATCH: source %', v_open.source_id;
    end if;

    select s.rate, s.observed_date, s.source
      into v_rate_closing, v_rate_date, v_rate_source
    from public.year_end_fx_rate_snapshots s
    where s.company_id = p_company_id
      and s.fiscal_period_id = p_fiscal_period_id
      and s.balance_date = p_balance_date
      and s.currency = upper(v_open.currency)
    limit 1;

    if not found then
      raise exception 'FX_RATE_SNAPSHOT_MISSING: currency %', v_open.currency;
    end if;

    -- Payload fields are assertions only. Economic truth comes from the locked
    -- snapshot above and the historical-open-item reconstruction.
    if abs((v_payload_item->>'rate_closing')::numeric - v_rate_closing) > 0.000001
       or (v_payload_item->>'rate_closing_date')::date is distinct from v_rate_date
       or lower(coalesce(v_payload_item->>'rate_source', '')) is distinct from v_rate_source then
      raise exception 'FX_ITEM_CLOSING_RATE_MISMATCH: source %', v_open.source_id;
    end if;

    v_original_sek := round(v_open.open_amount * v_open.exchange_rate, 2);
    v_closing_sek := round(v_open.open_amount * v_rate_closing, 2);
    v_diff := round(v_closing_sek - v_original_sek, 2);

    if abs((v_payload_item->>'open_amount_sek_original')::numeric - v_original_sek) > 0.004
       or abs((v_payload_item->>'unrealized_diff_sek')::numeric - v_diff) > 0.004 then
      raise exception 'FX_ITEM_DERIVATION_MISMATCH: source %', v_open.source_id;
    end if;

    v_verified_items := v_verified_items || jsonb_build_array(jsonb_build_object(
      'invoice_id', case when v_open.source_type = 'invoice' then v_open.source_id else null end,
      'supplier_invoice_id', case when v_open.source_type = 'supplier_invoice' then v_open.source_id else null end,
      'currency', v_open.currency,
      'open_amount_currency', round(v_open.open_amount, 2),
      'open_amount_sek_original', v_original_sek,
      'rate_original', v_open.exchange_rate,
      'rate_closing', v_rate_closing,
      'rate_closing_date', v_rate_date,
      'rate_source', v_rate_source,
      'unrealized_diff_sek', v_diff
    ));

    if abs(v_diff) >= 0.005 then
      if v_open.source_type = 'invoice' then
        if v_diff > 0 then
          v_debit_1510 := v_debit_1510 + v_diff;
          v_credit_3960 := v_credit_3960 + v_diff;
        else
          v_credit_1510 := v_credit_1510 + abs(v_diff);
          v_debit_7960 := v_debit_7960 + abs(v_diff);
        end if;
      else
        if v_diff > 0 then
          v_credit_2440 := v_credit_2440 + v_diff;
          v_debit_7960 := v_debit_7960 + v_diff;
        else
          v_debit_2440 := v_debit_2440 + abs(v_diff);
          v_credit_3960 := v_credit_3960 + abs(v_diff);
        end if;
      end if;
    end if;
  end loop;

  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) <> v_canonical_count then
    raise exception 'FX_ITEM_SET_MISMATCH: expected % rows, received %',
      v_canonical_count, jsonb_array_length(coalesce(p_items, '[]'::jsonb));
  end if;

  if v_debit_1510 > 0 then
    v_verified_lines := v_verified_lines || jsonb_build_array(jsonb_build_object(
      'account_number','1510','debit_amount',round(v_debit_1510,2),'credit_amount',0,
      'line_description','Omvärdering kundfordringar — orealiserad kursvinst'));
  end if;
  if v_credit_1510 > 0 then
    v_verified_lines := v_verified_lines || jsonb_build_array(jsonb_build_object(
      'account_number','1510','debit_amount',0,'credit_amount',round(v_credit_1510,2),
      'line_description','Omvärdering kundfordringar — orealiserad kursförlust'));
  end if;
  if v_debit_2440 > 0 then
    v_verified_lines := v_verified_lines || jsonb_build_array(jsonb_build_object(
      'account_number','2440','debit_amount',round(v_debit_2440,2),'credit_amount',0,
      'line_description','Omvärdering leverantörsskulder — orealiserad kursvinst'));
  end if;
  if v_credit_2440 > 0 then
    v_verified_lines := v_verified_lines || jsonb_build_array(jsonb_build_object(
      'account_number','2440','debit_amount',0,'credit_amount',round(v_credit_2440,2),
      'line_description','Omvärdering leverantörsskulder — orealiserad kursförlust'));
  end if;
  if v_credit_3960 > 0 then
    v_verified_lines := v_verified_lines || jsonb_build_array(jsonb_build_object(
      'account_number','3960','debit_amount',0,'credit_amount',round(v_credit_3960,2),
      'line_description','Orealiserade valutakursvinster'));
  end if;
  if v_debit_7960 > 0 then
    v_verified_lines := v_verified_lines || jsonb_build_array(jsonb_build_object(
      'account_number','7960','debit_amount',round(v_debit_7960,2),'credit_amount',0,
      'line_description','Orealiserade valutakursförluster'));
  end if;

  if coalesce(p_lines, '[]'::jsonb) <> v_verified_lines then
    raise exception 'FX_LINES_MISMATCH: journal lines must be derived by the database';
  end if;

  v_verified_snapshot_key := encode(digest(convert_to(
    jsonb_build_object(
      'company_id', p_company_id,
      'fiscal_period_id', p_fiscal_period_id,
      'balance_date', p_balance_date,
      'items', v_verified_items
    )::text,
    'UTF8'
  ), 'sha256'), 'hex');

  select * into v_existing
  from public.currency_revaluation_runs
  where company_id = p_company_id
    and fiscal_period_id = p_fiscal_period_id
    and status = 'posted'
  for update;

  if found then
    if v_existing.snapshot_key = v_verified_snapshot_key then
      return jsonb_build_object(
        'run_id', v_existing.id,
        'entry_id', v_existing.entry_id,
        'snapshot_key', v_verified_snapshot_key,
        'reused', true
      );
    end if;

    if v_existing.entry_id is not null then
      declare
        v_storno_id uuid;
      begin
        v_storno_id := public.__ye_post_entry(
          p_company_id, p_user_id, p_fiscal_period_id, p_balance_date,
          'Återföring: ersatt valutaomvärdering', 'storno', 'A',
          (select jsonb_agg(jsonb_build_object(
            'account_number', l.account_number,
            'debit_amount', l.credit_amount,
            'credit_amount', l.debit_amount,
            'line_description', 'Återföring: ' || coalesce(l.line_description, '')
          ) order by l.id)
          from public.journal_entry_lines l
          where l.journal_entry_id = v_existing.entry_id),
          v_existing.entry_id
        );
        update public.journal_entries
        set status = 'reversed', reversed_by_id = v_storno_id
        where id = v_existing.entry_id and company_id = p_company_id;
      end;
    end if;

    update public.currency_revaluation_runs
    set status = 'replaced', updated_at = now()
    where id = v_existing.id;
  end if;

  if jsonb_array_length(v_verified_lines) = 0 then
    insert into public.currency_revaluation_runs
      (company_id, fiscal_period_id, balance_date, snapshot_key, status, entry_id, created_by)
    values
      (p_company_id, p_fiscal_period_id, p_balance_date, v_verified_snapshot_key, 'posted', null, p_user_id)
    returning id into v_run_id;

    return jsonb_build_object(
      'run_id', v_run_id,
      'entry_id', null,
      'snapshot_key', v_verified_snapshot_key,
      'reused', false
    );
  end if;

  v_entry_id := public.__ye_post_entry(
    p_company_id, p_user_id, p_fiscal_period_id, p_balance_date,
    'Valutaomvärdering per ' || p_balance_date::text,
    'currency_revaluation', 'A', v_verified_lines
  );

  insert into public.currency_revaluation_runs
    (company_id, fiscal_period_id, balance_date, snapshot_key, status, entry_id, created_by)
  values
    (p_company_id, p_fiscal_period_id, p_balance_date, v_verified_snapshot_key, 'posted', v_entry_id, p_user_id)
  returning id into v_run_id;

  insert into public.currency_revaluation_items
    (run_id, company_id, invoice_id, supplier_invoice_id, currency,
     open_amount_currency, open_amount_sek_original, rate_original,
     rate_closing, rate_closing_date, rate_source, unrealized_diff_sek)
  select
    v_run_id,
    p_company_id,
    nullif(x.value->>'invoice_id', '')::uuid,
    nullif(x.value->>'supplier_invoice_id', '')::uuid,
    x.value->>'currency',
    (x.value->>'open_amount_currency')::numeric,
    (x.value->>'open_amount_sek_original')::numeric,
    (x.value->>'rate_original')::numeric,
    (x.value->>'rate_closing')::numeric,
    (x.value->>'rate_closing_date')::date,
    x.value->>'rate_source',
    (x.value->>'unrealized_diff_sek')::numeric
  from jsonb_array_elements(v_verified_items) x(value);

  return jsonb_build_object(
    'run_id', v_run_id,
    'entry_id', v_entry_id,
    'snapshot_key', v_verified_snapshot_key,
    'reused', false
  );
end;
$$;

revoke all on function public.post_currency_revaluation(uuid, uuid, uuid, date, text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.post_currency_revaluation(uuid, uuid, uuid, date, text, jsonb, jsonb)
  to service_role;

-- The close operation is also server-only. Preserve the already-audited,
-- transactionally complete implementation as a private function and expose a
-- wrapper that verifies the supplied actor before any economic operation.
alter function public.execute_year_end_closing(uuid, uuid, uuid, text, jsonb)
  rename to __execute_year_end_closing_internal;

revoke all on function public.__execute_year_end_closing_internal(uuid, uuid, uuid, text, jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.execute_year_end_closing(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_user_id uuid,
  p_idempotency_key text,
  p_revaluation jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := coalesce(auth.role(), current_user::text);
begin
  if v_role not in ('service_role', 'postgres') then
    raise exception 'FORBIDDEN: year-end closing is server-only' using errcode = '42501';
  end if;
  if p_user_id is null
     or not public.__year_end_actor_can_write(p_user_id, p_company_id, p_fiscal_period_id) then
    raise exception 'FORBIDDEN: actor lacks year-end write access' using errcode = '42501';
  end if;

  return public.__execute_year_end_closing_internal(
    p_company_id,
    p_fiscal_period_id,
    p_user_id,
    p_idempotency_key,
    p_revaluation
  );
end;
$$;

revoke all on function public.execute_year_end_closing(uuid, uuid, uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.execute_year_end_closing(uuid, uuid, uuid, text, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4. Durable failed-run recording. The caller must not swallow failures here.
-- ---------------------------------------------------------------------------
create or replace function public.record_year_end_failure(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_actor_user_id uuid,
  p_idempotency_key text,
  p_current_step text,
  p_error_code text,
  p_technical_error text,
  p_user_message text,
  p_correlation_id text default null,
  p_recovery_required boolean default false
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := coalesce(auth.role(), current_user::text);
  v_run_id uuid;
  v_retry_count integer := 0;
begin
  if v_role not in ('service_role', 'postgres') then
    raise exception 'FORBIDDEN: failed-run recording is server-only' using errcode = '42501';
  end if;
  if p_actor_user_id is null
     or not public.__year_end_actor_can_write(p_actor_user_id, p_company_id, p_fiscal_period_id) then
    raise exception 'FORBIDDEN: actor lacks year-end access' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.fiscal_periods fp
    where fp.id = p_fiscal_period_id and fp.company_id = p_company_id
  ) then
    raise exception 'YE_PERIOD_NOT_FOUND';
  end if;

  select count(*)::integer
    into v_retry_count
  from public.year_end_runs yer
  where yer.company_id = p_company_id
    and yer.fiscal_period_id = p_fiscal_period_id
    and yer.idempotency_key = p_idempotency_key
    and yer.status in ('failed', 'recovery_required');

  insert into public.year_end_runs (
    company_id, fiscal_period_id, status, idempotency_key,
    current_step, error_code, error_message, technical_error, user_message,
    correlation_id, created_by, finished_at, retry_count, last_retry_at
  ) values (
    p_company_id, p_fiscal_period_id,
    case when p_recovery_required then 'recovery_required' else 'failed' end,
    p_idempotency_key,
    coalesce(p_current_step, 'closing'),
    left(coalesce(p_error_code, 'YEAR_END_FAILED'), 120),
    left(coalesce(p_user_message, p_technical_error, 'Bokslutet misslyckades.'), 2000),
    left(coalesce(p_technical_error, 'unknown'), 8000),
    left(coalesce(p_user_message, 'Bokslutet kunde inte genomföras.'), 2000),
    nullif(p_correlation_id, ''),
    p_actor_user_id,
    now(),
    v_retry_count,
    case when v_retry_count > 0 then now() else null end
  ) returning id into v_run_id;

  insert into public.audit_log (
    user_id, company_id, action, table_name, record_id, actor_id,
    new_state, description, actor_type, actor_label
  ) values (
    p_actor_user_id,
    p_company_id,
    'INSERT',
    'year_end_runs',
    v_run_id,
    p_actor_user_id,
    jsonb_build_object(
      'fiscal_period_id', p_fiscal_period_id,
      'status', case when p_recovery_required then 'recovery_required' else 'failed' end,
      'idempotency_key', p_idempotency_key,
      'current_step', p_current_step,
      'error_code', p_error_code,
      'correlation_id', p_correlation_id,
      'recovery_required', p_recovery_required,
      'retry_count', v_retry_count
    ),
    'Recorded failed year-end run',
    'user',
    null
  );

  return v_run_id;
end;
$$;

revoke all on function public.record_year_end_failure(uuid, uuid, uuid, text, text, text, text, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.record_year_end_failure(uuid, uuid, uuid, text, text, text, text, text, text, boolean)
  to service_role;

notify pgrst, 'reload schema';
