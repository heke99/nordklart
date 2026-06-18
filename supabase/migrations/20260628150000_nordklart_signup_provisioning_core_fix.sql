-- Nordklart signup provisioning core fix.
--
-- Replaces the recovery v2 PL/pgSQL return-table implementation. Its output
-- columns (company_id / agency_id) became PL/pgSQL variables and collided with
-- INSERT ... ON CONFLICT column references (SQLSTATE 42702). The new core
-- returns a JSON payload, so all internal identifiers are explicitly named
-- v_result_* and no output-column variables exist inside critical SQL.
--
-- The public v2 and legacy RPCs keep their existing row contracts and delegate
-- to this single idempotent core. Accounting records remain untouched.

create or replace function public.signup_provision_error_category(p_sqlstate text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when p_sqlstate = '23505' then 'duplicate_data'
    when p_sqlstate = '23503' then 'reference_constraint'
    when p_sqlstate = '23514' then 'validation_constraint'
    when p_sqlstate in ('42501', '28000') then 'permission_denied'
    when p_sqlstate in ('42P01', '42702', '42703', '42883') then 'schema_mismatch'
    when p_sqlstate = 'P0001' then 'business_rule'
    else 'workspace_provisioning_failed'
  end;
$$;

create or replace function public.provision_verified_signup_draft_core_v3(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_draft public.signup_drafts%rowtype;
  v_user_email text;
  v_result_company_id uuid;
  v_result_agency_id uuid;
  v_team_id uuid;
  v_session_id uuid;
  v_onboarding_path text;
  v_reference text;
  v_error_code text;
  v_error_message text;
begin
  select sd.*
  into v_draft
  from public.signup_drafts as sd
  where sd.claimed_by_user_id = p_user_id
    and sd.status in ('ready_for_first_login', 'provisioning', 'failed', 'provisioned')
  order by sd.updated_at desc
  limit 1
  for update;

  if not found then
    return jsonb_build_object('provision_state', 'not_required');
  end if;

  select lower(au.email)
  into v_user_email
  from auth.users as au
  where au.id = p_user_id;

  if v_user_email is null or v_user_email <> v_draft.login_email then
    raise exception 'signup draft email mismatch' using errcode = '42501';
  end if;

  if v_draft.status = 'provisioned' and v_draft.provisioned_company_id is not null then
    return jsonb_build_object(
      'provision_state', 'provisioned',
      'company_id', v_draft.provisioned_company_id::text,
      'agency_id', v_draft.provisioned_agency_id::text,
      'workspace_type', v_draft.workspace_type,
      'onboarding_path', case when v_draft.workspace_type = 'agency' then '/onboarding/agency' else '/onboarding/workspace' end,
      'provision_reference', v_draft.provision_reference
    );
  end if;

  if v_draft.expires_at <= now() then
    update public.signup_drafts as sd
    set status = 'expired',
        provision_error = 'Aktiveringsfönstret har gått ut.',
        provision_error_code = 'P0001',
        provision_error_category = 'activation_expired',
        provision_error_at = now()
    where sd.id = v_draft.id;

    return jsonb_build_object(
      'provision_state', 'failed',
      'workspace_type', v_draft.workspace_type,
      'provision_reference', coalesce(v_draft.provision_reference, 'NK-SETUP-EXPIRED')
    );
  end if;

  if v_draft.status = 'provisioning' and v_draft.updated_at > now() - interval '15 minutes' then
    return jsonb_build_object(
      'provision_state', 'in_progress',
      'workspace_type', v_draft.workspace_type,
      'provision_reference', v_draft.provision_reference
    );
  end if;

  v_reference := 'NK-SETUP-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));

  -- This state update is intentionally outside the nested core block. A
  -- subtransaction rollback can then be recorded as a durable failed draft.
  update public.signup_drafts as sd
  set status = 'provisioning',
      provision_error = null,
      provision_error_code = null,
      provision_error_category = null,
      provision_error_at = null,
      provision_attempt_count = coalesce(sd.provision_attempt_count, 0) + 1,
      provision_reference = v_reference,
      claimed_by_user_id = p_user_id
  where sd.id = v_draft.id;

  begin
    -- Compatibility teams remain a required bridge for existing team-aware
    -- product surfaces. New agencies receive their own named team.
    if v_draft.workspace_type = 'agency' then
      insert into public.teams as t (name, created_by)
      values (v_draft.company_name, p_user_id)
      returning id into v_team_id;

      insert into public.team_members as tm (team_id, user_id, role)
      values (v_team_id, p_user_id, 'owner')
      on conflict (team_id, user_id) do update
        set role = excluded.role,
            updated_at = now();
    else
      select tm.team_id
      into v_team_id
      from public.team_members as tm
      where tm.user_id = p_user_id
      order by tm.created_at asc
      limit 1;

      if v_team_id is null then
        insert into public.teams as t (name, created_by)
        values ('Personal', p_user_id)
        returning id into v_team_id;

        insert into public.team_members as tm (team_id, user_id, role)
        values (v_team_id, p_user_id, 'owner')
        on conflict (team_id, user_id) do update
          set role = excluded.role,
              updated_at = now();
      end if;
    end if;

    insert into public.companies as c (name, org_number, entity_type, created_by, team_id)
    values (v_draft.company_name, v_draft.org_number, v_draft.legal_form, p_user_id, v_team_id)
    returning id into v_result_company_id;

    insert into public.company_members as cm (company_id, user_id, role)
    values (v_result_company_id, p_user_id, 'owner')
    on conflict (company_id, user_id) do update
      set role = excluded.role,
          updated_at = now();

    perform public.seed_chart_of_accounts(v_result_company_id, v_draft.legal_form);

    insert into public.cash_accounts as ca (
      company_id, ledger_account, currency, name, enabled, is_primary, source
    )
    values (
      v_result_company_id, '1930', 'SEK', 'Företagskonto (SEK)', true, true, 'manual'
    )
    on conflict (company_id, ledger_account) do update
      set enabled = true,
          is_primary = true,
          updated_at = now();

    insert into public.company_settings as cs (
      user_id, company_id, entity_type, company_name, org_number,
      email, phone, address_line1, address_line2, postal_code, city, country,
      onboarding_complete, onboarding_step
    )
    values (
      p_user_id, v_result_company_id, v_draft.legal_form, v_draft.company_name, v_draft.org_number,
      v_draft.contact_email, v_draft.phone, v_draft.address_line1, v_draft.address_line2,
      v_draft.postal_code, v_draft.city, v_draft.country, false, 1
    )
    on conflict (company_id) do update
      set company_name = excluded.company_name,
          org_number = excluded.org_number,
          email = excluded.email,
          phone = excluded.phone,
          address_line1 = excluded.address_line1,
          address_line2 = excluded.address_line2,
          postal_code = excluded.postal_code,
          city = excluded.city,
          country = excluded.country,
          updated_at = now();

    if v_draft.workspace_type = 'agency' then
      insert into public.agencies as a (
        name, org_number, contact_email, company_id, legal_form, phone,
        address_line1, address_line2, postal_code, city, country,
        linked_team_id, created_by, status
      )
      values (
        v_draft.company_name, v_draft.org_number, v_draft.contact_email,
        v_result_company_id, v_draft.legal_form, v_draft.phone,
        v_draft.address_line1, v_draft.address_line2, v_draft.postal_code,
        v_draft.city, v_draft.country, v_team_id, p_user_id, 'active'
      )
      on conflict (company_id) where company_id is not null do update
        set name = excluded.name,
            org_number = excluded.org_number,
            contact_email = excluded.contact_email,
            legal_form = excluded.legal_form,
            phone = excluded.phone,
            address_line1 = excluded.address_line1,
            address_line2 = excluded.address_line2,
            postal_code = excluded.postal_code,
            city = excluded.city,
            country = excluded.country,
            linked_team_id = excluded.linked_team_id,
            updated_at = now()
      returning id into v_result_agency_id;

      insert into public.agency_members as am (agency_id, user_id, role, invited_by)
      values (v_result_agency_id, p_user_id, 'agency_owner', p_user_id)
      on conflict (agency_id, user_id) do update
        set role = excluded.role,
            updated_at = now();

      v_onboarding_path := 'agency_setup';
    else
      v_onboarding_path := case
        when lower(coalesce(v_draft.onboarding_intent, '')) in (
          'auto', 'automation', 'bank-automation', 'automated-bookkeeping'
        ) then 'bank_automation'
        when lower(coalesce(v_draft.onboarding_intent, '')) in (
          'year_end', 'year-end', 'bokslut'
        ) then 'year_end_one_time'
        when lower(coalesce(v_draft.onboarding_intent, '')) in (
          'bankgiro', 'autogiro'
        ) then 'bankgiro_autogiro'
        else 'bookkeeping_direct'
      end;
    end if;

    insert into public.onboarding_sessions as os (
      company_id, user_id, path, status, current_step, progress_percent, metadata
    )
    values (
      v_result_company_id, p_user_id, v_onboarding_path, 'in_progress',
      case v_onboarding_path
        when 'bank_automation' then 'bank'
        when 'year_end_one_time' then 'import'
        when 'bankgiro_autogiro' then 'business_profile'
        when 'agency_setup' then 'agency_profile'
        else 'company'
      end,
      10,
      jsonb_build_object('source', 'signup_draft', 'workspace_type', v_draft.workspace_type)
    )
    returning id into v_session_id;

    if v_onboarding_path = 'agency_setup' then
      insert into public.onboarding_steps as os (session_id, company_id, step_code, title, sort_order) values
        (v_session_id, v_result_company_id, 'agency_profile', 'Byråuppgifter', 10),
        (v_session_id, v_result_company_id, 'team', 'Bjud in teamet', 20),
        (v_session_id, v_result_company_id, 'first_client', 'Lägg till första kundbolaget', 30),
        (v_session_id, v_result_company_id, 'dashboard', 'Öppna byråöversikten', 40);
    elsif v_onboarding_path = 'bank_automation' then
      insert into public.onboarding_steps as os (session_id, company_id, step_code, title, sort_order) values
        (v_session_id, v_result_company_id, 'company', 'Bolagsuppgifter', 10),
        (v_session_id, v_result_company_id, 'bank', 'Koppla bank', 20),
        (v_session_id, v_result_company_id, 'transactions', 'Importera transaktioner', 30),
        (v_session_id, v_result_company_id, 'rules', 'Bekräfta regler', 40),
        (v_session_id, v_result_company_id, 'review', 'Granska förslag', 50);
    elsif v_onboarding_path = 'year_end_one_time' then
      insert into public.onboarding_steps as os (session_id, company_id, step_code, title, sort_order) values
        (v_session_id, v_result_company_id, 'import', 'Importera SIE', 10),
        (v_session_id, v_result_company_id, 'fiscal_year', 'Välj räkenskapsår', 20),
        (v_session_id, v_result_company_id, 'analysis', 'Bokslutskontroller', 30),
        (v_session_id, v_result_company_id, 'payment', 'Välj bokslut', 40),
        (v_session_id, v_result_company_id, 'export', 'Skapa exportpaket', 50);
    elsif v_onboarding_path = 'bankgiro_autogiro' then
      insert into public.onboarding_steps as os (session_id, company_id, step_code, title, sort_order) values
        (v_session_id, v_result_company_id, 'business_profile', 'Bolagsuppgifter', 10),
        (v_session_id, v_result_company_id, 'owners', 'Ägare och verklig huvudman', 20),
        (v_session_id, v_result_company_id, 'usage', 'Användning och volym', 30),
        (v_session_id, v_result_company_id, 'documents', 'Dokument', 40),
        (v_session_id, v_result_company_id, 'review', 'Granskning', 50);
    else
      insert into public.onboarding_steps as os (session_id, company_id, step_code, title, sort_order) values
        (v_session_id, v_result_company_id, 'company', 'Bolagsuppgifter', 10),
        (v_session_id, v_result_company_id, 'fiscal_year', 'Räkenskapsår', 20),
        (v_session_id, v_result_company_id, 'vat_period', 'Momsperiod', 30),
        (v_session_id, v_result_company_id, 'plan', 'Välj prisplan', 40),
        (v_session_id, v_result_company_id, 'dashboard', 'Öppna översikten', 50);
    end if;

    if v_onboarding_path in ('bookkeeping_direct', 'bank_automation') then
      update public.onboarding_steps as os
      set status = 'completed', completed_at = now()
      where os.session_id = v_session_id
        and os.step_code = 'company';

      update public.onboarding_sessions as os
      set current_step = case when v_onboarding_path = 'bank_automation' then 'bank' else 'fiscal_year' end,
          progress_percent = 25,
          updated_at = now()
      where os.id = v_session_id;
    elsif v_onboarding_path = 'agency_setup' then
      update public.onboarding_steps as os
      set status = 'completed', completed_at = now()
      where os.session_id = v_session_id
        and os.step_code = 'agency_profile';

      update public.onboarding_sessions as os
      set current_step = 'team', progress_percent = 25, updated_at = now()
      where os.id = v_session_id;
    end if;

    insert into public.user_preferences as up (
      user_id, active_company_id, active_workspace_type, active_agency_id
    )
    values (
      p_user_id,
      v_result_company_id,
      case when v_draft.workspace_type = 'agency' then 'agency' else 'company' end,
      v_result_agency_id
    )
    on conflict (user_id) do update
      set active_company_id = excluded.active_company_id,
          active_workspace_type = excluded.active_workspace_type,
          active_agency_id = excluded.active_agency_id,
          updated_at = now();

    update public.signup_drafts as sd
    set status = 'provisioned',
        provisioned_company_id = v_result_company_id,
        provisioned_agency_id = v_result_agency_id,
        provision_error = null,
        provision_error_code = null,
        provision_error_category = null,
        provision_error_at = null
    where sd.id = v_draft.id;
  exception when others then
    get stacked diagnostics
      v_error_code = returned_sqlstate,
      v_error_message = message_text;
  end;

  if v_error_code is not null then
    update public.signup_drafts as sd
    set status = 'failed',
        provision_error = left(coalesce(v_error_message, 'workspace provisioning failed'), 500),
        provision_error_code = v_error_code,
        provision_error_category = public.signup_provision_error_category(v_error_code),
        provision_error_at = now(),
        provisioned_company_id = null,
        provisioned_agency_id = null
    where sd.id = v_draft.id;

    begin
      insert into public.auth_audit_events as a (
        user_id, email, event_type, status, user_agent, metadata
      )
      values (
        p_user_id, v_draft.login_email, 'signup_workspace_provisioning_failed',
        'failed', v_draft.user_agent,
        jsonb_build_object(
          'signup_draft_id', v_draft.id,
          'provision_reference', v_reference,
          'error_code', v_error_code,
          'error_category', public.signup_provision_error_category(v_error_code)
        )
      );
    exception when others then
      null;
    end;

    return jsonb_build_object(
      'provision_state', 'failed',
      'workspace_type', v_draft.workspace_type,
      'provision_reference', v_reference
    );
  end if;

  -- Post-provision enrichment is intentionally best effort. It is isolated in
  -- its own exception block and cannot turn a committed workspace into failed.
  begin
    perform public.finalize_signup_draft_provisioning_v2(v_draft.id, p_user_id);
  exception when others then
    null;
  end;

  return jsonb_build_object(
    'provision_state', 'provisioned',
    'company_id', v_result_company_id::text,
    'agency_id', v_result_agency_id::text,
    'workspace_type', v_draft.workspace_type,
    'onboarding_path', case when v_draft.workspace_type = 'agency' then '/onboarding/agency' else '/onboarding/workspace' end,
    'provision_reference', v_reference
  );
end;
$$;

-- Public API shape remains stable for Next.js and PostgREST. The SQL wrapper
-- deliberately has no PL/pgSQL output variables, so company_id/agency_id can
-- never shadow table columns in provisioning writes.
create or replace function public.provision_verified_signup_draft_v2(p_user_id uuid)
returns table (
  provision_state text,
  company_id uuid,
  agency_id uuid,
  workspace_type text,
  onboarding_path text,
  provision_reference text
)
language sql
security definer
set search_path = public
as $$
  with outcome as (
    select public.provision_verified_signup_draft_core_v3(p_user_id) as payload
  )
  select
    coalesce(outcome.payload ->> 'provision_state', 'failed')::text,
    nullif(outcome.payload ->> 'company_id', '')::uuid,
    nullif(outcome.payload ->> 'agency_id', '')::uuid,
    coalesce(outcome.payload ->> 'workspace_type', 'company')::text,
    nullif(outcome.payload ->> 'onboarding_path', '')::text,
    nullif(outcome.payload ->> 'provision_reference', '')::text
  from outcome;
$$;

-- Legacy integrations retain their old four-column result but no longer have
-- their own provisioning logic or registry work.
create or replace function public.provision_verified_signup_draft(p_user_id uuid)
returns table (
  company_id uuid,
  agency_id uuid,
  workspace_type text,
  onboarding_path text
)
language sql
security definer
set search_path = public
as $$
  select
    provision.company_id,
    provision.agency_id,
    provision.workspace_type,
    provision.onboarding_path
  from public.provision_verified_signup_draft_v2(p_user_id) as provision
  where provision.provision_state = 'provisioned';
$$;

-- The pre-v2 signature is kept only for server compatibility. It validates the
-- stored hash and then delegates to the same core. It never creates a workspace
-- from a pending/unverified draft.
create or replace function public.provision_signup_draft(
  p_draft_id uuid,
  p_user_id uuid,
  p_token_hash text
)
returns table (
  company_id uuid,
  agency_id uuid,
  workspace_type text,
  onboarding_path text
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_draft public.signup_drafts%rowtype;
begin
  select sd.*
  into v_draft
  from public.signup_drafts as sd
  where sd.id = p_draft_id
  for update;

  if not found or v_draft.token_hash <> p_token_hash then
    raise exception 'invalid signup draft token' using errcode = '42501';
  end if;

  if v_draft.claimed_by_user_id is distinct from p_user_id then
    raise exception 'signup draft is not claimed by this user' using errcode = '42501';
  end if;

  if v_draft.status not in ('ready_for_first_login', 'failed', 'provisioned') then
    raise exception 'signup draft is not ready for workspace provisioning' using errcode = 'P0001';
  end if;

  return query
  select
    provision.company_id,
    provision.agency_id,
    provision.workspace_type,
    provision.onboarding_path
  from public.provision_verified_signup_draft_v2(p_user_id) as provision
  where provision.provision_state = 'provisioned';
end;
$$;

revoke all on function public.provision_verified_signup_draft_core_v3(uuid) from public;
revoke all on function public.provision_verified_signup_draft_v2(uuid) from public;
revoke all on function public.provision_verified_signup_draft(uuid) from public;
revoke all on function public.provision_signup_draft(uuid, uuid, text) from public;

grant execute on function public.provision_verified_signup_draft_core_v3(uuid) to service_role;
grant execute on function public.provision_verified_signup_draft_v2(uuid) to service_role;
grant execute on function public.provision_verified_signup_draft(uuid) to service_role;
grant execute on function public.provision_signup_draft(uuid, uuid, text) to service_role;

notify pgrst, 'reload schema';
