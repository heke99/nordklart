-- Nordklart batches 4-7: product gates, onboarding paths, agency operations and bank automation.
-- Non-destructive foundation only: posted accounting, locked periods and historical vouchers are untouched.

-- -----------------------------------------------------------------------------
-- Batch 4: price plans, entitlements and feature gates
-- -----------------------------------------------------------------------------

alter table public.platform_price_plans
  add column if not exists monthly_included_clients integer,
  add column if not exists target_audience text,
  add column if not exists is_default boolean not null default false;

alter table public.platform_features
  add column if not exists risk_level text not null default 'normal' check (risk_level in ('low', 'normal', 'high')),
  add column if not exists requires_human_review boolean not null default false;

insert into public.platform_price_plans (
  product_id, code, name, description, billing_interval, currency, price_excl_vat,
  status, trial_days, sort_order, monthly_included_clients, target_audience, is_default
)
select p.id, v.code, v.name, v.description, v.billing_interval, 'SEK', v.price_excl_vat,
       'active', v.trial_days, v.sort_order, v.monthly_included_clients, v.target_audience, v.is_default
from (values
  ('start_monthly', 'start', 'Nordklart Start', 'Bokföring, fakturor, momsrapport, resultat, balans och SIE-export.', 'month', 299::numeric, 14, 10, 1, 'single_company', true),
  ('auto_monthly', 'auto', 'Nordklart Auto', 'Start plus bankkoppling, transaktionsimport, matchningsregler och granskningskö.', 'month', 599::numeric, 14, 20, 1, 'automation', false),
  ('agency_monthly', 'agency', 'Nordklart Byrå', 'Byrådashboard, flera kundbolag, teamroller, deadlines och gemensam granskningskö.', 'month', 1499::numeric, 14, 30, 20, 'accounting_agency', false),
  ('year_end_one_time', 'year_end', 'Nordklart Bokslut', 'Bokslutsprojekt, kontroller, justeringar och exportpaket för ett räkenskapsår.', 'one_time', 2495::numeric, 0, 40, 1, 'year_end_only', false),
  ('bankgiro_addon_monthly', 'bankgiro', 'Nordklart Bankgiro', 'Bankgiro/Autogiro-onboarding, providerstatus och betalavstämning.', 'month', 299::numeric, 0, 50, 1, 'payments_addon', false)
) as v(code, product_code, name, description, billing_interval, price_excl_vat, trial_days, sort_order, monthly_included_clients, target_audience, is_default)
join public.platform_products p on p.code = v.product_code
on conflict (code) do update set
  name = excluded.name,
  description = excluded.description,
  billing_interval = excluded.billing_interval,
  price_excl_vat = excluded.price_excl_vat,
  trial_days = excluded.trial_days,
  sort_order = excluded.sort_order,
  monthly_included_clients = excluded.monthly_included_clients,
  target_audience = excluded.target_audience,
  is_default = excluded.is_default,
  updated_at = now();

insert into public.platform_features (code, name, category, description, risk_level, requires_human_review) values
  ('onboarding.paths', 'Onboardingvägar', 'onboarding', 'Bokföring direkt, automatisk bokföring, bokslut och Bankgiro/Autogiro.', 'low', false),
  ('agency.deadlines', 'Byrådeadlines', 'agency', 'Deadlines, momsstatus, bokslutsstatus och ansvarig konsult per klient.', 'normal', false),
  ('agency.review_queue', 'Gemensam granskningskö', 'agency', 'Byråns samlade kö för banktransaktioner och automation som behöver mänsklig granskning.', 'normal', true),
  ('bank.provider_model', 'Bankprovider-modell', 'automation', 'Provider-oberoende bankkoppling för GoCardless Bank Account Data, filimport och framtida leverantörer.', 'normal', false),
  ('bank.transaction_ingest', 'Transaktionsimport', 'automation', 'Dedupe och normaliserad import av banktransaktioner.', 'normal', false),
  ('bank.matching', 'Matchning och confidence', 'automation', 'Regelbaserad matchning mot OCR, faktura, motpart, belopp och historik.', 'high', true),
  ('bank.autobook', 'Säker autobokföring', 'automation', 'Autobokföring endast när confidence, risknivå och regel tillåter det.', 'high', true)
on conflict (code) do update set
  name = excluded.name,
  category = excluded.category,
  description = excluded.description,
  risk_level = excluded.risk_level,
  requires_human_review = excluded.requires_human_review,
  updated_at = now();

with mapping(plan_code, feature_code, limit_value, limit_unit) as (
  values
    ('start_monthly', 'bookkeeping.core', null::numeric, null::text),
    ('start_monthly', 'invoicing.core', null, null),
    ('start_monthly', 'reports.core', null, null),
    ('start_monthly', 'onboarding.paths', null, null),
    ('auto_monthly', 'bookkeeping.core', null, null),
    ('auto_monthly', 'invoicing.core', null, null),
    ('auto_monthly', 'reports.core', null, null),
    ('auto_monthly', 'onboarding.paths', null, null),
    ('auto_monthly', 'bank.automation', null, null),
    ('auto_monthly', 'bank.provider_model', null, null),
    ('auto_monthly', 'bank.transaction_ingest', null, null),
    ('auto_monthly', 'bank.matching', null, null),
    ('agency_monthly', 'bookkeeping.core', null, null),
    ('agency_monthly', 'invoicing.core', null, null),
    ('agency_monthly', 'reports.core', null, null),
    ('agency_monthly', 'onboarding.paths', null, null),
    ('agency_monthly', 'bank.automation', null, null),
    ('agency_monthly', 'bank.provider_model', null, null),
    ('agency_monthly', 'bank.transaction_ingest', null, null),
    ('agency_monthly', 'bank.matching', null, null),
    ('agency_monthly', 'agency.clients', 20, 'included_clients'),
    ('agency_monthly', 'agency.deadlines', null, null),
    ('agency_monthly', 'agency.review_queue', null, null),
    ('year_end_one_time', 'year_end.projects', 1, 'fiscal_year'),
    ('year_end_one_time', 'year_end.ixbrl', 1, 'fiscal_year'),
    ('bankgiro_addon_monthly', 'bankgiro.onboarding', null, null)
)
insert into public.platform_plan_features (plan_id, feature_id, enabled, limit_value, limit_unit)
select pp.id, pf.id, true, m.limit_value, m.limit_unit
from mapping m
join public.platform_price_plans pp on pp.code = m.plan_code
join public.platform_features pf on pf.code = m.feature_code
on conflict (plan_id, feature_id) do update set
  enabled = true,
  limit_value = excluded.limit_value,
  limit_unit = excluded.limit_unit;

create or replace function public.company_has_feature(p_company_id uuid, p_feature_code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.company_entitlements ce
    where ce.company_id = p_company_id
      and ce.feature_code = p_feature_code
      and ce.enabled = true
      and ce.starts_at <= now()
      and (ce.expires_at is null or ce.expires_at > now())
  )
  or exists (
    select 1
    from public.company_subscriptions cs
    join public.platform_plan_features ppf on ppf.plan_id = cs.plan_id and ppf.enabled = true
    join public.platform_features pf on pf.id = ppf.feature_id
    where cs.company_id = p_company_id
      and cs.status in ('trialing', 'active')
      and pf.code = p_feature_code
      and cs.starts_at <= now()
      and (cs.trial_ends_at is null or cs.status <> 'trialing' or cs.trial_ends_at > now())
      and (cs.current_period_end is null or cs.current_period_end > now())
  );
$$;

grant execute on function public.company_has_feature(uuid, text) to authenticated;

create or replace function public.sync_subscription_entitlements()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.company_entitlements (
    company_id, feature_code, source, source_id, enabled, limit_value, limit_unit, starts_at, expires_at, granted_by
  )
  select
    new.company_id,
    pf.code,
    'plan',
    new.id,
    new.status in ('trialing', 'active'),
    ppf.limit_value,
    ppf.limit_unit,
    new.starts_at,
    coalesce(new.current_period_end, new.trial_ends_at),
    new.created_by
  from public.platform_plan_features ppf
  join public.platform_features pf on pf.id = ppf.feature_id
  where ppf.plan_id = new.plan_id
  on conflict (company_id, feature_code, source, source_id) do update set
    enabled = excluded.enabled,
    limit_value = excluded.limit_value,
    limit_unit = excluded.limit_unit,
    starts_at = excluded.starts_at,
    expires_at = excluded.expires_at,
    updated_at = now();

  return new;
end;
$$;

drop trigger if exists company_subscriptions_sync_entitlements on public.company_subscriptions;
create trigger company_subscriptions_sync_entitlements
  after insert or update on public.company_subscriptions
  for each row execute function public.sync_subscription_entitlements();

create or replace view public.company_feature_access_v
with (security_invoker = true)
as
select
  c.id as company_id,
  f.code as feature_code,
  f.name as feature_name,
  f.category,
  f.risk_level,
  public.company_has_feature(c.id, f.code) as enabled,
  coalesce(max(ce.limit_value), max(ppf.limit_value)) as limit_value,
  coalesce(max(ce.limit_unit), max(ppf.limit_unit)) as limit_unit
from public.companies c
cross join public.platform_features f
left join public.company_entitlements ce
  on ce.company_id = c.id
 and ce.feature_code = f.code
 and ce.enabled = true
 and ce.starts_at <= now()
 and (ce.expires_at is null or ce.expires_at > now())
left join public.company_subscriptions cs
  on cs.company_id = c.id
 and cs.status in ('trialing', 'active')
left join public.platform_plan_features ppf
  on ppf.plan_id = cs.plan_id
 and ppf.enabled = true
left join public.platform_features pf2
  on pf2.id = ppf.feature_id
 and pf2.code = f.code
where public.user_can_access_company_v2(c.id)
group by c.id, f.code, f.name, f.category, f.risk_level;

revoke all on public.company_feature_access_v from anon;
grant select on public.company_feature_access_v to authenticated;

-- -----------------------------------------------------------------------------
-- Batch 5: onboarding router and flow status
-- -----------------------------------------------------------------------------

create table if not exists public.onboarding_sessions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  path text not null check (path in ('bookkeeping_direct', 'bank_automation', 'year_end_one_time', 'bankgiro_autogiro')),
  status text not null default 'draft' check (status in ('draft', 'in_progress', 'completed', 'abandoned', 'blocked')),
  current_step text,
  progress_percent integer not null default 0 check (progress_percent between 0 and 100),
  metadata jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.onboarding_steps (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.onboarding_sessions(id) on delete cascade,
  company_id uuid references public.companies(id) on delete cascade,
  step_code text not null,
  title text not null,
  status text not null default 'pending' check (status in ('pending', 'active', 'completed', 'skipped', 'blocked')),
  sort_order integer not null default 100,
  completed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, step_code)
);

create table if not exists public.onboarding_choices (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.onboarding_sessions(id) on delete cascade,
  company_id uuid references public.companies(id) on delete cascade,
  choice_key text not null,
  choice_value text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (session_id, choice_key)
);

create index if not exists idx_onboarding_sessions_company on public.onboarding_sessions(company_id, status);
create index if not exists idx_onboarding_sessions_user on public.onboarding_sessions(user_id, status);
create index if not exists idx_onboarding_steps_session_order on public.onboarding_steps(session_id, sort_order);

create or replace function public.start_onboarding_session(p_company_id uuid, p_path text, p_user_id uuid default auth.uid())
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_id uuid;
begin
  if p_company_id is not null and not public.user_can_access_company_v2(p_company_id) then
    raise exception 'not allowed to start onboarding for company %', p_company_id;
  end if;

  insert into public.onboarding_sessions (company_id, user_id, path, status, current_step, progress_percent)
  values (p_company_id, p_user_id, p_path, 'in_progress',
    case p_path
      when 'bookkeeping_direct' then 'company'
      when 'bank_automation' then 'bank'
      when 'year_end_one_time' then 'import'
      when 'bankgiro_autogiro' then 'business_profile'
      else 'start'
    end,
    5
  )
  returning id into v_session_id;

  if p_path = 'bookkeeping_direct' then
    insert into public.onboarding_steps (session_id, company_id, step_code, title, sort_order) values
      (v_session_id, p_company_id, 'company', 'Bolagsuppgifter', 10),
      (v_session_id, p_company_id, 'fiscal_year', 'Räkenskapsår', 20),
      (v_session_id, p_company_id, 'vat_period', 'Momsperiod', 30),
      (v_session_id, p_company_id, 'plan', 'Välj prisplan', 40),
      (v_session_id, p_company_id, 'dashboard', 'Klar för översikt', 50);
  elsif p_path = 'bank_automation' then
    insert into public.onboarding_steps (session_id, company_id, step_code, title, sort_order) values
      (v_session_id, p_company_id, 'company', 'Skapa bolag', 10),
      (v_session_id, p_company_id, 'bank', 'Koppla bank', 20),
      (v_session_id, p_company_id, 'transactions', 'Importera transaktioner', 30),
      (v_session_id, p_company_id, 'rules', 'Bekräfta regler', 40),
      (v_session_id, p_company_id, 'review', 'Granskning', 50);
  elsif p_path = 'year_end_one_time' then
    insert into public.onboarding_steps (session_id, company_id, step_code, title, sort_order) values
      (v_session_id, p_company_id, 'import', 'Importera SIE', 10),
      (v_session_id, p_company_id, 'fiscal_year', 'Välj räkenskapsår', 20),
      (v_session_id, p_company_id, 'analysis', 'Bokslutskontroller', 30),
      (v_session_id, p_company_id, 'payment', 'Engångsköp', 40),
      (v_session_id, p_company_id, 'export', 'Exportpaket', 50);
  elsif p_path = 'bankgiro_autogiro' then
    insert into public.onboarding_steps (session_id, company_id, step_code, title, sort_order) values
      (v_session_id, p_company_id, 'business_profile', 'Bolagsuppgifter', 10),
      (v_session_id, p_company_id, 'owners', 'Ägare och verklig huvudman', 20),
      (v_session_id, p_company_id, 'usage', 'Användningsområde och volym', 30),
      (v_session_id, p_company_id, 'documents', 'Dokument', 40),
      (v_session_id, p_company_id, 'review', 'Superadmin review', 50),
      (v_session_id, p_company_id, 'provider_setup', 'Provider setup', 60);
  end if;

  return v_session_id;
end;
$$;

grant execute on function public.start_onboarding_session(uuid, text, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Batch 6: agency operations and status snapshot foundation
-- -----------------------------------------------------------------------------

create table if not exists public.agency_client_status_snapshots (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  snapshot_date date not null default current_date,
  bank_status text not null default 'unknown' check (bank_status in ('unknown', 'not_connected', 'connected', 'needs_attention')),
  review_items_count integer not null default 0 check (review_items_count >= 0),
  vat_status text not null default 'unknown' check (vat_status in ('unknown', 'not_started', 'in_progress', 'ready', 'submitted', 'overdue')),
  year_end_status text not null default 'unknown' check (year_end_status in ('unknown', 'not_started', 'in_progress', 'ready_for_review', 'completed', 'locked')),
  invoice_status text not null default 'unknown' check (invoice_status in ('unknown', 'ok', 'unpaid', 'overdue')),
  supplier_invoice_status text not null default 'unknown' check (supplier_invoice_status in ('unknown', 'ok', 'unpaid', 'overdue')),
  bankgiro_status text not null default 'not_requested' check (bankgiro_status in ('not_requested', 'draft', 'submitted', 'needs_information', 'under_review', 'approved', 'provider_setup', 'active', 'rejected', 'suspended')),
  next_deadline_at date,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agency_id, company_id, snapshot_date)
);

create table if not exists public.agency_templates (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  name text not null,
  template_type text not null check (template_type in ('onboarding', 'bookkeeping_rule', 'deadline_set', 'review_workflow', 'report_package')),
  status text not null default 'active' check (status in ('active', 'paused', 'archived')),
  config jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agency_id, name, template_type)
);

create index if not exists idx_agency_client_status_agency_date on public.agency_client_status_snapshots(agency_id, snapshot_date desc);
create index if not exists idx_agency_templates_agency_type on public.agency_templates(agency_id, template_type, status);

-- -----------------------------------------------------------------------------
-- Batch 7: bank automation provider model, matching, decisions and review queue
-- -----------------------------------------------------------------------------

create table if not exists public.bank_data_providers (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  provider_type text not null check (provider_type in ('gocardless_bank_account_data', 'tink', 'bank_file_import', 'manual_upload', 'future_provider')),
  status text not null default 'active' check (status in ('active', 'paused', 'disabled')),
  supports_balance boolean not null default true,
  supports_transactions boolean not null default true,
  supports_consent_refresh boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.bank_connections
  add column if not exists bank_data_provider_id uuid references public.bank_data_providers(id) on delete set null,
  add column if not exists provider_reference text,
  add column if not exists consent_status text default 'unknown' check (consent_status in ('unknown', 'pending', 'active', 'expired', 'revoked', 'error')),
  add column if not exists sync_status text default 'idle' check (sync_status in ('idle', 'syncing', 'success', 'error')),
  add column if not exists last_sync_error text;

create table if not exists public.bank_accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  bank_connection_id uuid references public.bank_connections(id) on delete set null,
  provider_account_id text,
  account_name text,
  iban text,
  bban text,
  currency text not null default 'SEK',
  balance numeric(15,2),
  balance_at timestamptz,
  status text not null default 'active' check (status in ('active', 'hidden', 'closed')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, provider_account_id)
);

alter table public.transactions
  add column if not exists bank_account_id uuid references public.bank_accounts(id) on delete set null,
  add column if not exists provider_transaction_id text,
  add column if not exists automation_status text default 'not_evaluated' check (automation_status in ('not_evaluated', 'auto_booked', 'suggested', 'needs_review', 'ignored', 'failed')),
  add column if not exists automation_confidence integer check (automation_confidence is null or automation_confidence between 0 and 100),
  add column if not exists automation_decision_id uuid,
  add column if not exists counterparty_name text,
  add column if not exists ocr_reference text;

create unique index if not exists idx_transactions_company_provider_tx on public.transactions(company_id, provider_transaction_id) where provider_transaction_id is not null;
create index if not exists idx_transactions_automation_queue on public.transactions(company_id, automation_status, automation_confidence) where journal_entry_id is null;

create table if not exists public.transaction_match_candidates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  transaction_id uuid not null references public.transactions(id) on delete cascade,
  candidate_type text not null check (candidate_type in ('customer_invoice', 'supplier_invoice', 'bank_fee', 'tax_payment', 'salary', 'own_transfer', 'manual_rule', 'unknown')),
  candidate_id uuid,
  score integer not null check (score between 0 and 100),
  reason_codes text[] not null default '{}',
  proposed_account text,
  proposed_vat_code text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.bookkeeping_automation_rules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  agency_id uuid references public.agencies(id) on delete set null,
  name text not null,
  rule_type text not null check (rule_type in ('bank_fee', 'supplier', 'customer_payment', 'tax', 'salary', 'own_transfer', 'custom')),
  match_config jsonb not null default '{}'::jsonb,
  posting_config jsonb not null default '{}'::jsonb,
  min_confidence integer not null default 95 check (min_confidence between 0 and 100),
  auto_book_allowed boolean not null default false,
  requires_review boolean not null default true,
  status text not null default 'active' check (status in ('active', 'paused', 'archived')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, name)
);

create table if not exists public.automation_decisions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  transaction_id uuid references public.transactions(id) on delete cascade,
  rule_id uuid references public.bookkeeping_automation_rules(id) on delete set null,
  decision text not null check (decision in ('auto_book', 'suggest', 'review', 'ignore', 'reject')),
  confidence integer not null check (confidence between 0 and 100),
  risk_level text not null default 'normal' check (risk_level in ('low', 'normal', 'high')),
  reason_codes text[] not null default '{}',
  proposed_journal jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'applied', 'approved', 'rejected', 'superseded', 'failed')),
  applied_journal_entry_id uuid references public.journal_entries(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  decided_at timestamptz not null default now(),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.review_queue_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  agency_id uuid references public.agencies(id) on delete set null,
  source_type text not null check (source_type in ('bank_transaction', 'supplier_invoice', 'customer_invoice', 'year_end', 'vat_return', 'bankgiro_application', 'manual')),
  source_id uuid,
  title text not null,
  description text,
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  status text not null default 'open' check (status in ('open', 'in_review', 'resolved', 'dismissed')),
  confidence integer check (confidence is null or confidence between 0 and 100),
  assigned_to uuid references auth.users(id) on delete set null,
  due_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_bank_accounts_company_status on public.bank_accounts(company_id, status);
create index if not exists idx_match_candidates_transaction_score on public.transaction_match_candidates(transaction_id, score desc);
create index if not exists idx_automation_rules_company_status on public.bookkeeping_automation_rules(company_id, status);
create index if not exists idx_automation_decisions_company_status on public.automation_decisions(company_id, status, confidence desc);
create index if not exists idx_review_queue_company_status on public.review_queue_items(company_id, status, priority, created_at desc);
create index if not exists idx_review_queue_agency_status on public.review_queue_items(agency_id, status, priority, created_at desc) where agency_id is not null;

insert into public.bank_data_providers (code, name, provider_type, status, supports_balance, supports_transactions, supports_consent_refresh, config) values
  ('gocardless_bank_account_data', 'GoCardless Bank Account Data', 'gocardless_bank_account_data', 'active', true, true, true, '{"mode":"foundation","external_calls":"server_provider_adapter"}'::jsonb),
  ('bank_file_import', 'Bankfilimport', 'bank_file_import', 'active', false, true, false, '{"formats":["csv","xlsx","bankgiro"]}'::jsonb),
  ('manual_upload', 'Manuell uppladdning', 'manual_upload', 'active', false, true, false, '{}'::jsonb),
  ('future_provider', 'Framtida bankprovider', 'future_provider', 'paused', true, true, true, '{}'::jsonb)
on conflict (code) do update set
  name = excluded.name,
  provider_type = excluded.provider_type,
  status = excluded.status,
  supports_balance = excluded.supports_balance,
  supports_transactions = excluded.supports_transactions,
  supports_consent_refresh = excluded.supports_consent_refresh,
  config = excluded.config,
  updated_at = now();

create or replace function public.queue_bank_transaction_review(
  p_company_id uuid,
  p_transaction_id uuid,
  p_title text,
  p_description text,
  p_confidence integer,
  p_priority text default 'normal'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agency_id uuid;
  v_item_id uuid;
begin
  if not public.user_can_access_company_v2(p_company_id) then
    raise exception 'not allowed to queue review for company %', p_company_id;
  end if;

  select ac.agency_id into v_agency_id
  from public.agency_clients ac
  where ac.company_id = p_company_id and ac.status = 'active'
  order by ac.created_at desc
  limit 1;

  insert into public.review_queue_items (
    company_id, agency_id, source_type, source_id, title, description, priority, confidence, metadata
  ) values (
    p_company_id, v_agency_id, 'bank_transaction', p_transaction_id, p_title, p_description, p_priority, p_confidence,
    jsonb_build_object('created_by', 'bank_automation_engine')
  ) returning id into v_item_id;

  return v_item_id;
end;
$$;

grant execute on function public.queue_bank_transaction_review(uuid, uuid, text, text, integer, text) to authenticated;

alter table public.transactions
  drop constraint if exists transactions_automation_decision_fk;
alter table public.transactions
  add constraint transactions_automation_decision_fk
  foreign key (automation_decision_id) references public.automation_decisions(id) on delete set null;

create or replace view public.agency_client_overview_v
with (security_invoker = true)
as
select
  ac.agency_id,
  ac.company_id,
  c.name as company_name,
  c.org_number,
  ac.status as agency_client_status,
  ac.primary_accountant_id,
  p.full_name as primary_accountant_name,
  coalesce(s.bank_status, case when exists (select 1 from public.bank_connections bc where bc.company_id = ac.company_id and bc.status = 'active') then 'connected' else 'not_connected' end) as bank_status,
  coalesce(s.review_items_count, (select count(*)::integer from public.review_queue_items rqi where rqi.company_id = ac.company_id and rqi.status in ('open','in_review'))) as review_items_count,
  coalesce(s.vat_status, 'unknown') as vat_status,
  coalesce(s.year_end_status, (select coalesce(max(yep.status), 'not_started') from public.year_end_projects yep where yep.company_id = ac.company_id)) as year_end_status,
  coalesce(s.invoice_status, case when exists (select 1 from public.invoices i where i.company_id = ac.company_id and i.status = 'overdue') then 'overdue' when exists (select 1 from public.invoices i where i.company_id = ac.company_id and i.status = 'sent') then 'unpaid' else 'ok' end) as invoice_status,
  coalesce(s.supplier_invoice_status, case when exists (select 1 from public.supplier_invoices si where si.company_id = ac.company_id and si.status = 'overdue') then 'overdue' when exists (select 1 from public.supplier_invoices si where si.company_id = ac.company_id and si.status in ('registered','approved','partially_paid')) then 'unpaid' else 'ok' end) as supplier_invoice_status,
  coalesce(s.bankgiro_status, (select coalesce(max(ba.status), 'not_requested') from public.bankgiro_applications ba where ba.company_id = ac.company_id)) as bankgiro_status,
  coalesce(s.next_deadline_at, (select min(d.due_date) from public.deadlines d where d.company_id = ac.company_id and d.is_completed = false)) as next_deadline_at
from public.agency_clients ac
join public.companies c on c.id = ac.company_id
left join public.profiles p on p.id = ac.primary_accountant_id
left join lateral (
  select *
  from public.agency_client_status_snapshots s1
  where s1.agency_id = ac.agency_id and s1.company_id = ac.company_id
  order by s1.snapshot_date desc, s1.created_at desc
  limit 1
) s on true
where public.is_platform_admin() or public.user_is_agency_member(ac.agency_id) or public.user_can_access_company_v2(ac.company_id);

revoke all on public.agency_client_overview_v from anon;
grant select on public.agency_client_overview_v to authenticated;


-- -----------------------------------------------------------------------------
-- RLS, triggers and grants for new batch 5-7 tables
-- -----------------------------------------------------------------------------

alter table public.onboarding_sessions enable row level security;
alter table public.onboarding_steps enable row level security;
alter table public.onboarding_choices enable row level security;
alter table public.agency_client_status_snapshots enable row level security;
alter table public.agency_templates enable row level security;
alter table public.bank_data_providers enable row level security;
alter table public.bank_accounts enable row level security;
alter table public.transaction_match_candidates enable row level security;
alter table public.bookkeeping_automation_rules enable row level security;
alter table public.automation_decisions enable row level security;
alter table public.review_queue_items enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['bank_data_providers'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select using (auth.uid() is not null)', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_admin_write', t);
    execute format('create policy %I on public.%I for all using (public.is_platform_admin()) with check (public.is_platform_admin())', t || '_admin_write', t);
  end loop;
end $$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'onboarding_sessions','onboarding_steps','onboarding_choices','bank_accounts','transaction_match_candidates',
    'bookkeeping_automation_rules','automation_decisions','review_queue_items'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select using (public.user_can_access_company_v2(company_id))', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format('create policy %I on public.%I for all using (public.user_can_access_company_v2(company_id)) with check (public.user_can_access_company_v2(company_id))', t || '_write', t);
  end loop;
end $$;

drop policy if exists onboarding_sessions_user_without_company on public.onboarding_sessions;
create policy onboarding_sessions_user_without_company on public.onboarding_sessions
  for all using (company_id is null and user_id = auth.uid()) with check (company_id is null and user_id = auth.uid());

drop policy if exists onboarding_steps_session_access on public.onboarding_steps;
create policy onboarding_steps_session_access on public.onboarding_steps
  for all using (
    exists (
      select 1 from public.onboarding_sessions os
      where os.id = onboarding_steps.session_id
        and (
          (os.company_id is null and os.user_id = auth.uid())
          or (os.company_id is not null and public.user_can_access_company_v2(os.company_id))
        )
    )
  ) with check (
    exists (
      select 1 from public.onboarding_sessions os
      where os.id = onboarding_steps.session_id
        and (
          (os.company_id is null and os.user_id = auth.uid())
          or (os.company_id is not null and public.user_can_access_company_v2(os.company_id))
        )
    )
  );

drop policy if exists onboarding_choices_session_access on public.onboarding_choices;
create policy onboarding_choices_session_access on public.onboarding_choices
  for all using (
    exists (
      select 1 from public.onboarding_sessions os
      where os.id = onboarding_choices.session_id
        and (
          (os.company_id is null and os.user_id = auth.uid())
          or (os.company_id is not null and public.user_can_access_company_v2(os.company_id))
        )
    )
  ) with check (
    exists (
      select 1 from public.onboarding_sessions os
      where os.id = onboarding_choices.session_id
        and (
          (os.company_id is null and os.user_id = auth.uid())
          or (os.company_id is not null and public.user_can_access_company_v2(os.company_id))
        )
    )
  );

drop policy if exists agency_client_status_select on public.agency_client_status_snapshots;
create policy agency_client_status_select on public.agency_client_status_snapshots
  for select using (public.is_platform_admin() or public.user_is_agency_member(agency_id) or public.user_can_access_company_v2(company_id));
drop policy if exists agency_client_status_write on public.agency_client_status_snapshots;
create policy agency_client_status_write on public.agency_client_status_snapshots
  for all using (public.is_platform_admin() or public.user_is_agency_admin(agency_id)) with check (public.is_platform_admin() or public.user_is_agency_admin(agency_id));

drop policy if exists agency_templates_select on public.agency_templates;
create policy agency_templates_select on public.agency_templates
  for select using (public.is_platform_admin() or public.user_is_agency_member(agency_id));
drop policy if exists agency_templates_write on public.agency_templates;
create policy agency_templates_write on public.agency_templates
  for all using (public.is_platform_admin() or public.user_is_agency_admin(agency_id)) with check (public.is_platform_admin() or public.user_is_agency_admin(agency_id));

do $$
declare
  t text;
begin
  foreach t in array array[
    'onboarding_sessions','onboarding_steps','agency_client_status_snapshots','agency_templates','bank_data_providers',
    'bank_accounts','bookkeeping_automation_rules','automation_decisions','review_queue_items'
  ] loop
    execute format('drop trigger if exists %I on public.%I', t || '_updated_at', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.update_updated_at_column()', t || '_updated_at', t);
  end loop;
end $$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'onboarding_sessions','agency_client_status_snapshots','agency_templates','bank_accounts','bookkeeping_automation_rules',
    'automation_decisions','review_queue_items'
  ] loop
    execute format('drop trigger if exists %I on public.%I', t || '_audit', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.write_audit_log()', t || '_audit', t);
  end loop;
end $$;

notify pgrst, 'reload schema';
