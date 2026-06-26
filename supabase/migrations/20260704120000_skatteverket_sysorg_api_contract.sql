-- Skatteverket sysorg/CCG contract for Nordklart.
-- Additive only: prepares test/prod configuration, request audit and service mapping
-- for Moms, AGD, INK1 and INK2-4 without touching posted bookkeeping data.

create extension if not exists pgcrypto;

alter table if exists public.skatteverket_company_settings
  add column if not exists auth_flow text not null default 'per_bankid'
    check (auth_flow in ('per_bankid','ccg_sysorg','org_acg')),
  add column if not exists api_environment text not null default 'test'
    check (api_environment in ('test','prod')),
  add column if not exists sysorg_enabled boolean not null default false,
  add column if not exists filframstallare_orgnr text,
  add column if not exists filframstallare_id text,
  add column if not exists filframstallare_name text,
  add column if not exists filframstallare_contact_name text,
  add column if not exists filframstallare_contact_email text,
  add column if not exists last_sysorg_token_test_at timestamptz,
  add column if not exists last_sysorg_token_status text
    check (last_sysorg_token_status is null or last_sysorg_token_status in ('ok','failed','missing_config','disabled'));

create table if not exists public.skatteverket_api_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  service text not null
    check (service in ('momsdeklaration','agdInlamning','agdPeriod','ink1','inkForetag','skattekonto','unknown')),
  operation text not null,
  environment text check (environment is null or environment in ('test','prod')),
  auth_flow text not null default 'ccg_sysorg'
    check (auth_flow in ('per_bankid','ccg_sysorg','org_acg')),
  correlation_id text not null,
  request_id text,
  request_url text,
  method text not null check (method in ('GET','POST','PUT','DELETE','PATCH')),
  status text not null default 'started'
    check (status in ('started','succeeded','failed')),
  status_code integer,
  duration_ms integer,
  skv_error_code text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  constraint skatteverket_api_requests_correlation_unique unique (correlation_id)
);

create index if not exists skatteverket_api_requests_company_idx
  on public.skatteverket_api_requests(company_id, started_at desc);
create index if not exists skatteverket_api_requests_service_idx
  on public.skatteverket_api_requests(service, status, started_at desc);
create index if not exists skatteverket_api_requests_correlation_idx
  on public.skatteverket_api_requests(correlation_id);

create table if not exists public.skatteverket_service_catalog (
  service text primary key,
  scope text not null,
  display_name text not null,
  lifecycle_status text not null default 'test'
    check (lifecycle_status in ('test','prod','planned','disabled')),
  auth_flow text not null default 'ccg_sysorg',
  base_url_env_var text not null,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.skatteverket_service_catalog (service, scope, display_name, lifecycle_status, auth_flow, base_url_env_var, notes)
values
  ('momsdeklaration', 'momsdeklaration', 'Momsdeklaration', 'test', 'ccg_sysorg', 'SKV_MOMS_API_BASE_URL', 'JSON-flöde: kontrollera, spara/lås utkast, hämta inlämnat och beslutat.'),
  ('agdInlamning', 'agd', 'Arbetsgivardeklaration inlämning', 'test', 'ccg_sysorg', 'SKV_AGD_INLAMNING_API_BASE_URL', 'XML-underlag med asynkront kontrollresultat och granskningsunderlag.'),
  ('agdPeriod', 'agd', 'Arbetsgivardeklaration hantera redovisningsperiod', 'test', 'ccg_sysorg', 'SKV_AGD_PERIOD_API_BASE_URL', 'Grunddata, händelser, summeringsrapport, låsning och kvittenser.'),
  ('ink1', 'ink1', 'Inkomstdeklaration 1', 'test', 'ccg_sysorg', 'SKV_INK1_API_BASE_URL', 'SRU ZIP base64 i JSON till eget utrymme. Ej full produktionsdrift enligt tjänstebeskrivningen.'),
  ('inkForetag', 'inkforetag', 'Inkomstdeklaration 2–4', 'test', 'ccg_sysorg', 'SKV_INKFORETAG_API_BASE_URL', 'Taxonomi/XBRL-deklarationspaket. Exakt endpoint ska hållas konfigurerbar från RAML/API-definition.')
on conflict (service) do update set
  scope = excluded.scope,
  display_name = excluded.display_name,
  lifecycle_status = excluded.lifecycle_status,
  auth_flow = excluded.auth_flow,
  base_url_env_var = excluded.base_url_env_var,
  notes = excluded.notes,
  updated_at = now();

alter table public.skatteverket_api_requests enable row level security;
alter table public.skatteverket_service_catalog enable row level security;

drop policy if exists skatteverket_api_requests_select on public.skatteverket_api_requests;
create policy skatteverket_api_requests_select on public.skatteverket_api_requests
for select using (
  public.is_platform_admin()
  or (company_id is not null and public.user_can_access_company_v2(company_id))
);

drop policy if exists skatteverket_api_requests_write on public.skatteverket_api_requests;
create policy skatteverket_api_requests_write on public.skatteverket_api_requests
for all using (
  public.is_platform_admin()
  or (company_id is not null and public.user_can_access_company_v2(company_id))
) with check (
  public.is_platform_admin()
  or (company_id is not null and public.user_can_access_company_v2(company_id))
);

drop policy if exists skatteverket_service_catalog_read on public.skatteverket_service_catalog;
create policy skatteverket_service_catalog_read on public.skatteverket_service_catalog
for select using (auth.role() = 'authenticated' or public.is_platform_admin());

drop policy if exists skatteverket_service_catalog_admin on public.skatteverket_service_catalog;
create policy skatteverket_service_catalog_admin on public.skatteverket_service_catalog
for all using (public.is_platform_admin()) with check (public.is_platform_admin());

drop trigger if exists skatteverket_service_catalog_updated_at on public.skatteverket_service_catalog;
create trigger skatteverket_service_catalog_updated_at
before update on public.skatteverket_service_catalog
for each row execute function public.update_updated_at_column();

notify pgrst, 'reload schema';
