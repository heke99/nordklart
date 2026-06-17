-- Nordklart Batch 8–11: year-end product, Skatteverket flow,
-- Bankgiro/Autogiro providers, API clients and webhook catalog.
-- Safe additive migration: no changes to posted journal entries or locked periods.

create extension if not exists pgcrypto;

-- ─────────────────────────────────────────────────────────────────────────────
-- Batch 8 — Bokslut som produkt
-- ─────────────────────────────────────────────────────────────────────────────

alter table if exists public.year_end_projects
  add column if not exists source text not null default 'bookkeeping_module'
    check (source in ('bookkeeping_module','one_time_purchase','agency','api','import')),
  add column if not exists readiness_score integer check (readiness_score between 0 and 100),
  add column if not exists requires_purchase boolean not null default false,
  add column if not exists access_source text not null default 'subscription'
    check (access_source in ('subscription','one_time_purchase','manual_override','trial')),
  add column if not exists export_package_status text not null default 'not_started'
    check (export_package_status in ('not_started','building','ready','failed')),
  add column if not exists locked_at timestamptz,
  add column if not exists locked_by uuid references auth.users(id),
  add column if not exists last_check_at timestamptz,
  add column if not exists next_action text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create table if not exists public.year_end_purchase_access (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  one_time_purchase_id uuid references public.one_time_purchases(id) on delete set null,
  year_end_project_id uuid references public.year_end_projects(id) on delete cascade,
  fiscal_period_id uuid,
  access_status text not null default 'active'
    check (access_status in ('active','expired','revoked')),
  permanent_access boolean not null default true,
  access_starts_at timestamptz not null default now(),
  access_expires_at timestamptz,
  created_by uuid references auth.users(id),
  revoked_by uuid references auth.users(id),
  revoked_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint year_end_purchase_access_unique unique (company_id, year_end_project_id, one_time_purchase_id)
);

create index if not exists year_end_purchase_access_company_idx on public.year_end_purchase_access(company_id, access_status);
create index if not exists year_end_projects_company_status_idx on public.year_end_projects(company_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- Batch 9 — Skatteverket
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.skatteverket_company_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,
  connection_status text not null default 'not_connected'
    check (connection_status in ('not_connected','connected','needs_reauth','disabled')),
  token_status text not null default 'missing'
    check (token_status in ('missing','valid','expiring','expired','revoked')),
  oauth_connected_at timestamptz,
  last_token_check_at timestamptz,
  requires_signing boolean not null default true,
  vat_registered boolean,
  default_submitter_name text,
  default_submitter_email text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tax_submissions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  fiscal_period_id uuid,
  submission_type text not null
    check (submission_type in ('vat_return','agi','skattekonto_reconciliation','income_tax','other')),
  period_key text,
  status text not null default 'draft'
    check (status in ('draft','prepared','sent_to_skatteverket','waiting_for_signature','signed_submitted','receipt_received','failed','cancelled')),
  requires_signature boolean not null default true,
  amount numeric(14,2),
  currency text not null default 'SEK',
  payload jsonb not null default '{}'::jsonb,
  skatteverket_reference text,
  receipt_reference text,
  receipt_payload jsonb,
  error_message text,
  prepared_by uuid references auth.users(id),
  prepared_at timestamptz,
  sent_by uuid references auth.users(id),
  sent_at timestamptz,
  signed_by uuid references auth.users(id),
  signed_at timestamptz,
  receipt_received_at timestamptz,
  due_date date,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tax_submission_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  tax_submission_id uuid not null references public.tax_submissions(id) on delete cascade,
  event_type text not null,
  status_from text,
  status_to text,
  message text,
  payload jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.skatteverket_deadlines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  submission_type text not null
    check (submission_type in ('vat_return','agi','skattekonto_reconciliation','income_tax','other')),
  period_key text not null,
  due_date date not null,
  status text not null default 'open'
    check (status in ('open','prepared','submitted','missed','not_required')),
  source text not null default 'manual'
    check (source in ('manual','skatteverket','system')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint skatteverket_deadlines_unique unique(company_id, submission_type, period_key)
);

create index if not exists tax_submissions_company_status_idx on public.tax_submissions(company_id, submission_type, status, due_date);
create index if not exists tax_submission_events_company_idx on public.tax_submission_events(company_id, tax_submission_id, created_at desc);
create index if not exists skatteverket_deadlines_company_due_idx on public.skatteverket_deadlines(company_id, due_date, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- Batch 10 — Bankgiro/Autogiro provider module
-- ─────────────────────────────────────────────────────────────────────────────

alter table if exists public.payment_providers
  add column if not exists adapter_key text,
  add column if not exists capabilities jsonb not null default '[]'::jsonb,
  add column if not exists sandbox_supported boolean not null default true,
  add column if not exists setup_requirements jsonb not null default '{}'::jsonb;

alter table if exists public.bankgiro_applications
  add column if not exists beneficial_owners jsonb not null default '[]'::jsonb,
  add column if not exists company_questions jsonb not null default '{}'::jsonb,
  add column if not exists volume_answers jsonb not null default '{}'::jsonb,
  add column if not exists documents_status text not null default 'not_started'
    check (documents_status in ('not_started','incomplete','ready','rejected')),
  add column if not exists provider_setup_status text not null default 'not_started'
    check (provider_setup_status in ('not_started','waiting_provider','active','failed','paused')),
  add column if not exists risk_score integer check (risk_score between 0 and 100),
  add column if not exists superadmin_note text;

create table if not exists public.payment_provider_accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  payment_provider_id uuid references public.payment_providers(id) on delete set null,
  bankgiro_application_id uuid references public.bankgiro_applications(id) on delete set null,
  provider_account_ref text,
  display_name text not null,
  status text not null default 'draft'
    check (status in ('draft','pending','active','suspended','closed')),
  capabilities jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  activated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payment_collection_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  payment_collection_id uuid references public.payment_collections(id) on delete cascade,
  event_type text not null,
  status_from text,
  status_to text,
  message text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists payment_provider_accounts_company_idx on public.payment_provider_accounts(company_id, status);
create index if not exists payment_collection_events_company_idx on public.payment_collection_events(company_id, created_at desc);

insert into public.payment_providers (code, name, provider_type, status, adapter_key, capabilities, sandbox_supported, setup_requirements)
values
  ('gocardless_autogiro', 'GoCardless Autogiro', 'autogiro', 'active', 'gocardless_autogiro', '["mandates","collections","reconciliation"]'::jsonb, true, '{"requires_provider_contract":true}'::jsonb),
  ('leslie', 'Leslie', 'payment_collection', 'active', 'leslie', '["bankgiro_application","provider_setup","reconciliation"]'::jsonb, true, '{"requires_manual_review":true}'::jsonb),
  ('bankgiro_file', 'Bankgiro filimport', 'file_import', 'active', 'bankgiro_file', '["bankgiro_files","reconciliation"]'::jsonb, false, '{"requires_existing_bankgiro":true}'::jsonb),
  ('future_payment_provider', 'Framtida betalpartner', 'payment_collection', 'paused', 'future_payment_provider', '[]'::jsonb, true, '{}'::jsonb)
on conflict (code) do update set
  name = excluded.name,
  provider_type = excluded.provider_type,
  adapter_key = excluded.adapter_key,
  capabilities = excluded.capabilities,
  sandbox_supported = excluded.sandbox_supported,
  setup_requirements = excluded.setup_requirements,
  updated_at = now();

-- ─────────────────────────────────────────────────────────────────────────────
-- Batch 11 — API clients and webhook catalog
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.api_clients (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  agency_id uuid references public.agencies(id) on delete set null,
  name text not null,
  mode text not null default 'test' check (mode in ('test','live')),
  status text not null default 'active' check (status in ('active','disabled','revoked')),
  allowed_origins text[] not null default '{}',
  created_by uuid references auth.users(id),
  last_used_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.webhook_events (
  code text primary key,
  category text not null,
  description text not null,
  payload_schema jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active','planned','deprecated')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists public.webhook_endpoints
  add column if not exists mode text not null default 'test' check (mode in ('test','live')),
  add column if not exists api_version text not null default '2026-05-12',
  add column if not exists failure_count integer not null default 0,
  add column if not exists last_delivery_at timestamptz,
  add column if not exists last_error text;

alter table if exists public.webhook_deliveries
  add column if not exists request_id text,
  add column if not exists response_status integer,
  add column if not exists response_body text,
  add column if not exists signature text,
  add column if not exists next_retry_at timestamptz;

insert into public.webhook_events (code, category, description, status) values
  ('company.created', 'company', 'Ett bolag har skapats.', 'active'),
  ('company.activated', 'company', 'Ett bolag är aktiverat.', 'active'),
  ('agency.created', 'agency', 'En redovisningsbyrå har skapats.', 'active'),
  ('agency.client_added', 'agency', 'Ett kundbolag har lagts till i en byrå.', 'active'),
  ('subscription.started', 'billing', 'Ett abonnemang har startats.', 'active'),
  ('subscription.changed', 'billing', 'Ett abonnemang har ändrats.', 'active'),
  ('one_time_purchase.created', 'billing', 'Ett engångsköp har skapats.', 'active'),
  ('year_end.started', 'year_end', 'Ett bokslutsprojekt har startats.', 'active'),
  ('year_end.ready_for_review', 'year_end', 'Bokslutet är redo för granskning.', 'active'),
  ('year_end.completed', 'year_end', 'Bokslutet är klart.', 'active'),
  ('bank_connection.created', 'bank', 'En bankkoppling har skapats.', 'active'),
  ('bank_connection.expired', 'bank', 'En bankkoppling har löpt ut.', 'active'),
  ('bank_transaction.imported', 'bank', 'En banktransaktion har importerats.', 'active'),
  ('bank_transaction.auto_booked', 'automation', 'En banktransaktion har autobokförts.', 'active'),
  ('bank_transaction.needs_review', 'automation', 'En banktransaktion behöver granskas.', 'active'),
  ('journal_entry.created', 'bookkeeping', 'En verifikation har skapats.', 'active'),
  ('invoice.paid', 'invoicing', 'En faktura har markerats betald.', 'active'),
  ('supplier_invoice.matched', 'suppliers', 'En leverantörsfaktura har matchats.', 'active'),
  ('vat_return.ready', 'tax', 'En momsrapport är redo.', 'active'),
  ('vat_return.submitted', 'tax', 'En momsdeklaration har skickats.', 'active'),
  ('skatteverket.submission.failed', 'tax', 'En Skatteverket-inlämning misslyckades.', 'active'),
  ('bankgiro_application.submitted', 'bankgiro', 'En Bankgiro/Autogiro-ansökan har skickats in.', 'active'),
  ('bankgiro_application.approved', 'bankgiro', 'En Bankgiro/Autogiro-ansökan har godkänts.', 'active'),
  ('bankgiro_application.rejected', 'bankgiro', 'En Bankgiro/Autogiro-ansökan har avslagits.', 'active'),
  ('payment_provider.activated', 'payments', 'En betalprovider är aktiv för bolaget.', 'active')
on conflict (code) do update set
  category = excluded.category,
  description = excluded.description,
  status = excluded.status,
  updated_at = now();

-- Colon-scopes are used by the v1 API key runtime. Dot-scopes are kept for UI/catalog compatibility.
insert into public.api_scopes (code, name, description) values
  ('year_end:read', 'Bokslut — läs', 'Läsa bokslutsprojekt, kontroller och exportstatus via API.'),
  ('year_end:write', 'Bokslut — skriv', 'Starta bokslutsprojekt och uppdatera bokslutsflöden via API.'),
  ('tax:read', 'Skatteverket — läs', 'Läsa moms-/skatteinlämningar och status via API.'),
  ('tax:write', 'Skatteverket — skriv', 'Förbereda inlämningar och uppdatera status via API.'),
  ('bankgiro:read', 'Bankgiro — läs', 'Läsa Bankgiro/Autogiro-ansökningar, mandat och betalstatus via API.'),
  ('bankgiro:write', 'Bankgiro — skriv', 'Skapa ansökningar och uppdatera betalproviderflöden via API.'),
  ('webhook_events:read', 'Webhook-events — läs', 'Läsa Nordklarts webhook-eventkatalog.')
on conflict (code) do update set name = excluded.name, description = excluded.description;

insert into public.platform_features (code, name, description, category) values
  ('year_end.product', 'Bokslut som produkt', 'Bokslut som abonnemangsmodul och engångsköp.', 'year_end'),
  ('year_end.one_time_purchase', 'Bokslut engångsköp', 'Separat bokslutsaccess utan månadsabonnemang.', 'year_end'),
  ('skatteverket.submissions', 'Skatteverket-inlämningar', 'Momsdeklarationer, signeringsstatus och kvittenser.', 'tax'),
  ('bankgiro.provider_module', 'Bankgiro/Autogiro providers', 'Ansökan, provider setup, mandat och avstämning.', 'payments'),
  ('api.webhooks', 'API & Webhooks', 'API-klienter, webhook endpoints, retries och signering.', 'integrations')
on conflict (code) do update set
  name = excluded.name,
  description = excluded.description,
  category = excluded.category,
  updated_at = now();

insert into public.platform_plan_features (plan_id, feature_id, enabled)
select pp.id, pf.id, true
from public.platform_price_plans pp
join public.platform_products pr on pr.id = pp.product_id
join public.platform_features pf on pf.code in ('api.webhooks')
where pr.code in ('nordklart_start','nordklart_auto','nordklart_byra','nordklart_bokslut','nordklart_bankgiro')
on conflict (plan_id, feature_id) do update set enabled = excluded.enabled;

insert into public.platform_plan_features (plan_id, feature_id, enabled)
select pp.id, pf.id, true
from public.platform_price_plans pp
join public.platform_products pr on pr.id = pp.product_id
join public.platform_features pf on pf.code in ('year_end.product','year_end.one_time_purchase')
where pr.code in ('nordklart_byra','nordklart_bokslut')
on conflict (plan_id, feature_id) do update set enabled = excluded.enabled;

insert into public.platform_plan_features (plan_id, feature_id, enabled)
select pp.id, pf.id, true
from public.platform_price_plans pp
join public.platform_products pr on pr.id = pp.product_id
join public.platform_features pf on pf.code in ('skatteverket.submissions')
where pr.code in ('nordklart_start','nordklart_auto','nordklart_byra','nordklart_bokslut')
on conflict (plan_id, feature_id) do update set enabled = excluded.enabled;

insert into public.platform_plan_features (plan_id, feature_id, enabled)
select pp.id, pf.id, true
from public.platform_price_plans pp
join public.platform_products pr on pr.id = pp.product_id
join public.platform_features pf on pf.code in ('bankgiro.provider_module')
where pr.code in ('nordklart_bankgiro','nordklart_byra','nordklart_auto')
on conflict (plan_id, feature_id) do update set enabled = excluded.enabled;

-- Views for dashboard/API overview surfaces.
create or replace view public.year_end_project_overview_v
with (security_invoker = true) as
select
  yep.id,
  yep.company_id,
  c.name as company_name,
  yep.fiscal_period_id,
  yep.status,
  yep.source,
  yep.readiness_score,
  yep.requires_purchase,
  yep.access_source,
  yep.export_package_status,
  yep.next_action,
  yep.updated_at,
  count(yec.id) filter (where yec.status in ('warning','error')) as open_check_count,
  count(yed.id) filter (where yed.status in ('generated','approved','sent','archived')) as ready_deliverable_count
from public.year_end_projects yep
join public.companies c on c.id = yep.company_id
left join public.year_end_checks yec on yec.project_id = yep.id
left join public.year_end_deliverables yed on yed.project_id = yep.id
group by yep.id, c.name;

create or replace view public.skatteverket_submission_overview_v
with (security_invoker = true) as
select
  ts.id,
  ts.company_id,
  c.name as company_name,
  ts.submission_type,
  ts.period_key,
  ts.status,
  ts.requires_signature,
  ts.due_date,
  ts.skatteverket_reference,
  ts.receipt_reference,
  ts.error_message,
  ts.updated_at
from public.tax_submissions ts
join public.companies c on c.id = ts.company_id;

create or replace view public.bankgiro_payment_overview_v
with (security_invoker = true) as
select
  ba.id,
  ba.company_id,
  c.name as company_name,
  ba.status,
  ba.provider_setup_status,
  ba.documents_status,
  ba.risk_score,
  ba.provider_id,
  pp.name as provider_name,
  ba.updated_at
from public.bankgiro_applications ba
join public.companies c on c.id = ba.company_id
left join public.payment_providers pp on pp.id = ba.provider_id;

create or replace view public.api_webhook_overview_v
with (security_invoker = true) as
select
  we.company_id,
  count(*) as endpoint_count,
  count(*) filter (where we.status = 'active') as active_endpoint_count,
  coalesce(sum(we.failure_count), 0) as failure_count,
  max(we.last_delivery_at) as last_delivery_at
from public.webhook_endpoints we
group by we.company_id;

-- RLS and policies
alter table public.year_end_purchase_access enable row level security;
alter table public.skatteverket_company_settings enable row level security;
alter table public.tax_submissions enable row level security;
alter table public.tax_submission_events enable row level security;
alter table public.skatteverket_deadlines enable row level security;
alter table public.payment_provider_accounts enable row level security;
alter table public.payment_collection_events enable row level security;
alter table public.api_clients enable row level security;
alter table public.webhook_events enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'year_end_purchase_access','skatteverket_company_settings','tax_submissions','tax_submission_events',
    'skatteverket_deadlines','payment_provider_accounts','payment_collection_events','api_clients'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format('create policy %I on public.%I for select using (public.user_can_access_company_v2(company_id) or public.is_platform_admin())', t || '_select', t);
    execute format('create policy %I on public.%I for all using (public.user_can_access_company_v2(company_id) or public.is_platform_admin()) with check (public.user_can_access_company_v2(company_id) or public.is_platform_admin())', t || '_write', t);
  end loop;
end $$;

drop policy if exists webhook_events_read on public.webhook_events;
create policy webhook_events_read on public.webhook_events for select using (auth.role() = 'authenticated' or public.is_platform_admin());

drop policy if exists webhook_events_admin on public.webhook_events;
create policy webhook_events_admin on public.webhook_events for all using (public.is_platform_admin()) with check (public.is_platform_admin());

do $$
declare
  t text;
begin
  foreach t in array array[
    'year_end_purchase_access','skatteverket_company_settings','tax_submissions','skatteverket_deadlines',
    'payment_provider_accounts','api_clients','webhook_events'
  ] loop
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t and column_name = 'updated_at'
    ) then
      execute format('drop trigger if exists %I on public.%I', t || '_updated_at', t);
      execute format('create trigger %I before update on public.%I for each row execute function public.update_updated_at_column()', t || '_updated_at', t);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
