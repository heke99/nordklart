-- Resolve PL/pgSQL output-column ambiguity in historical open-item reconstruction.
--
-- `historical_open_items_at()` returns a column named `open_amount`. In a
-- PL/pgSQL RETURNS TABLE function, output columns are also variables. The
-- original final query referenced `open_amount`, `source_type` and `source_id`
-- without relation aliases, so PostgreSQL could not decide whether they meant
-- output variables or CTE columns. Year-end readiness calls this function and
-- therefore failed closed with SQLSTATE 42702.
--
-- Keep the economic reconstruction unchanged; qualify every final CTE column
-- so readiness, aging and FX revaluation share the same deterministic source.

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
  ),
  combined_open as (
    select co.*
    from customer_open co
    where abs(co.open_amount) >= 0.005

    union all

    select so.*
    from supplier_open so
    where abs(so.open_amount) >= 0.005
  )
  select
    hoi.source_type,
    hoi.source_id,
    hoi.reference,
    hoi.currency,
    hoi.exchange_rate,
    hoi.invoice_date,
    hoi.due_date,
    hoi.customer_id,
    hoi.supplier_id,
    hoi.total,
    hoi.open_amount,
    hoi.current_status
  from combined_open hoi
  order by hoi.source_type, hoi.source_id;
end;
$$;

revoke all on function public.historical_open_items_at(uuid, date) from public;
revoke all on function public.historical_open_items_at(uuid, date) from anon;
grant execute on function public.historical_open_items_at(uuid, date) to authenticated, service_role;

notify pgrst, 'reload schema';
