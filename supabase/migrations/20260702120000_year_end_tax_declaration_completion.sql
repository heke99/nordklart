-- Nordklart year-end/tax declaration completion foundation.
-- Adds durable declaration projects, adjustments, questionnaire answers,
-- exports and audit events for the SIE -> bokslut -> INK2/NE -> SRU flow.

create table if not exists public.tax_declaration_projects (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references public.companies(id) on delete cascade,
  fiscal_period_id uuid not null references public.fiscal_periods(id) on delete cascade,
  declaration_type text not null check (declaration_type in ('INK2','NE')),
  status text not null default 'draft' check (status in ('draft','needs_input','needs_review','blocked','ready_to_export','exported','superseded')),
  readiness_score numeric not null default 0 check (readiness_score >= 0 and readiness_score <= 100),
  blockers jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  last_generated_at timestamptz,
  generated_by uuid,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tax_declaration_projects_company_period_type_unique unique (company_id, fiscal_period_id, declaration_type)
);

create index if not exists tax_declaration_projects_company_status_idx
  on public.tax_declaration_projects(company_id, status, updated_at desc);
create index if not exists tax_declaration_projects_period_idx
  on public.tax_declaration_projects(fiscal_period_id, declaration_type);

create table if not exists public.tax_declaration_adjustments (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references public.companies(id) on delete cascade,
  fiscal_period_id uuid not null references public.fiscal_periods(id) on delete cascade,
  tax_declaration_project_id uuid references public.tax_declaration_projects(id) on delete cascade,
  declaration_type text not null check (declaration_type in ('INK2','NE')),
  form text not null,
  field_code text not null check (field_code ~ '^\d{4}$'),
  amount numeric not null default 0,
  description text,
  source text not null default 'user_input' check (source in ('auto','account_rule','user_input','imported','calculated')),
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  requires_review boolean not null default false,
  approved_by uuid,
  approved_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check ((requires_review = false) or (approved_at is null) or (approved_by is not null))
);

create index if not exists tax_declaration_adjustments_lookup_idx
  on public.tax_declaration_adjustments(company_id, fiscal_period_id, declaration_type, field_code)
  where deleted_at is null;
create index if not exists tax_declaration_adjustments_project_idx
  on public.tax_declaration_adjustments(tax_declaration_project_id)
  where deleted_at is null;

create table if not exists public.tax_declaration_fields (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references public.companies(id) on delete cascade,
  fiscal_period_id uuid not null references public.fiscal_periods(id) on delete cascade,
  tax_declaration_project_id uuid references public.tax_declaration_projects(id) on delete cascade,
  declaration_type text not null check (declaration_type in ('INK2','NE')),
  form text not null,
  field_code text not null,
  amount numeric,
  text_value text,
  source text not null default 'calculated' check (source in ('auto','account_rule','user_input','imported','calculated')),
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  requires_review boolean not null default false,
  blocker boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tax_declaration_fields_unique unique (company_id, fiscal_period_id, declaration_type, form, field_code)
);

create index if not exists tax_declaration_fields_project_idx
  on public.tax_declaration_fields(tax_declaration_project_id);

create table if not exists public.tax_declaration_questionnaire_answers (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references public.companies(id) on delete cascade,
  fiscal_period_id uuid not null references public.fiscal_periods(id) on delete cascade,
  tax_declaration_project_id uuid references public.tax_declaration_projects(id) on delete cascade,
  declaration_type text not null check (declaration_type in ('INK2','NE')),
  question_key text not null,
  answer jsonb not null default 'null'::jsonb,
  requires_review boolean not null default false,
  reviewed_by uuid,
  reviewed_at timestamptz,
  answered_by uuid,
  answered_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tax_declaration_answers_unique unique (company_id, fiscal_period_id, declaration_type, question_key)
);

create index if not exists tax_declaration_answers_project_idx
  on public.tax_declaration_questionnaire_answers(tax_declaration_project_id);

create table if not exists public.tax_declaration_warnings (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references public.companies(id) on delete cascade,
  fiscal_period_id uuid not null references public.fiscal_periods(id) on delete cascade,
  tax_declaration_project_id uuid references public.tax_declaration_projects(id) on delete cascade,
  declaration_type text not null check (declaration_type in ('INK2','NE')),
  code text not null,
  severity text not null check (severity in ('info','warning','blocker')),
  message text not null,
  source text,
  resolved_at timestamptz,
  resolved_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists tax_declaration_warnings_open_idx
  on public.tax_declaration_warnings(company_id, fiscal_period_id, declaration_type, severity)
  where resolved_at is null;

create table if not exists public.tax_declaration_exports (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references public.companies(id) on delete cascade,
  fiscal_period_id uuid not null references public.fiscal_periods(id) on delete cascade,
  tax_declaration_project_id uuid references public.tax_declaration_projects(id) on delete set null,
  declaration_type text not null check (declaration_type in ('INK2','NE')),
  format text not null,
  filename text not null,
  readiness_score numeric not null default 0,
  blocker_count integer not null default 0,
  warning_count integer not null default 0,
  validation_result jsonb not null default '{}'::jsonb,
  file_hash text,
  exported_by uuid,
  exported_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists tax_declaration_exports_company_period_idx
  on public.tax_declaration_exports(company_id, fiscal_period_id, declaration_type, exported_at desc);

create table if not exists public.tax_declaration_audit_events (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references public.companies(id) on delete cascade,
  fiscal_period_id uuid references public.fiscal_periods(id) on delete set null,
  tax_declaration_project_id uuid references public.tax_declaration_projects(id) on delete set null,
  event_type text not null,
  actor_id uuid,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists tax_declaration_audit_events_lookup_idx
  on public.tax_declaration_audit_events(company_id, fiscal_period_id, created_at desc);

alter table public.tax_declaration_projects enable row level security;
alter table public.tax_declaration_adjustments enable row level security;
alter table public.tax_declaration_fields enable row level security;
alter table public.tax_declaration_questionnaire_answers enable row level security;
alter table public.tax_declaration_warnings enable row level security;
alter table public.tax_declaration_exports enable row level security;
alter table public.tax_declaration_audit_events enable row level security;

do $$
begin
  if exists (select 1 from pg_proc where proname = 'user_can_access_company_v2' and pronamespace = 'public'::regnamespace) then
    execute 'create policy tax_declaration_projects_access on public.tax_declaration_projects for all using (public.user_can_access_company_v2(company_id)) with check (public.user_can_access_company_v2(company_id))';
    execute 'create policy tax_declaration_adjustments_access on public.tax_declaration_adjustments for all using (public.user_can_access_company_v2(company_id)) with check (public.user_can_access_company_v2(company_id))';
    execute 'create policy tax_declaration_fields_access on public.tax_declaration_fields for all using (public.user_can_access_company_v2(company_id)) with check (public.user_can_access_company_v2(company_id))';
    execute 'create policy tax_declaration_answers_access on public.tax_declaration_questionnaire_answers for all using (public.user_can_access_company_v2(company_id)) with check (public.user_can_access_company_v2(company_id))';
    execute 'create policy tax_declaration_warnings_access on public.tax_declaration_warnings for all using (public.user_can_access_company_v2(company_id)) with check (public.user_can_access_company_v2(company_id))';
    execute 'create policy tax_declaration_exports_access on public.tax_declaration_exports for all using (public.user_can_access_company_v2(company_id)) with check (public.user_can_access_company_v2(company_id))';
    execute 'create policy tax_declaration_audit_events_access on public.tax_declaration_audit_events for select using (public.user_can_access_company_v2(company_id))';
    execute 'create policy tax_declaration_audit_events_insert on public.tax_declaration_audit_events for insert with check (public.user_can_access_company_v2(company_id))';
  end if;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  if exists (select 1 from pg_proc where proname = 'update_updated_at_column' and pronamespace = 'public'::regnamespace) then
    execute 'drop trigger if exists tax_declaration_projects_updated_at on public.tax_declaration_projects';
    execute 'create trigger tax_declaration_projects_updated_at before update on public.tax_declaration_projects for each row execute function public.update_updated_at_column()';
    execute 'drop trigger if exists tax_declaration_adjustments_updated_at on public.tax_declaration_adjustments';
    execute 'create trigger tax_declaration_adjustments_updated_at before update on public.tax_declaration_adjustments for each row execute function public.update_updated_at_column()';
    execute 'drop trigger if exists tax_declaration_fields_updated_at on public.tax_declaration_fields';
    execute 'create trigger tax_declaration_fields_updated_at before update on public.tax_declaration_fields for each row execute function public.update_updated_at_column()';
    execute 'drop trigger if exists tax_declaration_answers_updated_at on public.tax_declaration_questionnaire_answers';
    execute 'create trigger tax_declaration_answers_updated_at before update on public.tax_declaration_questionnaire_answers for each row execute function public.update_updated_at_column()';
  end if;
end $$;

notify pgrst, 'reload schema';
