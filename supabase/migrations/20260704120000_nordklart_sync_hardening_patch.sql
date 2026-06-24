-- Nordklart sync hardening patch
-- - Makes webhook overview surfaces read the runtime webhook model.
-- - Restores a real company-scoped tax_codes schema after the legacy placeholder.
-- - Stores selected public plan versions through signup.
-- - Blocks SVG logo uploads at the storage policy level.

-- -----------------------------------------------------------------------------
-- Webhook runtime compatibility
-- -----------------------------------------------------------------------------
-- The active delivery engine uses public.webhooks + public.webhook_deliveries.
-- Keep the overview view aligned with that runtime source so platform screens do
-- not drift to the newer endpoint table before dispatcher/handler are migrated.
create or replace view public.api_webhook_overview_v
with (security_invoker = true) as
select
  w.company_id,
  count(*) as endpoint_count,
  count(*) filter (where w.active = true and w.disabled_at is null) as active_endpoint_count,
  count(wd.id) filter (where wd.status in ('failed', 'dead')) as failure_count,
  max(wd.delivered_at) as last_delivery_at
from public.webhooks w
left join public.webhook_deliveries wd on wd.webhook_id = w.id
group by w.company_id;

-- -----------------------------------------------------------------------------
-- Tax codes
-- -----------------------------------------------------------------------------
create table if not exists public.tax_codes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  code text not null,
  description text not null,
  rate numeric(6,2) not null default 0,
  moms_basis_boxes text[] not null default '{}'::text[],
  moms_tax_boxes text[] not null default '{}'::text[],
  moms_input_boxes text[] not null default '{}'::text[],
  is_output_vat boolean not null default false,
  is_reverse_charge boolean not null default false,
  is_eu boolean not null default false,
  is_export boolean not null default false,
  is_oss boolean not null default false,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(company_id, code)
);

create unique index if not exists tax_codes_system_code_uq on public.tax_codes(code) where company_id is null;

alter table public.tax_codes enable row level security;

drop policy if exists tax_codes_select on public.tax_codes;
create policy tax_codes_select on public.tax_codes for select using (
  company_id is null or public.user_can_access_company_v2(company_id) or public.is_platform_admin()
);

drop policy if exists tax_codes_write on public.tax_codes;
create policy tax_codes_write on public.tax_codes for all using (
  company_id is not null and (public.user_can_access_company_v2(company_id) or public.is_platform_admin())
) with check (
  company_id is not null and (public.user_can_access_company_v2(company_id) or public.is_platform_admin())
);

drop trigger if exists tax_codes_updated_at on public.tax_codes;
create trigger tax_codes_updated_at before update on public.tax_codes for each row execute function public.update_updated_at_column();

insert into public.tax_codes (
  company_id, code, description, rate, moms_basis_boxes, moms_tax_boxes, moms_input_boxes,
  is_output_vat, is_reverse_charge, is_eu, is_export, is_oss, is_system
) values
  (null, 'MP1', 'Utgående moms 25 %', 25, array['05'], array['10'], array[]::text[], true, false, false, false, false, true),
  (null, 'MP2', 'Utgående moms 12 %', 12, array['05'], array['11'], array[]::text[], true, false, false, false, false, true),
  (null, 'MP3', 'Utgående moms 6 %', 6, array['05'], array['12'], array[]::text[], true, false, false, false, false, true),
  (null, 'MPI', 'Ingående moms 25 %', 25, array[]::text[], array[]::text[], array['48'], false, false, false, false, false, true),
  (null, 'MPI12', 'Ingående moms 12 %', 12, array[]::text[], array[]::text[], array['48'], false, false, false, false, false, true),
  (null, 'MPI6', 'Ingående moms 6 %', 6, array[]::text[], array[]::text[], array['48'], false, false, false, false, false, true),
  (null, 'EUS', 'Försäljning till annat EU-land', 0, array['35'], array[]::text[], array[]::text[], true, true, true, false, false, true),
  (null, 'EXP', 'Export utanför EU', 0, array['36'], array[]::text[], array[]::text[], true, false, false, true, false, true),
  (null, 'NONE', 'Momsfri eller ej momspliktig', 0, array[]::text[], array[]::text[], array[]::text[], false, false, false, false, false, true)
on conflict (code) where company_id is null do update set
  description = excluded.description,
  rate = excluded.rate,
  moms_basis_boxes = excluded.moms_basis_boxes,
  moms_tax_boxes = excluded.moms_tax_boxes,
  moms_input_boxes = excluded.moms_input_boxes,
  is_output_vat = excluded.is_output_vat,
  is_reverse_charge = excluded.is_reverse_charge,
  is_eu = excluded.is_eu,
  is_export = excluded.is_export,
  is_oss = excluded.is_oss,
  is_system = excluded.is_system,
  updated_at = now();

create or replace function public.seed_tax_codes_for_company(p_company_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_company_id is null then
    raise exception 'company_id is required' using errcode = '22023';
  end if;

  if not (public.user_can_access_company_v2(p_company_id) or public.is_platform_admin() or coalesce(auth.role(), '') = 'service_role') then
    raise exception 'not authorized to seed tax codes for company' using errcode = '42501';
  end if;

  insert into public.tax_codes (
    company_id, code, description, rate, moms_basis_boxes, moms_tax_boxes, moms_input_boxes,
    is_output_vat, is_reverse_charge, is_eu, is_export, is_oss, is_system
  )
  select
    p_company_id, code, description, rate, moms_basis_boxes, moms_tax_boxes, moms_input_boxes,
    is_output_vat, is_reverse_charge, is_eu, is_export, is_oss, false
  from public.tax_codes
  where company_id is null and is_system = true
  on conflict (company_id, code) do nothing;
end;
$$;

revoke all on function public.seed_tax_codes_for_company(uuid) from public;
grant execute on function public.seed_tax_codes_for_company(uuid) to authenticated, service_role;

-- Backwards compatibility for older call sites until they are fully removed.
create or replace function public.seed_tax_codes_for_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'seed_tax_codes_for_user is retired; call seed_tax_codes_for_company(company_id)' using errcode = '0A000';
end;
$$;

-- -----------------------------------------------------------------------------
-- Signup plan intent
-- -----------------------------------------------------------------------------
alter table if exists public.signup_drafts
  add column if not exists selected_plan_version_id uuid references public.platform_plan_versions(id) on delete set null,
  add column if not exists selected_plan_code text;

create index if not exists idx_signup_drafts_selected_plan_version on public.signup_drafts(selected_plan_version_id) where selected_plan_version_id is not null;

-- -----------------------------------------------------------------------------
-- Logo MIME hardening: public logos should not accept SVG unless sanitized.
-- -----------------------------------------------------------------------------
update storage.buckets
set allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp']
where id = 'logos';

notify pgrst, 'reload schema';
