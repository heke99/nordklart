-- Batch 11 — agency 'payroll' role.
--
-- Accounting agencies staff dedicated payroll administrators (lönekonsulter)
-- who need write access to client companies (salary runs, AGI) but are not
-- accountants or agency admins. Adds 'payroll' to the agency role vocabulary
-- and maps it to the 'accountant' effective role (write + review) at a rank
-- just below accountant so mixed memberships resolve deterministically.

-- ── 1. agency_members role CHECK ─────────────────────────────────────────────

alter table public.agency_members
  drop constraint if exists agency_members_role_check;
alter table public.agency_members
  add constraint agency_members_role_check
  check (role in ('agency_owner', 'agency_admin', 'accountant', 'payroll', 'reviewer', 'read_only'));

-- ── 2. agency_invitations role CHECK ─────────────────────────────────────────

alter table public.agency_invitations
  drop constraint if exists agency_invitations_role_check;
alter table public.agency_invitations
  add constraint agency_invitations_role_check
  check (role in ('agency_admin', 'accountant', 'payroll', 'reviewer', 'read_only'));

-- ── 3. resolve_company_access: map 'payroll' → effective 'accountant' ────────
-- Same body as 20260630150000 with the payroll case added (rank 55).

create or replace function public.resolve_company_access(p_company_id uuid)
returns table (
  company_id uuid,
  access_source text,
  agency_id uuid,
  effective_role text,
  can_read boolean,
  can_write boolean,
  can_review boolean,
  can_manage_company boolean,
  can_manage_agency boolean,
  can_manage_platform boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with candidates as (
    select
      p_company_id as company_id,
      'platform'::text as access_source,
      null::uuid as agency_id,
      'platform_admin'::text as effective_role,
      null::text as membership_status,
      100 as role_rank
    where public.is_platform_admin()

    union all

    select
      cm.company_id,
      'direct'::text,
      null::uuid,
      case cm.role
        when 'owner' then 'company_owner'
        when 'admin' then 'company_admin'
        when 'accountant' then 'accountant'
        when 'auditor' then 'auditor'
        when 'viewer' then 'read_only'
        when 'member' then 'client_user'
        else 'read_only'
      end,
      cm.status,
      case cm.role when 'owner' then 90 when 'admin' then 80 when 'accountant' then 55 when 'member' then 50 when 'auditor' then 35 else 10 end
    from public.company_members cm
    where cm.company_id = p_company_id
      and cm.user_id = auth.uid()
      and public.company_member_is_active(cm.status)

    union all

    select
      ac.company_id,
      'agency'::text,
      am.agency_id,
      case am.role
        when 'agency_owner' then 'company_admin'
        when 'agency_admin' then 'company_admin'
        when 'accountant' then 'accountant'
        when 'payroll' then 'accountant'
        when 'reviewer' then 'reviewer'
        else 'read_only'
      end,
      'active'::text,
      case am.role
        when 'agency_owner' then 75
        when 'agency_admin' then 70
        when 'accountant' then 60
        when 'payroll' then 55
        when 'reviewer' then 40
        else 10
      end
    from public.agency_clients ac
    join public.agency_members am on am.agency_id = ac.agency_id
    where ac.company_id = p_company_id
      and ac.status = 'active'
      and am.status = 'active'
      and am.user_id = auth.uid()
  ), selected as (
    select * from candidates order by role_rank desc, access_source asc limit 1
  )
  select
    company_id,
    access_source,
    agency_id,
    effective_role,
    true as can_read,
    effective_role in ('platform_admin', 'company_owner', 'company_admin', 'accountant', 'client_user')
      and coalesce(membership_status, 'active') = 'active' as can_write,
    effective_role in ('platform_admin', 'company_owner', 'company_admin', 'accountant', 'reviewer', 'auditor')
      and coalesce(membership_status, 'active') = 'active' as can_review,
    effective_role in ('platform_admin', 'company_owner', 'company_admin')
      and coalesce(membership_status, 'active') = 'active' as can_manage_company,
    effective_role = 'platform_admin' or (access_source = 'agency' and effective_role = 'company_admin') as can_manage_agency,
    effective_role = 'platform_admin' as can_manage_platform
  from selected;
$$;

grant execute on function public.resolve_company_access(uuid) to authenticated;

notify pgrst, 'reload schema';
