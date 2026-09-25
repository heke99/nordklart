-- Agency engagements are bounded by what the client agreed to.
--
-- 1. agency_clients.access_level was stored but never read: an agency_admin
--    on a 'review' or 'audit' engagement resolved to company_admin with write
--    access. The agency branch of resolve_company_access_for_user now caps the
--    role at reviewer (review) / auditor (audit); bookkeeping and full_service
--    keep the agency-role mapping. Every RLS write policy goes through
--    user_can_write_company -> resolve_company_access, so this one change
--    applies everywhere.
-- 2. can_manage_company is no longer granted through agency access. The
--    member, invitation, access-request and agency-link routes use the service
--    client behind canManageCompany, so an agency admin could otherwise add or
--    remove the client's own users.
--
-- pg-test: tests/pg/agency-access-level.pg.test.ts

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
      -- The client agreed to a scope (agency_clients.access_level). A
      -- review or audit engagement never yields more than that role,
      -- whatever the staff member's role inside the agency.
      case
        when am.role not in ('agency_owner', 'agency_admin', 'accountant', 'payroll', 'reviewer') then 'read_only'
        when ac.access_level = 'audit' then 'auditor'
        when ac.access_level = 'review' then 'reviewer'
        else case am.role
          when 'agency_owner' then 'company_admin'
          when 'agency_admin' then 'company_admin'
          when 'accountant' then 'accountant'
          when 'payroll' then 'accountant'
          when 'reviewer' then 'reviewer'
        end
      end,
      'active'::text,
      case
        when am.role not in ('agency_owner', 'agency_admin', 'accountant', 'payroll', 'reviewer') then 10
        when ac.access_level = 'audit' then 35
        when ac.access_level = 'review' then 40
        else case am.role
          when 'agency_owner' then 75
          when 'agency_admin' then 70
          when 'accountant' then 60
          when 'payroll' then 55
          when 'reviewer' then 40
        end
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
    -- Managing the company (members, invitations, access requests, agency
    -- links) belongs to the client's own owner/admin. Agency staff do the
    -- bookkeeping; they do not decide who else gets into the client.
    effective_role in ('platform_admin', 'company_owner', 'company_admin')
      and access_source <> 'agency'
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

notify pgrst, 'reload schema';
