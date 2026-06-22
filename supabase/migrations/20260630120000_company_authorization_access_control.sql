-- Nordklart company authorization and access-control hardening.
-- Prevents access to an existing company solely by knowing its organisation number.
-- Adds pending access requests, membership lifecycle status, founder attestations,
-- and keeps old provisioning intact behind a safer authorization wrapper.

-- -----------------------------------------------------------------------------
-- 1. Membership lifecycle and authorization metadata
-- -----------------------------------------------------------------------------

alter table public.company_members
  add column if not exists status text not null default 'active',
  add column if not exists access_source text not null default 'direct',
  add column if not exists approved_by uuid references auth.users(id) on delete set null,
  add column if not exists approved_at timestamptz,
  add column if not exists revoked_by uuid references auth.users(id) on delete set null,
  add column if not exists revoked_at timestamptz,
  add column if not exists verification_status text not null default 'not_required';

alter table public.company_members
  drop constraint if exists company_members_status_check;
alter table public.company_members
  add constraint company_members_status_check
  check (status in ('pending', 'active', 'active_limited', 'suspended', 'revoked'));

alter table public.company_members
  drop constraint if exists company_members_access_source_check;
alter table public.company_members
  add constraint company_members_access_source_check
  check (access_source in ('direct', 'founder_signup', 'invite', 'access_request', 'agency', 'platform_admin'));

alter table public.company_members
  drop constraint if exists company_members_verification_status_check;
alter table public.company_members
  add constraint company_members_verification_status_check
  check (verification_status in ('not_required', 'self_attested', 'manual_review', 'verified', 'rejected'));

update public.company_members
set status = coalesce(nullif(status, ''), 'active'),
    access_source = case
      when coalesce(access_source, '') <> '' then access_source
      when coalesce(source, '') = 'team' then 'direct'
      else 'direct'
    end,
    approved_at = coalesce(approved_at, joined_at, created_at, now())
where status is null
   or access_source is null
   or approved_at is null;

create index if not exists idx_company_members_active_user
  on public.company_members(user_id, company_id)
  where status in ('active', 'active_limited');

create index if not exists idx_company_members_manage_company
  on public.company_members(company_id, user_id, role)
  where status = 'active' and role in ('owner', 'admin');

-- Invitations should carry acceptance metadata for auditability.
alter table public.company_invitations
  add column if not exists accepted_by uuid references auth.users(id) on delete set null,
  add column if not exists accepted_at timestamptz,
  add column if not exists revoked_by uuid references auth.users(id) on delete set null,
  add column if not exists revoked_at timestamptz;

-- Signup drafts may now end in an access request instead of a newly-created workspace.
alter table public.signup_drafts
  drop constraint if exists signup_drafts_status_check;
alter table public.signup_drafts
  add constraint signup_drafts_status_check check (
    status in (
      'pending_verification',
      'email_verified_pending_password',
      'ready_for_first_login',
      'provisioning',
      'provisioned',
      'access_request_pending',
      'expired',
      'cancelled',
      'failed'
    )
  );

-- -----------------------------------------------------------------------------
-- 2. Access requests and founder attestations
-- -----------------------------------------------------------------------------

create table if not exists public.company_access_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  requester_user_id uuid not null references auth.users(id) on delete cascade,
  requester_email text not null,
  requested_role text not null default 'member'
    check (requested_role in ('admin', 'member', 'viewer')),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  message text,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(company_id, requester_user_id),
  check (requester_email = lower(requester_email))
);

create index if not exists idx_company_access_requests_company_status
  on public.company_access_requests(company_id, status, created_at desc);

create index if not exists idx_company_access_requests_requester_status
  on public.company_access_requests(requester_user_id, status, created_at desc);

alter table public.company_access_requests enable row level security;
grant select, insert, update on public.company_access_requests to service_role;
grant select on public.company_access_requests to authenticated;

drop trigger if exists company_access_requests_updated_at on public.company_access_requests;
create trigger company_access_requests_updated_at
  before update on public.company_access_requests
  for each row execute function public.update_updated_at_column();

create table if not exists public.company_authorization_attestations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  attestation_type text not null default 'authorized_representative'
    check (attestation_type in ('authorized_representative', 'bookkeeper_authorized_by_company', 'agency_client_authorization')),
  accepted_at timestamptz not null default now(),
  ip_address text,
  user_agent text,
  legal_text_version_id uuid references public.legal_text_versions(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(company_id, user_id, attestation_type)
);

create index if not exists idx_company_authorization_attestations_company
  on public.company_authorization_attestations(company_id, accepted_at desc);

alter table public.company_authorization_attestations enable row level security;
grant select, insert on public.company_authorization_attestations to service_role;
grant select on public.company_authorization_attestations to authenticated;

-- -----------------------------------------------------------------------------
-- 3. RLS/helper functions use only active memberships for access.
-- -----------------------------------------------------------------------------

create or replace function public.company_member_is_active(p_status text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select coalesce(p_status, 'active') in ('active', 'active_limited');
$$;

create or replace function public.user_is_company_admin(p_company_id uuid)
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
        and cm.role in ('owner', 'admin')
        and cm.status = 'active'
    );
$$;

grant execute on function public.user_is_company_admin(uuid) to authenticated;

create or replace function public.user_role_in_company(p_company_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select cm.role
  from public.company_members cm
  where cm.company_id = p_company_id
    and cm.user_id = auth.uid()
    and public.company_member_is_active(cm.status)
  order by case cm.status when 'active' then 1 else 2 end
  limit 1;
$$;

grant execute on function public.user_role_in_company(uuid) to authenticated;

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
        and public.company_member_is_active(cm.status)
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

grant execute on function public.user_can_access_company_v2(uuid) to authenticated;

create or replace function public.user_company_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select c.id
  from public.companies c
  where c.archived_at is null
    and public.user_can_access_company_v2(c.id);
$$;

grant execute on function public.user_company_ids() to authenticated;

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
        when 'member' then 'client_user'
        else 'read_only'
      end,
      cm.status,
      case cm.role when 'owner' then 90 when 'admin' then 80 when 'member' then 50 else 10 end
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
        when 'reviewer' then 'reviewer'
        else 'read_only'
      end,
      'active'::text,
      case am.role
        when 'agency_owner' then 75
        when 'agency_admin' then 70
        when 'accountant' then 60
        when 'reviewer' then 40
        else 10
      end
    from public.agency_clients ac
    join public.agency_members am on am.agency_id = ac.agency_id
    where ac.company_id = p_company_id
      and ac.status = 'active'
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
    effective_role in ('platform_admin', 'company_owner', 'company_admin', 'accountant', 'reviewer')
      and coalesce(membership_status, 'active') = 'active' as can_review,
    effective_role in ('platform_admin', 'company_owner', 'company_admin')
      and coalesce(membership_status, 'active') = 'active' as can_manage_company,
    effective_role = 'platform_admin' or (access_source = 'agency' and effective_role = 'company_admin') as can_manage_agency,
    effective_role = 'platform_admin' as can_manage_platform
  from selected;
$$;

grant execute on function public.resolve_company_access(uuid) to authenticated;

create or replace function public.list_accessible_companies()
returns table (
  company_id uuid,
  company_name text,
  org_number text,
  entity_type text,
  archived_at timestamptz,
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
  select
    c.id,
    c.name,
    c.org_number,
    c.entity_type,
    c.archived_at,
    a.access_source,
    a.agency_id,
    a.effective_role,
    a.can_read,
    a.can_write,
    a.can_review,
    a.can_manage_company,
    a.can_manage_agency,
    a.can_manage_platform
  from public.companies c
  cross join lateral public.resolve_company_access(c.id) a
  where c.archived_at is null
  order by c.created_at asc;
$$;

grant execute on function public.list_accessible_companies() to authenticated;

-- RLS for the new audit/request tables.
drop policy if exists company_access_requests_select on public.company_access_requests;
create policy company_access_requests_select on public.company_access_requests
  for select using (
    requester_user_id = auth.uid()
    or public.user_is_company_admin(company_id)
    or public.is_platform_admin()
  );

drop policy if exists company_access_requests_insert on public.company_access_requests;
create policy company_access_requests_insert on public.company_access_requests
  for insert with check (requester_user_id = auth.uid() or public.is_platform_admin());

drop policy if exists company_access_requests_update on public.company_access_requests;
create policy company_access_requests_update on public.company_access_requests
  for update using (public.user_is_company_admin(company_id) or public.is_platform_admin())
  with check (public.user_is_company_admin(company_id) or public.is_platform_admin());

drop policy if exists company_authorization_attestations_select on public.company_authorization_attestations;
create policy company_authorization_attestations_select on public.company_authorization_attestations
  for select using (
    user_id = auth.uid()
    or public.user_is_company_admin(company_id)
    or public.is_platform_admin()
  );

-- -----------------------------------------------------------------------------
-- 4. Safer signup provisioning wrapper.
-- -----------------------------------------------------------------------------

create or replace function public.provision_authorized_signup_draft_v4(p_user_id uuid)
returns table (
  provision_state text,
  company_id uuid,
  agency_id uuid,
  workspace_type text,
  onboarding_path text,
  provision_reference text,
  access_request_id uuid,
  existing_company_name text
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_draft public.signup_drafts%rowtype;
  v_user_email text;
  v_existing_company_id uuid;
  v_existing_company_name text;
  v_request_id uuid;
  v_reference text;
  v_provision record;
  v_membership_active boolean := false;
begin
  select sd.*
  into v_draft
  from public.signup_drafts as sd
  where sd.claimed_by_user_id = p_user_id
    and sd.status in ('ready_for_first_login', 'provisioning', 'failed', 'provisioned', 'access_request_pending')
  order by sd.updated_at desc
  limit 1
  for update;

  if not found then
    return query select 'not_required'::text, null::uuid, null::uuid, 'company'::text, null::text, null::text, null::uuid, null::text;
    return;
  end if;

  select lower(au.email)
  into v_user_email
  from auth.users au
  where au.id = p_user_id;

  if v_user_email is null or v_user_email <> v_draft.login_email then
    raise exception 'signup draft email mismatch' using errcode = '42501';
  end if;

  if v_draft.status = 'access_request_pending' then
    if v_draft.provisioned_company_id is not null then
      select exists (
        select 1
        from public.company_members cm
        where cm.company_id = v_draft.provisioned_company_id
          and cm.user_id = p_user_id
          and public.company_member_is_active(cm.status)
      ) into v_membership_active;

      if v_membership_active then
        update public.signup_drafts as sd
        set status = 'provisioned',
            provision_error = null,
            provision_error_code = null,
            provision_error_category = null,
            provision_error_at = null,
            updated_at = now()
        where sd.id = v_draft.id;

        return query select
          'provisioned'::text,
          v_draft.provisioned_company_id,
          v_draft.provisioned_agency_id,
          coalesce(v_draft.workspace_type, 'company')::text,
          '/app'::text,
          v_draft.provision_reference,
          null::uuid,
          null::text;
        return;
      end if;
    end if;

    select car.id, c.id, c.name
    into v_request_id, v_existing_company_id, v_existing_company_name
    from public.company_access_requests car
    join public.companies c on c.id = car.company_id
    where car.requester_user_id = p_user_id
      and car.status = 'pending'
    order by car.created_at desc
    limit 1;

    return query select
      'access_request_pending'::text,
      coalesce(v_existing_company_id, v_draft.provisioned_company_id),
      null::uuid,
      coalesce(v_draft.workspace_type, 'company')::text,
      '/access-pending'::text,
      v_draft.provision_reference,
      v_request_id,
      v_existing_company_name;
    return;
  end if;

  if v_draft.status = 'provisioned' and v_draft.provisioned_company_id is not null then
    return query select
      'provisioned'::text,
      v_draft.provisioned_company_id,
      v_draft.provisioned_agency_id,
      coalesce(v_draft.workspace_type, 'company')::text,
      case when v_draft.workspace_type = 'agency' then '/onboarding/agency' else '/onboarding/workspace' end,
      v_draft.provision_reference,
      null::uuid,
      null::text;
    return;
  end if;

  if v_draft.org_number is not null then
    select c.id, c.name
    into v_existing_company_id, v_existing_company_name
    from public.companies c
    where c.org_number = v_draft.org_number
      and c.archived_at is null
    order by c.created_at asc
    limit 1;
  end if;

  if v_existing_company_id is not null then
    select exists (
      select 1
      from public.company_members cm
      where cm.company_id = v_existing_company_id
        and cm.user_id = p_user_id
        and public.company_member_is_active(cm.status)
    ) into v_membership_active;

    if v_membership_active then
      update public.signup_drafts as sd
      set status = 'provisioned',
          provisioned_company_id = v_existing_company_id,
          provisioned_agency_id = null,
          provision_reference = coalesce(sd.provision_reference, 'NK-ACCESS-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
          provision_error = null,
          provision_error_code = null,
          provision_error_category = null,
          provision_error_at = null,
          updated_at = now()
      where sd.id = v_draft.id
      returning provision_reference into v_reference;

      return query select
        'provisioned'::text,
        v_existing_company_id,
        null::uuid,
        coalesce(v_draft.workspace_type, 'company')::text,
        '/app'::text,
        v_reference,
        null::uuid,
        v_existing_company_name;
      return;
    end if;

    v_reference := coalesce(v_draft.provision_reference, 'NK-ACCESS-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)));

    insert into public.company_access_requests as car (
      company_id,
      requester_user_id,
      requester_email,
      requested_role,
      status,
      message
    ) values (
      v_existing_company_id,
      p_user_id,
      v_draft.login_email,
      case when v_draft.workspace_type = 'agency' then 'admin' else 'admin' end,
      'pending',
      'Begäran skapad automatiskt när användaren försökte registrera ett bolag som redan finns i Nordklart.'
    )
    on conflict (company_id, requester_user_id) do update
      set requester_email = excluded.requester_email,
          requested_role = case
            when car.status in ('rejected', 'cancelled') then excluded.requested_role
            else car.requested_role
          end,
          status = case
            when car.status in ('rejected', 'cancelled') then 'pending'
            else car.status
          end,
          message = excluded.message,
          updated_at = now()
    returning id into v_request_id;

    update public.signup_drafts as sd
    set status = 'access_request_pending',
        provisioned_company_id = v_existing_company_id,
        provisioned_agency_id = null,
        provision_reference = v_reference,
        provision_error = null,
        provision_error_code = null,
        provision_error_category = null,
        provision_error_at = null,
        updated_at = now()
    where sd.id = v_draft.id;

    begin
      insert into public.auth_audit_events as a (user_id, email, event_type, status, user_agent, metadata)
      values (
        p_user_id,
        v_draft.login_email,
        'company_access_request_created',
        'pending',
        v_draft.user_agent,
        jsonb_build_object(
          'signup_draft_id', v_draft.id,
          'company_id', v_existing_company_id,
          'access_request_id', v_request_id,
          'provision_reference', v_reference
        )
      );
    exception when others then
      null;
    end;

    return query select
      'access_request_pending'::text,
      v_existing_company_id,
      null::uuid,
      coalesce(v_draft.workspace_type, 'company')::text,
      '/access-pending'::text,
      v_reference,
      v_request_id,
      v_existing_company_name;
    return;
  end if;

  select * into v_provision
  from public.provision_verified_signup_draft_v2(p_user_id)
  limit 1;

  if v_provision.provision_state = 'provisioned' and v_provision.company_id is not null then
    update public.company_members cm
    set status = 'active',
        access_source = 'founder_signup',
        approved_by = coalesce(cm.approved_by, p_user_id),
        approved_at = coalesce(cm.approved_at, now()),
        verification_status = case
          when cm.verification_status = 'not_required' then 'self_attested'
          else cm.verification_status
        end,
        updated_at = now()
    where cm.company_id = v_provision.company_id
      and cm.user_id = p_user_id;

    insert into public.company_authorization_attestations as caa (
      company_id,
      user_id,
      attestation_type,
      accepted_at,
      ip_address,
      user_agent,
      metadata
    ) values (
      v_provision.company_id,
      p_user_id,
      'authorized_representative',
      now(),
      v_draft.ip_address,
      v_draft.user_agent,
      jsonb_build_object(
        'source', 'signup',
        'signup_draft_id', v_draft.id,
        'legal_form', v_draft.legal_form,
        'org_number', v_draft.org_number,
        'workspace_type', v_draft.workspace_type
      )
    )
    on conflict (company_id, user_id, attestation_type) do nothing;
  end if;

  return query select
    coalesce(v_provision.provision_state, 'failed')::text,
    v_provision.company_id::uuid,
    v_provision.agency_id::uuid,
    v_provision.workspace_type::text,
    v_provision.onboarding_path::text,
    v_provision.provision_reference::text,
    null::uuid,
    null::text;
end;
$$;

revoke all on function public.provision_authorized_signup_draft_v4(uuid) from public;
grant execute on function public.provision_authorized_signup_draft_v4(uuid) to service_role;

notify pgrst, 'reload schema';
