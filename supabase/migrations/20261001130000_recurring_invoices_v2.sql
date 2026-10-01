-- Recurring invoices, second version.
--
-- 1. Cadence: interval_months (1, 2, 3, 6 or 12) instead of always monthly,
--    an optional end_date and max_occurrences, after which the schedule is
--    'ended'.
-- 2. Billing period: billing_timing says which calendar months an invoice
--    covers: the month(s) of the run date (current_period), the following
--    month(s) (next_period, rent and subscriptions paid in advance) or the
--    month(s) that just ended (previous_period, billing in arrears). The period
--    is stored on the invoice (period_start/period_end) and printed on it:
--    for continuous services the invoice must state the period the supply
--    covers (ML 17 kap. 24 § p. 8).
-- 3. Lines: article_id and revenue_account like a manual invoice line;
--    valid_from/valid_until limit a line to invoices whose period overlaps
--    that range (an extra item for one month); remaining_occurrences limits
--    a line to the next N invoices (null = every invoice).
-- 4. sale_type follows the manual invoice (goods vs services decides the
--    zero-rate revenue accounts for reverse charge and export).
--
-- replace_recurring_schedule_items() is restated with the new columns and
-- now also refuses an article or revenue account from another company.
--
-- pg-test: tests/pg/recurring-invoices-v2.pg.test.ts

alter table public.recurring_invoice_schedules
  add column if not exists interval_months smallint not null default 1,
  add column if not exists end_date date,
  add column if not exists max_occurrences integer,
  add column if not exists billing_timing text not null default 'current_period',
  add column if not exists sale_type text not null default 'services',
  add column if not exists ended_at timestamptz;

alter table public.recurring_invoice_schedules
  drop constraint if exists recurring_invoice_schedules_interval_months_check,
  add constraint recurring_invoice_schedules_interval_months_check
    check (interval_months in (1, 2, 3, 6, 12)),
  drop constraint if exists recurring_invoice_schedules_max_occurrences_check,
  add constraint recurring_invoice_schedules_max_occurrences_check
    check (max_occurrences is null or max_occurrences between 1 and 1200),
  drop constraint if exists recurring_invoice_schedules_billing_timing_check,
  add constraint recurring_invoice_schedules_billing_timing_check
    check (billing_timing in ('current_period', 'next_period', 'previous_period')),
  drop constraint if exists recurring_invoice_schedules_sale_type_check,
  add constraint recurring_invoice_schedules_sale_type_check
    check (sale_type in ('goods', 'services')),
  drop constraint if exists recurring_invoice_schedules_status_check,
  add constraint recurring_invoice_schedules_status_check
    check (status in ('active', 'paused', 'ended'));

comment on column public.recurring_invoice_schedules.interval_months is
  'Months between invoices: 1 monthly, 3 quarterly, 12 yearly.';
comment on column public.recurring_invoice_schedules.billing_timing is
  'Calendar months an invoice covers relative to its run date: current_period, next_period (in advance) or previous_period (in arrears).';

alter table public.recurring_invoice_schedule_items
  add column if not exists article_id uuid references public.articles(id) on delete set null,
  add column if not exists revenue_account text,
  add column if not exists valid_from date,
  add column if not exists valid_until date,
  add column if not exists remaining_occurrences integer;

alter table public.recurring_invoice_schedule_items
  drop constraint if exists recurring_invoice_schedule_items_valid_range_check,
  add constraint recurring_invoice_schedule_items_valid_range_check
    check (valid_from is null or valid_until is null or valid_from <= valid_until),
  drop constraint if exists recurring_invoice_schedule_items_remaining_check,
  add constraint recurring_invoice_schedule_items_remaining_check
    check (remaining_occurrences is null or remaining_occurrences between 1 and 1200),
  drop constraint if exists recurring_invoice_schedule_items_revenue_account_check,
  add constraint recurring_invoice_schedule_items_revenue_account_check
    check (revenue_account is null or revenue_account ~ '^3[0-9]{3}$');

create index if not exists idx_risi_article on public.recurring_invoice_schedule_items (article_id)
  where article_id is not null;

alter table public.invoices
  add column if not exists period_start date,
  add column if not exists period_end date;

alter table public.invoices
  drop constraint if exists invoices_period_range_check,
  add constraint invoices_period_range_check
    check (period_start is null or period_end is null or period_start <= period_end);

comment on column public.invoices.period_start is
  'First day of the period a continuous service invoice covers (printed on the invoice).';

-- ---------------------------------------------------------------------------
-- replace_recurring_schedule_items (restated from 20260715130000)
-- ---------------------------------------------------------------------------
create or replace function public.replace_recurring_schedule_items(
  p_schedule_id uuid,
  p_company_id uuid,
  p_items jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_can_write boolean := false;
begin
  -- Tenant guard: the schedule must belong to the claimed company.
  if not exists (
    select 1 from public.recurring_invoice_schedules s
    where s.id = p_schedule_id and s.company_id = p_company_id
  ) then
    raise exception 'Schemat hittades inte.' using errcode = 'P0002';
  end if;

  -- Write guard: service role, or a caller with write access to the company
  -- (viewer/read-only roles are rejected — same rule as the API layer).
  if coalesce(auth.role(), '') <> 'service_role' then
    select ra.can_write into v_can_write
    from public.resolve_company_access(p_company_id) ra;
    if not coalesce(v_can_write, false) then
      raise exception 'Du har endast läsbehörighet i detta företag.' using errcode = '42501';
    end if;
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Minst en fakturarad krävs.' using errcode = '22023';
  end if;

  -- Articles must be the company's own.
  if exists (
    select 1
      from jsonb_array_elements(p_items) item
     where nullif(item->>'article_id', '') is not null
       and not exists (
         select 1 from public.articles a
          where a.id = (item->>'article_id')::uuid and a.company_id = p_company_id
       )
  ) then
    raise exception 'Artikeln hittades inte.' using errcode = 'P0002';
  end if;

  delete from public.recurring_invoice_schedule_items where schedule_id = p_schedule_id;

  insert into public.recurring_invoice_schedule_items
    (schedule_id, sort_order, description, quantity, unit, unit_price, vat_rate,
     article_id, revenue_account, valid_from, valid_until, remaining_occurrences)
  select
    p_schedule_id,
    (ordinality - 1)::int,
    item->>'description',
    (item->>'quantity')::numeric,
    coalesce(nullif(item->>'unit', ''), 'st'),
    (item->>'unit_price')::numeric,
    nullif(item->>'vat_rate', '')::numeric,
    nullif(item->>'article_id', '')::uuid,
    nullif(item->>'revenue_account', ''),
    nullif(item->>'valid_from', '')::date,
    nullif(item->>'valid_until', '')::date,
    nullif(item->>'remaining_occurrences', '')::integer
  from jsonb_array_elements(p_items) with ordinality as t(item, ordinality);
end;
$$;

revoke all on function public.replace_recurring_schedule_items(uuid, uuid, jsonb) from public, anon;
grant execute on function public.replace_recurring_schedule_items(uuid, uuid, jsonb) to authenticated, service_role;

NOTIFY pgrst, 'reload schema';
