-- Nordklart SaaS/product foundation: plans, entitlements, one-time purchases,
-- year-end projects, Bankgiro/Autogiro onboarding, API scopes and webhooks.
-- This is platform/product metadata only. It does not change posted accounting.

-- -----------------------------------------------------------------------------
-- Products, plans and feature gates
-- -----------------------------------------------------------------------------
create table if not exists public.platform_products (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  product_type text not null check (product_type in ('subscription', 'one_time', 'addon')),
  status text not null default 'active' check (status in ('active', 'paused', 'archived')),
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.platform_price_plans (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.platform_products(id) on delete cascade,
  code text not null unique,
  name text not null,
  description text,
  billing_interval text not null default 'month' check (billing_interval in ('month', 'year', 'one_time')),
  currency text not null default 'SEK',
  price_excl_vat numeric(12,2) not null default 0,
  status text not null default 'active' check (status in ('active', 'paused', 'archived')),
  trial_days integer not null default 0 check (trial_days >= 0),
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.platform_features (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  category text not null default 'core',
  is_metered boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.platform_plan_features (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.platform_price_plans(id) on delete cascade,
  feature_id uuid not null references public.platform_features(id) on delete cascade,
  enabled boolean not null default true,
  limit_value numeric,
  limit_unit text,
  created_at timestamptz not null default now(),
  unique (plan_id, feature_id)
);

create table if not exists public.company_subscriptions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  plan_id uuid not null references public.platform_price_plans(id) on delete restrict,
  status text not null default 'trialing' check (status in ('trialing', 'active', 'past_due', 'paused', 'cancelled', 'expired')),
  starts_at timestamptz not null default now(),
  trial_ends_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancelled_at timestamptz,
  external_provider text,
  external_subscription_id text,
  override_note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_company_subscriptions_company_status on public.company_subscriptions(company_id, status);

create table if not exists public.company_entitlements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  feature_code text not null references public.platform_features(code) on delete cascade,
  source text not null check (source in ('plan', 'addon', 'one_time_purchase', 'manual_override')),
  source_id uuid,
  enabled boolean not null default true,
  limit_value numeric,
  limit_unit text,
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  granted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, feature_code, source, source_id)
);

create index if not exists idx_company_entitlements_company_feature on public.company_entitlements(company_id, feature_code) where enabled;

create table if not exists public.one_time_purchases (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  product_id uuid not null references public.platform_products(id) on delete restrict,
  purchase_type text not null check (purchase_type in ('year_end', 'bankgiro_setup', 'custom')),
  status text not null default 'pending_payment' check (status in ('pending_payment', 'paid', 'active', 'fulfilled', 'refunded', 'cancelled', 'expired')),
  fiscal_period_id uuid references public.fiscal_periods(id) on delete set null,
  price_excl_vat numeric(12,2) not null default 0,
  currency text not null default 'SEK',
  paid_at timestamptz,
  access_starts_at timestamptz,
  access_expires_at timestamptz,
  permanent_access boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_one_time_purchases_company_type on public.one_time_purchases(company_id, purchase_type, status);

create table if not exists public.billing_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  event_type text not null,
  source_table text,
  source_id uuid,
  amount_excl_vat numeric(12,2),
  currency text not null default 'SEK',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.usage_metering (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  feature_code text not null,
  usage_key text not null,
  quantity numeric(14,4) not null default 1,
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_usage_metering_company_feature_time on public.usage_metering(company_id, feature_code, occurred_at desc);

-- -----------------------------------------------------------------------------
-- Year-end as product/project
-- -----------------------------------------------------------------------------
create table if not exists public.year_end_projects (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  fiscal_period_id uuid not null references public.fiscal_periods(id) on delete cascade,
  purchase_id uuid references public.one_time_purchases(id) on delete set null,
  status text not null default 'draft' check (status in ('draft', 'in_progress', 'ready_for_review', 'approved', 'completed', 'locked', 'archived')),
  framework text not null default 'k2' check (framework in ('k1', 'k2', 'k3')),
  started_by uuid references auth.users(id) on delete set null,
  approved_by uuid references auth.users(id) on delete set null,
  completed_at timestamptz,
  locked_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(company_id, fiscal_period_id)
);

create table if not exists public.year_end_checks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.year_end_projects(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  check_code text not null,
  title text not null,
  status text not null default 'pending' check (status in ('pending', 'ok', 'warning', 'error', 'skipped')),
  severity text not null default 'info' check (severity in ('info', 'warning', 'blocking')),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id, check_code)
);

create table if not exists public.year_end_adjustments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.year_end_projects(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  journal_entry_id uuid references public.journal_entries(id) on delete set null,
  adjustment_type text not null,
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'posted', 'cancelled')),
  amount numeric(15,2),
  description text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.year_end_deliverables (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.year_end_projects(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  deliverable_type text not null check (deliverable_type in ('pdf_report', 'sie_export', 'ixbrl', 'tax_package', 'archive_package')),
  status text not null default 'draft' check (status in ('draft', 'generated', 'approved', 'sent', 'archived', 'error')),
  document_id uuid references public.document_attachments(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  generated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Bankgiro / Autogiro provider onboarding (separate from ordinary bookkeeping)
-- -----------------------------------------------------------------------------
create table if not exists public.payment_providers (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  provider_type text not null check (provider_type in ('bank_data', 'autogiro', 'bankgiro', 'payment_collection', 'file_import')),
  status text not null default 'active' check (status in ('active', 'paused', 'archived')),
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bankgiro_applications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  provider_id uuid references public.payment_providers(id) on delete set null,
  status text not null default 'draft' check (status in ('not_requested', 'draft', 'submitted', 'needs_information', 'under_review', 'approved', 'provider_setup', 'active', 'rejected', 'suspended')),
  requested_product text not null default 'bankgiro_autogiro',
  expected_monthly_volume numeric(14,2),
  expected_monthly_transactions integer,
  use_case text,
  kyb_data jsonb not null default '{}'::jsonb,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  provider_reference text,
  rejection_reason text,
  submitted_at timestamptz,
  activated_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bankgiro_application_documents (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.bankgiro_applications(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  document_id uuid references public.document_attachments(id) on delete set null,
  document_type text not null,
  status text not null default 'uploaded' check (status in ('uploaded', 'accepted', 'rejected')),
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.bankgiro_provider_status_events (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.bankgiro_applications(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  provider_status text not null,
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now()
);

create table if not exists public.payment_mandates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  provider_id uuid references public.payment_providers(id) on delete set null,
  customer_id uuid references public.customers(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'active', 'cancelled', 'expired', 'failed')),
  provider_reference text,
  payer_reference text,
  signed_at timestamptz,
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payment_collections (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  provider_id uuid references public.payment_providers(id) on delete set null,
  mandate_id uuid references public.payment_mandates(id) on delete set null,
  invoice_id uuid references public.invoices(id) on delete set null,
  amount numeric(15,2) not null,
  currency text not null default 'SEK',
  status text not null default 'draft' check (status in ('draft', 'submitted', 'settled', 'failed', 'cancelled', 'refunded')),
  provider_reference text,
  due_date date,
  settled_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payment_reconciliation_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  provider_id uuid references public.payment_providers(id) on delete set null,
  collection_id uuid references public.payment_collections(id) on delete set null,
  transaction_id uuid references public.transactions(id) on delete set null,
  status text not null default 'unmatched' check (status in ('unmatched', 'matched', 'booked', 'ignored')),
  amount numeric(15,2),
  reference text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- API clients, scopes and webhook delivery logs
-- -----------------------------------------------------------------------------
create table if not exists public.api_scopes (
  code text primary key,
  name text not null,
  description text,
  category text not null default 'core',
  created_at timestamptz not null default now()
);

create table if not exists public.api_client_scopes (
  id uuid primary key default gen_random_uuid(),
  api_key_id uuid not null references public.api_keys(id) on delete cascade,
  scope_code text not null references public.api_scopes(code) on delete cascade,
  created_at timestamptz not null default now(),
  unique(api_key_id, scope_code)
);

create table if not exists public.webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  url text not null,
  status text not null default 'active' check (status in ('active', 'paused', 'disabled')),
  signing_secret_hash text,
  event_types text[] not null default '{}',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null references public.webhook_endpoints(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'delivered', 'failed', 'abandoned')),
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- RLS: platform metadata is admin-readable/writeable; company rows are tenant-safe.
-- -----------------------------------------------------------------------------
alter table public.platform_products enable row level security;
alter table public.platform_price_plans enable row level security;
alter table public.platform_features enable row level security;
alter table public.platform_plan_features enable row level security;
alter table public.company_subscriptions enable row level security;
alter table public.company_entitlements enable row level security;
alter table public.one_time_purchases enable row level security;
alter table public.billing_events enable row level security;
alter table public.usage_metering enable row level security;
alter table public.year_end_projects enable row level security;
alter table public.year_end_checks enable row level security;
alter table public.year_end_adjustments enable row level security;
alter table public.year_end_deliverables enable row level security;
alter table public.payment_providers enable row level security;
alter table public.bankgiro_applications enable row level security;
alter table public.bankgiro_application_documents enable row level security;
alter table public.bankgiro_provider_status_events enable row level security;
alter table public.payment_mandates enable row level security;
alter table public.payment_collections enable row level security;
alter table public.payment_reconciliation_items enable row level security;
alter table public.api_scopes enable row level security;
alter table public.api_client_scopes enable row level security;
alter table public.webhook_endpoints enable row level security;
alter table public.webhook_deliveries enable row level security;

-- Platform/public catalog can be read by authenticated users; only platform admin writes.
do $$
declare
  t text;
begin
  foreach t in array array['platform_products','platform_price_plans','platform_features','platform_plan_features','payment_providers','api_scopes'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select using (auth.uid() is not null)', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_admin_write', t);
    execute format('create policy %I on public.%I for all using (public.is_platform_admin()) with check (public.is_platform_admin())', t || '_admin_write', t);
  end loop;
end $$;

-- Company scoped tables: readable/writable by company access and platform admin.
do $$
declare
  t text;
begin
  foreach t in array array[
    'company_subscriptions','company_entitlements','one_time_purchases','billing_events','usage_metering',
    'year_end_projects','year_end_checks','year_end_adjustments','year_end_deliverables',
    'bankgiro_applications','bankgiro_application_documents','bankgiro_provider_status_events',
    'payment_mandates','payment_collections','payment_reconciliation_items','webhook_endpoints','webhook_deliveries'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select using (public.user_can_access_company_v2(company_id))', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format('create policy %I on public.%I for all using (public.user_can_access_company_v2(company_id)) with check (public.user_can_access_company_v2(company_id))', t || '_write', t);
  end loop;
end $$;

-- API client scopes are tied to api_keys.company_id.
drop policy if exists api_client_scopes_select on public.api_client_scopes;
create policy api_client_scopes_select on public.api_client_scopes for select using (
  exists (select 1 from public.api_keys k where k.id = api_client_scopes.api_key_id and public.user_can_access_company_v2(k.company_id))
);
drop policy if exists api_client_scopes_write on public.api_client_scopes;
create policy api_client_scopes_write on public.api_client_scopes for all using (
  exists (select 1 from public.api_keys k where k.id = api_client_scopes.api_key_id and public.user_can_access_company_v2(k.company_id))
) with check (
  exists (select 1 from public.api_keys k where k.id = api_client_scopes.api_key_id and public.user_can_access_company_v2(k.company_id))
);

-- Updated-at triggers for mutable product tables.
do $$
declare
  t text;
begin
  foreach t in array array[
    'platform_products','platform_price_plans','platform_features','company_subscriptions','company_entitlements',
    'one_time_purchases','year_end_projects','year_end_checks','year_end_adjustments','year_end_deliverables',
    'payment_providers','bankgiro_applications','payment_mandates','payment_collections','payment_reconciliation_items',
    'webhook_endpoints','webhook_deliveries'
  ] loop
    execute format('drop trigger if exists %I on public.%I', t || '_updated_at', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.update_updated_at_column()', t || '_updated_at', t);
  end loop;
end $$;

-- Audit critical commercial/product operations.
do $$
declare
  t text;
begin
  foreach t in array array[
    'company_subscriptions','company_entitlements','one_time_purchases','year_end_projects','year_end_adjustments',
    'bankgiro_applications','payment_mandates','payment_collections','webhook_endpoints'
  ] loop
    execute format('drop trigger if exists %I on public.%I', t || '_audit', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.write_audit_log()', t || '_audit', t);
  end loop;
end $$;

-- Seed Nordklart default product model and API scopes. No company subscription
-- is activated here; superadmin/checkout must create that explicitly.
insert into public.platform_products (code, name, description, product_type, sort_order) values
  ('start', 'Nordklart Start', 'Bokföring, fakturor, moms och grundrapporter.', 'subscription', 10),
  ('auto', 'Nordklart Auto', 'Automatisering via banktransaktioner och granskningskö.', 'subscription', 20),
  ('agency', 'Nordklart Byrå', 'Byrådashboard, kundbolag, team och deadlines.', 'subscription', 30),
  ('year_end', 'Nordklart Bokslut', 'Bokslut, kontroller och exportpaket som engångsköp eller modul.', 'one_time', 40),
  ('bankgiro', 'Nordklart Bankgiro', 'Bankgiro/Autogiro-onboarding och betalavstämning.', 'addon', 50)
on conflict (code) do update set name = excluded.name, description = excluded.description, product_type = excluded.product_type, sort_order = excluded.sort_order;

insert into public.platform_features (code, name, category, description) values
  ('bookkeeping.core', 'Bokföring', 'core', 'Verifikationer, BAS, moms och rapporter.'),
  ('invoicing.core', 'Fakturering', 'core', 'Kundfakturor och artikelregister.'),
  ('reports.core', 'Rapporter', 'core', 'Resultat, balans, huvudbok, moms och SIE.'),
  ('bank.automation', 'Bankautomation', 'automation', 'Bankkoppling, matchning, regler och granskning.'),
  ('agency.clients', 'Byråkunder', 'agency', 'Redovisningsbyrå kan hantera flera kundbolag.'),
  ('year_end.projects', 'Bokslutsprojekt', 'year_end', 'Bokslut, kontroller, justeringar och exportpaket.'),
  ('year_end.ixbrl', 'Digital årsredovisning', 'year_end', 'iXBRL och Bolagsverket-förberedelse.'),
  ('bankgiro.onboarding', 'Bankgiro/Autogiro', 'payments', 'Separat onboarding för betalprovider.'),
  ('api.access', 'API', 'api', 'API-nycklar, scopes och idempotency.'),
  ('webhooks.delivery', 'Webhooks', 'api', 'Signerade webhooks med leveranslogg.')
on conflict (code) do update set name = excluded.name, category = excluded.category, description = excluded.description;

insert into public.api_scopes (code, name, category, description) values
  ('companies.read', 'Läsa bolag', 'companies', 'Läsa bolagsuppgifter.'),
  ('companies.write', 'Ändra bolag', 'companies', 'Skapa och uppdatera bolagsuppgifter.'),
  ('accounting.read', 'Läsa bokföring', 'accounting', 'Läsa konton, verifikationer och rapportdata.'),
  ('accounting.write', 'Skapa bokföring', 'accounting', 'Skapa verifikationer via API med period- och balanskontroller.'),
  ('invoices.read', 'Läsa fakturor', 'invoicing', 'Läsa kundfakturor och artiklar.'),
  ('invoices.write', 'Skapa fakturor', 'invoicing', 'Skapa och uppdatera fakturor/artiklar.'),
  ('bank.read', 'Läsa bankdata', 'bank', 'Läsa bankkonton och transaktioner.'),
  ('bank.write', 'Importera bankdata', 'bank', 'Importera banktransaktioner och matchningar.'),
  ('reports.read', 'Läsa rapporter', 'reports', 'Hämta rapporter, SIE och exportdata.'),
  ('year_end.read', 'Läsa bokslut', 'year_end', 'Läsa bokslutsprojekt, kontroller och exportpaket.'),
  ('year_end.write', 'Hantera bokslut', 'year_end', 'Skapa bokslutsprojekt och justeringar.'),
  ('bankgiro.read', 'Läsa Bankgiro-status', 'payments', 'Läsa Bankgiro/Autogiro-ansökningar och status.'),
  ('bankgiro.write', 'Hantera Bankgiro', 'payments', 'Skapa och uppdatera Bankgiro/Autogiro-ansökningar.'),
  ('webhooks.read', 'Läsa webhooks', 'api', 'Läsa endpoints och leveranser.'),
  ('webhooks.write', 'Hantera webhooks', 'api', 'Skapa och ändra webhook endpoints.')
on conflict (code) do update set name = excluded.name, category = excluded.category, description = excluded.description;

notify pgrst, 'reload schema';
