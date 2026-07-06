-- Fix: provision_authorized_signup_draft_v4 crashed on ambiguous column
-- references at runtime.
--
-- The function's RETURNS TABLE declares output columns named company_id /
-- agency_id / workspace_type. PL/pgSQL's default variable-conflict policy is
-- ERROR, so any statement in the body that references those names
-- unqualified — the `on conflict (company_id, requester_user_id)` target in
-- the duplicate-org access-request branch and the
-- `on conflict (company_id, user_id, attestation_type)` target on the
-- attestation insert — raised `column reference "company_id" is ambiguous`
-- the moment the branch executed. The duplicate-org signup flow (create an
-- access request instead of a second company) therefore always failed and
-- the draft fell into the generic failure path.
--
-- Surfaced by tests/pg/signup-provisioning-recovery.pg.test.ts (v4 coverage
-- added in this batch — the previous suite only exercised v2/v3).
--
-- Fix: `#variable_conflict use_column` — inside SQL statements, ambiguous
-- names resolve to table columns. This cannot change the behavior of any
-- previously working path (those references errored, not misresolved).
-- Body otherwise identical to 20260630120000.
--
-- pg-test: covered-by tests/pg/signup-provisioning-recovery.pg.test.ts

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
#variable_conflict use_column
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
