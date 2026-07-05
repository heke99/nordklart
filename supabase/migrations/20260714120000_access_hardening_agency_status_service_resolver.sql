-- Access hardening: agency membership status in RLS helpers + explicit-user
-- access resolver for trusted server-side callers.
--
-- 1. user_is_agency_member() / user_is_agency_admin() ignored
--    agency_members.status. A suspended or revoked staff member therefore
--    kept SELECT (and for admins, write) access to agency-scoped rows via
--    RLS even though the application layer filters on status = 'active'.
--    Both helpers now require an active membership, matching
--    user_can_access_company_v2() and resolve_company_access().
--
-- 2. resolve_company_access_for_user(p_user_id, p_company_id) is the
--    explicit-user variant of resolve_company_access() for trusted
--    server-side callers. The v1 API wrapper authenticates via API key and
--    runs a service-role client where auth.uid() is NULL, so it could not
--    use the central resolver and fell back to a direct company_members
--    check — wrongly rejecting agency staff and platform admins.
--    resolve_company_access() now delegates to the parameterized body so
--    there is exactly one access-resolution implementation.

-- ── 1a. user_is_agency_member: require active membership ─────────────────────

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
      and am.status = 'active'
  );
$$;

-- ── 1b. user_is_agency_admin: require active membership ──────────────────────

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
        and am.status = 'active'
    );
$$;

-- ── 2a. resolve_company_access_for_user: parameterized single source of truth ─
-- Body mirrors 20260713120000_agency_payroll_role.sql with auth.uid()
-- replaced by p_user_id (and is_platform_admin() unrolled against
-- platform_roles for the same user).

create or replace function public.resolve_company_access_for_user(
  p_user_id uuid,
  p_company_id uuid
)
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
    where exists (
      select 1 from public.platform_roles pr
      where pr.user_id = p_user_id
        and pr.role = 'platform_admin'
        and pr.revoked_at is null
    )

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
      and cm.user_id = p_user_id
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
      and am.user_id = p_user_id
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

-- Only trusted server-side code (service role) may resolve access for an
-- arbitrary user. Authenticated users go through resolve_company_access().
revoke all on function public.resolve_company_access_for_user(uuid, uuid) from public;
revoke all on function public.resolve_company_access_for_user(uuid, uuid) from anon;
revoke all on function public.resolve_company_access_for_user(uuid, uuid) from authenticated;
grant execute on function public.resolve_company_access_for_user(uuid, uuid) to service_role;

-- ── 2b. resolve_company_access delegates to the parameterized body ───────────

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
  select * from public.resolve_company_access_for_user(auth.uid(), p_company_id);
$$;

grant execute on function public.resolve_company_access(uuid) to authenticated;

notify pgrst, 'reload schema';
