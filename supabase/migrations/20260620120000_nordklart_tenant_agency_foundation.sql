-- Nordklart tenant + accounting agency foundation.
-- Adds platform roles and a first-class agency/client model without changing
-- the existing bookkeeping ledger rules or existing company_members access.

create table if not exists public.platform_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('platform_admin', 'platform_support', 'platform_auditor')),
  granted_by uuid references auth.users(id) on delete set null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  note text
);

alter table public.platform_roles enable row level security;

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.platform_roles pr
    where pr.user_id = auth.uid()
      and pr.role = 'platform_admin'
      and pr.revoked_at is null
  );
$$;

create table if not exists public.agencies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  org_number text,
  contact_email text,
  status text not null default 'active' check (status in ('active', 'paused', 'archived')),
  linked_team_id uuid references public.teams(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (linked_team_id)
);

create table if not exists public.agency_members (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('agency_owner', 'agency_admin', 'accountant', 'reviewer', 'read_only')),
  invited_by uuid references auth.users(id) on delete set null,
  joined_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agency_id, user_id)
);

create table if not exists public.agency_clients (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'paused', 'ended')),
  primary_accountant_id uuid references auth.users(id) on delete set null,
  start_date date,
  end_date date,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agency_id, company_id)
);

alter table public.agencies enable row level security;
alter table public.agency_members enable row level security;
alter table public.agency_clients enable row level security;

create index if not exists idx_agency_members_user_id on public.agency_members(user_id);
create index if not exists idx_agency_members_agency_id on public.agency_members(agency_id);
create index if not exists idx_agency_clients_company_id on public.agency_clients(company_id);
create index if not exists idx_agency_clients_agency_id on public.agency_clients(agency_id);
create index if not exists idx_agencies_status on public.agencies(status) where archived_at is null;

create or replace function public.user_is_agency_member(p_agency_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.agency_members am
    where am.agency_id = p_agency_id
      and am.user_id = auth.uid()
  );
$$;

create or replace function public.user_is_agency_admin(p_agency_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_platform_admin()
    or exists (
      select 1
      from public.agency_members am
      where am.agency_id = p_agency_id
        and am.user_id = auth.uid()
        and am.role in ('agency_owner', 'agency_admin')
    );
$$;

create or replace function public.user_can_access_company_v2(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_platform_admin()
    or exists (
      select 1
      from public.company_members cm
      where cm.company_id = p_company_id
        and cm.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.agency_clients ac
      join public.agency_members am on am.agency_id = ac.agency_id
      where ac.company_id = p_company_id
        and ac.status = 'active'
        and am.user_id = auth.uid()
    );
$$;

drop policy if exists platform_roles_select on public.platform_roles;
create policy platform_roles_select on public.platform_roles
  for select using (user_id = auth.uid() or public.is_platform_admin());

drop policy if exists platform_roles_admin_write on public.platform_roles;
create policy platform_roles_admin_write on public.platform_roles
  for all using (public.is_platform_admin()) with check (public.is_platform_admin());

drop policy if exists agencies_select on public.agencies;
create policy agencies_select on public.agencies
  for select using (public.is_platform_admin() or public.user_is_agency_member(id));

drop policy if exists agencies_insert on public.agencies;
create policy agencies_insert on public.agencies
  for insert with check (public.is_platform_admin() or created_by = auth.uid());

drop policy if exists agencies_update on public.agencies;
create policy agencies_update on public.agencies
  for update using (public.user_is_agency_admin(id)) with check (public.user_is_agency_admin(id));

drop policy if exists agency_members_select on public.agency_members;
create policy agency_members_select on public.agency_members
  for select using (public.is_platform_admin() or public.user_is_agency_member(agency_id));

drop policy if exists agency_members_write on public.agency_members;
create policy agency_members_write on public.agency_members
  for all using (public.user_is_agency_admin(agency_id)) with check (public.user_is_agency_admin(agency_id));

drop policy if exists agency_clients_select on public.agency_clients;
create policy agency_clients_select on public.agency_clients
  for select using (
    public.is_platform_admin()
    or public.user_is_agency_member(agency_id)
    or exists (
      select 1 from public.company_members cm
      where cm.company_id = agency_clients.company_id
        and cm.user_id = auth.uid()
        and cm.role in ('owner', 'admin')
    )
  );

drop policy if exists agency_clients_write on public.agency_clients;
create policy agency_clients_write on public.agency_clients
  for all using (public.user_is_agency_admin(agency_id)) with check (public.user_is_agency_admin(agency_id));

drop trigger if exists agencies_updated_at on public.agencies;
create trigger agencies_updated_at
  before update on public.agencies
  for each row execute function public.update_updated_at_column();

drop trigger if exists agency_members_updated_at on public.agency_members;
create trigger agency_members_updated_at
  before update on public.agency_members
  for each row execute function public.update_updated_at_column();

drop trigger if exists agency_clients_updated_at on public.agency_clients;
create trigger agency_clients_updated_at
  before update on public.agency_clients
  for each row execute function public.update_updated_at_column();

-- Non-destructive backfill: existing teams become agencies, existing team
-- memberships become agency memberships, existing team-owned companies become
-- agency clients. This keeps old company_members access intact.
insert into public.agencies (name, linked_team_id, created_by, created_at, updated_at)
select t.name, t.id, t.created_by, t.created_at, t.updated_at
from public.teams t
where not exists (select 1 from public.agencies a where a.linked_team_id = t.id);

insert into public.agency_members (agency_id, user_id, role, joined_at, created_at, updated_at)
select
  a.id,
  tm.user_id,
  case tm.role
    when 'owner' then 'agency_owner'
    when 'admin' then 'agency_admin'
    else 'accountant'
  end,
  tm.joined_at,
  tm.created_at,
  tm.updated_at
from public.team_members tm
join public.agencies a on a.linked_team_id = tm.team_id
on conflict (agency_id, user_id) do nothing;

insert into public.agency_clients (agency_id, company_id, status, created_by, created_at, updated_at)
select a.id, c.id, 'active', c.created_by, c.created_at, c.updated_at
from public.companies c
join public.agencies a on a.linked_team_id = c.team_id
where c.team_id is not null
on conflict (agency_id, company_id) do nothing;

create or replace view public.company_access
with (security_invoker = true)
as
select
  cm.user_id,
  cm.company_id,
  cm.role::text as access_role,
  'direct'::text as access_source,
  null::uuid as agency_id
from public.company_members cm
union all
select
  am.user_id,
  ac.company_id,
  am.role as access_role,
  'agency'::text as access_source,
  ac.agency_id
from public.agency_clients ac
join public.agency_members am on am.agency_id = ac.agency_id
where ac.status = 'active';

revoke all on public.company_access from anon;
grant select on public.company_access to authenticated;
