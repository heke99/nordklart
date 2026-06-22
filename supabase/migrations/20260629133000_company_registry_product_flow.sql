-- Company Registry Product Flow
-- - Adds registry sync audit events for Bolagsverket/Värdefulla datamängder.
-- - Backfills/guards company_registry_snapshots for API-driven settings sync.

create table if not exists public.company_registry_sync_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete cascade,
  provider text not null check (provider in ('bolagsverket', 'skatteverket', 'manual')),
  status text not null check (status in ('success', 'failed', 'unavailable', 'not_found')),
  requested_by_user_id uuid references auth.users(id) on delete set null,
  organization_number text,
  diff jsonb not null default '[]'::jsonb,
  applied_safe_fields boolean not null default false,
  error_message text,
  created_at timestamptz not null default now(),
  check (organization_number is null or organization_number ~ '^[0-9]{10}$')
);

create index if not exists idx_company_registry_sync_events_company
  on public.company_registry_sync_events(company_id, created_at desc);

alter table public.company_registry_sync_events enable row level security;

grant select, insert on public.company_registry_sync_events to service_role;

drop policy if exists company_registry_snapshots_select_members on public.company_registry_snapshots;
create policy company_registry_snapshots_select_members
  on public.company_registry_snapshots
  for select
  to authenticated
  using (company_id in (select public.user_company_ids()));

notify pgrst, 'reload schema';
