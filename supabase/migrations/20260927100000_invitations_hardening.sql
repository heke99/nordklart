-- Invitation hardening.
--
-- 1. A company admin could promote themselves to owner: RLS let any admin
--    INSERT/UPDATE company_invitations directly (role CHECK allowed 'owner'),
--    and the accept route then wrote the membership with the service role,
--    which the owner-role triggers let through. Invitations are now written
--    only by the service-role routes, which authorize the caller and never
--    offer 'owner'; the CHECK refuses 'owner' for new and changed rows.
-- 2. token_hash is no longer readable through the API for either invitation
--    table, and only company admins can list company invitations.
-- 3. accept_invitation() accepts a company or agency invitation in one
--    transaction: it locks the invitation, checks status, expiry and e-mail,
--    creates or re-activates the membership without ever lowering a role,
--    refuses suspended memberships, marks the invitation accepted and points
--    user_preferences at a workspace the user can actually open. The route,
--    the invite-signup flow and the login handoff all use it.
--
-- pg-test: tests/pg/invitation-accept.pg.test.ts

-- ---------------------------------------------------------------------------
-- 1 + 2. company_invitations / agency_invitations API surface
-- ---------------------------------------------------------------------------
drop policy if exists company_invitations_insert on public.company_invitations;
drop policy if exists company_invitations_update on public.company_invitations;
drop policy if exists company_invitations_delete on public.company_invitations;
drop policy if exists company_invitations_select on public.company_invitations;

create policy company_invitations_select on public.company_invitations
  for select to authenticated
  using (public.user_is_company_admin(company_id));

revoke insert, update, delete, truncate on public.company_invitations from anon, authenticated;
revoke select on public.company_invitations from anon, authenticated;
grant select (id, company_id, email, role, membership_kind, status, invited_by, expires_at,
              created_at, updated_at, accepted_by, accepted_at, revoked_by, revoked_at)
  on public.company_invitations to authenticated;

revoke select on public.agency_invitations from anon, authenticated;
grant select (id, agency_id, email, role, status, invited_by, accepted_by, accepted_at,
              revoked_by, revoked_at, expires_at, metadata, created_at, updated_at)
  on public.agency_invitations to authenticated;

-- Pending owner invitations cannot have been created by the app (the route
-- never offers 'owner'); revoke any that exist before tightening the CHECK.
update public.company_invitations
   set status = 'revoked', revoked_at = now()
 where role = 'owner' and status = 'pending';

alter table public.company_invitations drop constraint if exists company_invitations_role_check;
-- NOT VALID keeps historical accepted rows readable; every new or changed row
-- is checked.
alter table public.company_invitations
  add constraint company_invitations_role_check
  check (role in ('admin', 'member', 'viewer', 'accountant', 'auditor')) not valid;

-- ---------------------------------------------------------------------------
-- 3. accept_invitation
-- ---------------------------------------------------------------------------
create or replace function public.accept_invitation(p_token_hash text, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text;
  v_now timestamptz := now();
  v_ci public.company_invitations%rowtype;
  v_ai public.agency_invitations%rowtype;
  v_cm public.company_members%rowtype;
  v_am public.agency_members%rowtype;
  v_role text;
  v_kind text;
  v_archived timestamptz;
  v_agency_status text;
  v_client_company uuid;
begin
  if p_token_hash is null or p_user_id is null then
    raise exception 'token and user are required' using errcode = '22023';
  end if;

  select lower(u.email) into v_email
    from auth.users u
   where u.id = p_user_id;
  if v_email is null then
    return jsonb_build_object('ok', false, 'error', 'user_not_found');
  end if;

  -- Company invitation ------------------------------------------------------
  select * into v_ci
    from public.company_invitations ci
   where ci.token_hash = p_token_hash
   for update;

  if found then
    if v_ci.status <> 'pending' then
      return jsonb_build_object('ok', false, 'error', 'not_pending', 'type', 'company');
    end if;
    if v_ci.expires_at <= v_now then
      update public.company_invitations set status = 'expired' where id = v_ci.id;
      return jsonb_build_object('ok', false, 'error', 'expired', 'type', 'company');
    end if;
    if lower(v_ci.email) <> v_email then
      return jsonb_build_object('ok', false, 'error', 'email_mismatch', 'type', 'company');
    end if;
    if v_ci.role not in ('admin', 'member', 'viewer', 'accountant', 'auditor') then
      return jsonb_build_object('ok', false, 'error', 'role_not_invitable', 'type', 'company');
    end if;

    select c.archived_at into v_archived from public.companies c where c.id = v_ci.company_id;
    if not found or v_archived is not null then
      return jsonb_build_object('ok', false, 'error', 'company_unavailable', 'type', 'company');
    end if;

    select * into v_cm
      from public.company_members cm
     where cm.company_id = v_ci.company_id and cm.user_id = p_user_id
     for update;

    if found then
      if v_cm.status = 'suspended' then
        return jsonb_build_object('ok', false, 'error', 'membership_suspended', 'type', 'company');
      end if;

      -- Keep the higher of the current and the invited role. Same order as
      -- resolve_company_access_for_user's role rank.
      if (case v_cm.role when 'owner' then 90 when 'admin' then 80 when 'accountant' then 55
                         when 'member' then 50 when 'auditor' then 35 else 10 end)
         >= (case v_ci.role when 'admin' then 80 when 'accountant' then 55
                            when 'member' then 50 when 'auditor' then 35 else 10 end) then
        v_role := v_cm.role;
        v_kind := v_cm.membership_kind;
      else
        v_role := v_ci.role;
        v_kind := v_ci.membership_kind;
      end if;

      update public.company_members cm
         set role = v_role,
             membership_kind = v_kind,
             source = 'direct',
             status = 'active',
             access_source = case when cm.status = 'active' then cm.access_source else 'invite' end,
             invited_by = coalesce(cm.invited_by, v_ci.invited_by),
             approved_by = coalesce(v_ci.invited_by, cm.approved_by),
             approved_at = v_now,
             revoked_by = null,
             revoked_at = null
       where cm.id = v_cm.id;
    else
      v_role := v_ci.role;
      v_kind := v_ci.membership_kind;
      insert into public.company_members
        (company_id, user_id, role, source, status, access_source, membership_kind,
         invited_by, approved_by, approved_at)
      values
        (v_ci.company_id, p_user_id, v_role, 'direct', 'active', 'invite', v_kind,
         v_ci.invited_by, v_ci.invited_by, v_now);
    end if;

    update public.company_invitations
       set status = 'accepted', accepted_by = p_user_id, accepted_at = v_now
     where id = v_ci.id;

    insert into public.user_preferences (user_id, active_company_id, active_workspace_type, active_agency_id)
    values (p_user_id, v_ci.company_id, 'company', null)
    on conflict (user_id) do update
      set active_company_id = excluded.active_company_id,
          active_workspace_type = 'company',
          active_agency_id = null;

    return jsonb_build_object('ok', true, 'type', 'company', 'company_id', v_ci.company_id, 'role', v_role);
  end if;

  -- Agency invitation -------------------------------------------------------
  select * into v_ai
    from public.agency_invitations ai
   where ai.token_hash = p_token_hash
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if v_ai.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', 'not_pending', 'type', 'agency');
  end if;
  if v_ai.expires_at <= v_now then
    update public.agency_invitations set status = 'expired' where id = v_ai.id;
    return jsonb_build_object('ok', false, 'error', 'expired', 'type', 'agency');
  end if;
  if lower(v_ai.email) <> v_email then
    return jsonb_build_object('ok', false, 'error', 'email_mismatch', 'type', 'agency');
  end if;

  select a.status into v_agency_status from public.agencies a where a.id = v_ai.agency_id;
  if not found or v_agency_status <> 'active' then
    return jsonb_build_object('ok', false, 'error', 'agency_unavailable', 'type', 'agency');
  end if;

  select * into v_am
    from public.agency_members am
   where am.agency_id = v_ai.agency_id and am.user_id = p_user_id
   for update;

  if found then
    if v_am.status = 'suspended' then
      return jsonb_build_object('ok', false, 'error', 'membership_suspended', 'type', 'agency');
    end if;
    if (case v_am.role when 'agency_owner' then 5 when 'agency_admin' then 4 when 'accountant' then 3
                       when 'payroll' then 3 when 'reviewer' then 2 else 1 end)
       >= (case v_ai.role when 'agency_admin' then 4 when 'accountant' then 3
                          when 'payroll' then 3 when 'reviewer' then 2 else 1 end) then
      v_role := v_am.role;
    else
      v_role := v_ai.role;
    end if;

    update public.agency_members am
       set role = v_role,
           status = 'active',
           invited_by = coalesce(am.invited_by, v_ai.invited_by),
           joined_at = case when am.status = 'active' then am.joined_at else v_now end
     where am.id = v_am.id;
  else
    v_role := v_ai.role;
    insert into public.agency_members (agency_id, user_id, role, status, invited_by, joined_at)
    values (v_ai.agency_id, p_user_id, v_role, 'active', v_ai.invited_by, v_now);
  end if;

  update public.agency_invitations
     set status = 'accepted', accepted_by = p_user_id, accepted_at = v_now
   where id = v_ai.id;

  -- Open a client of the agency if there is one; staff do not get access to
  -- the agency's own books, so pointing at agencies.company_id would bounce.
  select ac.company_id into v_client_company
    from public.agency_clients ac
    join public.companies c on c.id = ac.company_id and c.archived_at is null
   where ac.agency_id = v_ai.agency_id and ac.status = 'active'
   order by c.name
   limit 1;

  insert into public.user_preferences (user_id, active_company_id, active_workspace_type, active_agency_id)
  values (p_user_id, v_client_company, 'agency', v_ai.agency_id)
  on conflict (user_id) do update
    set active_company_id = coalesce(excluded.active_company_id, user_preferences.active_company_id),
        active_workspace_type = 'agency',
        active_agency_id = excluded.active_agency_id;

  return jsonb_build_object('ok', true, 'type', 'agency', 'agency_id', v_ai.agency_id,
                            'company_id', v_client_company, 'role', v_role);
end;
$$;

revoke all on function public.accept_invitation(text, uuid) from public, anon, authenticated;
grant execute on function public.accept_invitation(text, uuid) to service_role;

comment on function public.accept_invitation(text, uuid) is
  'Accepts a company or agency invitation atomically. Service role only; callers authenticate the user first.';
