-- Nordklart signup provisioning recovery.
--
-- A verified account must never be left without a recoverable workspace state.
-- This migration keeps the accounting ledger untouched and replaces the old
-- all-or-nothing activation wrapper with an idempotent core provisioner:
--
--   ready_for_first_login / failed -> core workspace -> provisioned
--
-- Core writes are isolated in a nested PL/pgSQL block. If they fail, the inner
-- writes roll back while the outer function persists a sanitized failure state
-- and a support reference. Non-critical registry/audit work runs afterwards and
-- cannot roll back a finished company workspace.

alter table public.signup_drafts
  add column if not exists provision_error_code text,
  add column if not exists provision_error_category text,
  add column if not exists provision_error_at timestamptz,
  add column if not exists provision_attempt_count integer not null default 0,
  add column if not exists provision_reference text;

create unique index if not exists uq_signup_drafts_provision_reference
  on public.signup_drafts(provision_reference)
  where provision_reference is not null;

create index if not exists idx_signup_drafts_provision_recovery
  on public.signup_drafts(claimed_by_user_id, status, updated_at desc)
  where status in ('ready_for_first_login', 'provisioning', 'failed', 'provisioned');

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
    when p_sqlstate in ('42P01', '42703', '42883') then 'schema_mismatch'
    when p_sqlstate = 'P0001' then 'business_rule'
    else 'workspace_provisioning_failed'
  end;
$$;

create or replace function public.finalize_signup_draft_provisioning_v2(
  p_draft_id uuid,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_draft public.signup_drafts%rowtype;
  v_terms_id uuid;
  v_privacy_id uuid;
  v_snapshot_error_code text;
begin
  select * into v_draft
  from public.signup_drafts
  where id = p_draft_id
    and claimed_by_user_id = p_user_id
    and status = 'provisioned';

  if not found or v_draft.provisioned_company_id is null then
    return;
  end if;

  -- Legal acceptance is additive and may be safely retried. It must not block
  -- the accounting workspace that has already been provisioned.
  select id into v_terms_id
  from public.legal_text_versions
  where document_type = 'terms' and is_active
  order by effective_at desc
  limit 1;

  if v_terms_id is not null then
    insert into public.legal_acceptances (
      user_id, company_id, legal_text_version_id, document_type, source,
      accepted_at, ip_address, user_agent, metadata
    )
    values (
      p_user_id, v_draft.provisioned_company_id, v_terms_id, 'terms', 'register',
      v_draft.accepted_terms_at, null, v_draft.user_agent,
      jsonb_build_object('signup_draft_id', v_draft.id, 'ip_address', v_draft.ip_address)
    )
    on conflict do nothing;
  end if;

  select id into v_privacy_id
  from public.legal_text_versions
  where document_type = 'privacy_policy' and is_active
  order by effective_at desc
  limit 1;

  if v_privacy_id is not null then
    insert into public.legal_acceptances (
      user_id, company_id, legal_text_version_id, document_type, source,
      accepted_at, ip_address, user_agent, metadata
    )
    values (
      p_user_id, v_draft.provisioned_company_id, v_privacy_id, 'privacy_policy', 'register',
      v_draft.accepted_privacy_at, null, v_draft.user_agent,
      jsonb_build_object('signup_draft_id', v_draft.id, 'ip_address', v_draft.ip_address)
    )
    on conflict do nothing;
  end if;

  -- Registry data is optional enrichment. A provider/schema issue must never
  -- rollback a valid company, its owner membership or its onboarding session.
  begin
    insert into public.company_registry_snapshots (
      signup_draft_id,
      company_id,
      provider,
      lookup_status,
      organization_number,
      normalized_data,
      source_payload,
      retrieved_at,
      user_confirmed_at
    )
    values (
      v_draft.id,
      v_draft.provisioned_company_id,
      v_draft.company_registry_source,
      v_draft.company_registry_status,
      v_draft.org_number,
      jsonb_strip_nulls(jsonb_build_object(
        'company_name', v_draft.company_name,
        'legal_form', v_draft.legal_form,
        'address_line1', v_draft.address_line1,
        'postal_code', v_draft.postal_code,
        'city', v_draft.city,
        'contact_email', v_draft.contact_email,
        'phone', v_draft.phone
      )),
      coalesce(v_draft.company_registry_payload, '{}'::jsonb),
      v_draft.company_registry_checked_at,
      now()
    )
    on conflict (company_id, provider) where company_id is not null
    do update set
      signup_draft_id = excluded.signup_draft_id,
      lookup_status = excluded.lookup_status,
      organization_number = excluded.organization_number,
      normalized_data = excluded.normalized_data,
      source_payload = excluded.source_payload,
      retrieved_at = excluded.retrieved_at,
      user_confirmed_at = excluded.user_confirmed_at,
      updated_at = now();
  exception when others then
    get stacked diagnostics v_snapshot_error_code = returned_sqlstate;
    -- Best-effort only. The successful workspace remains available.
    insert into public.auth_audit_events (
      user_id, company_id, email, event_type, status, user_agent, metadata
    )
    values (
      p_user_id, v_draft.provisioned_company_id, v_draft.login_email,
      'signup_workspace_enrichment_failed', 'failed', v_draft.user_agent,
      jsonb_build_object(
        'signup_draft_id', v_draft.id,
        'provision_reference', v_draft.provision_reference,
        'error_category', public.signup_provision_error_category(v_snapshot_error_code)
      )
    );
  end;

  insert into public.auth_audit_events (
    user_id, company_id, email, event_type, status, user_agent, metadata
  )
  values (
    p_user_id, v_draft.provisioned_company_id, v_draft.login_email,
    'signup_workspace_provisioned', 'success', v_draft.user_agent,
    jsonb_build_object(
      'workspace_type', v_draft.workspace_type,
      'agency_id', v_draft.provisioned_agency_id,
      'signup_draft_id', v_draft.id,
      'provision_reference', v_draft.provision_reference
    )
  );
exception when others then
  -- The workspace is already committed at this point. Never turn a completed
  -- signup into a failed one because optional enrichment/audit failed.
  null;
end;
$$;

create or replace function public.provision_verified_signup_draft_v2(p_user_id uuid)
returns table (
  provision_state text,
  company_id uuid,
  agency_id uuid,
  workspace_type text,
  onboarding_path text,
  provision_reference text
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_draft public.signup_drafts%rowtype;
  v_user_email text;
  v_company_id uuid;
  v_agency_id uuid;
  v_team_id uuid;
  v_session_id uuid;
  v_path text;
  v_reference text;
  v_error_code text;
  v_error_message text;
begin
  select * into v_draft
  from public.signup_drafts
  where claimed_by_user_id = p_user_id
    and status in ('ready_for_first_login', 'provisioning', 'failed', 'provisioned')
  order by updated_at desc
  limit 1
  for update;

  if not found then
    return;
  end if;

  select lower(email) into v_user_email
  from auth.users
  where id = p_user_id;

  if v_user_email is null or v_user_email <> v_draft.login_email then
    raise exception 'signup draft email mismatch' using errcode = '42501';
  end if;

  if v_draft.status = 'provisioned' and v_draft.provisioned_company_id is not null then
    return query select
      'provisioned'::text,
      v_draft.provisioned_company_id,
      v_draft.provisioned_agency_id,
      v_draft.workspace_type,
      case when v_draft.workspace_type = 'agency' then '/onboarding/agency' else '/onboarding/workspace' end,
      v_draft.provision_reference;
    return;
  end if;

  if v_draft.expires_at <= now() then
    update public.signup_drafts
    set status = 'expired',
        provision_error = 'Aktiveringsfönstret har gått ut.',
        provision_error_category = 'activation_expired',
        provision_error_at = now()
    where id = v_draft.id;

    return query select
      'failed'::text,
      null::uuid,
      null::uuid,
      v_draft.workspace_type,
      null::text,
      coalesce(v_draft.provision_reference, 'NK-SETUP-EXPIRED');
    return;
  end if;

  if v_draft.status = 'provisioning' and v_draft.updated_at > now() - interval '15 minutes' then
    return query select
      'in_progress'::text,
      null::uuid,
      null::uuid,
      v_draft.workspace_type,
      null::text,
      v_draft.provision_reference;
    return;
  end if;

  v_reference := 'NK-SETUP-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));

  -- This update intentionally sits outside the nested core block. If a core
  -- insert fails, the exception block below can still persist the failed state.
  update public.signup_drafts
  set status = 'provisioning',
      provision_error = null,
      provision_error_code = null,
      provision_error_category = null,
      provision_error_at = null,
      provision_attempt_count = coalesce(provision_attempt_count, 0) + 1,
      provision_reference = v_reference,
      claimed_by_user_id = p_user_id
  where id = v_draft.id;

  begin
    -- The following is the smallest complete accounting workspace. If any
    -- operation fails, this nested block rolls back without leaving a partial
    -- company/team/account plan behind.
    if v_draft.workspace_type = 'agency' then
      insert into public.teams (name, created_by)
      values (v_draft.company_name, p_user_id)
      returning id into v_team_id;

      insert into public.team_members (team_id, user_id, role)
      values (v_team_id, p_user_id, 'owner');
    else
      select tm.team_id into v_team_id
      from public.team_members tm
      where tm.user_id = p_user_id
      order by tm.created_at asc
      limit 1;

      if v_team_id is null then
        insert into public.teams (name, created_by)
        values ('Personal', p_user_id)
        returning id into v_team_id;

        insert into public.team_members (team_id, user_id, role)
        values (v_team_id, p_user_id, 'owner');
      end if;
    end if;

    insert into public.companies (name, org_number, entity_type, created_by, team_id)
    values (v_draft.company_name, v_draft.org_number, v_draft.legal_form, p_user_id, v_team_id)
    returning id into v_company_id;

    insert into public.company_members (company_id, user_id, role)
    values (v_company_id, p_user_id, 'owner')
    on conflict (company_id, user_id) do nothing;

    perform public.seed_chart_of_accounts(v_company_id, v_draft.legal_form);

    insert into public.cash_accounts (
      company_id, ledger_account, currency, name, enabled, is_primary, source
    )
    values (
      v_company_id, '1930', 'SEK', 'Företagskonto (SEK)', true, true, 'manual'
    )
    on conflict (company_id, ledger_account) do nothing;

    insert into public.company_settings (
      user_id, company_id, entity_type, company_name, org_number,
      email, phone, address_line1, address_line2, postal_code, city, country,
      onboarding_complete, onboarding_step
    )
    values (
      p_user_id, v_company_id, v_draft.legal_form, v_draft.company_name, v_draft.org_number,
      v_draft.contact_email, v_draft.phone, v_draft.address_line1, v_draft.address_line2,
      v_draft.postal_code, v_draft.city, v_draft.country, false, 1
    )
    on conflict (company_id) do update set
      company_name = excluded.company_name,
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
      insert into public.agencies (
        name, org_number, contact_email, company_id, legal_form, phone,
        address_line1, address_line2, postal_code, city, country,
        linked_team_id, created_by, status
      )
      values (
        v_draft.company_name, v_draft.org_number, v_draft.contact_email,
        v_company_id, v_draft.legal_form, v_draft.phone,
        v_draft.address_line1, v_draft.address_line2, v_draft.postal_code,
        v_draft.city, v_draft.country, v_team_id, p_user_id, 'active'
      )
      returning id into v_agency_id;

      insert into public.agency_members (agency_id, user_id, role, invited_by)
      values (v_agency_id, p_user_id, 'agency_owner', p_user_id)
      on conflict (agency_id, user_id) do update set
        role = 'agency_owner',
        updated_at = now();

      v_path := 'agency_setup';
    else
      v_path := case
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

    insert into public.onboarding_sessions (
      company_id, user_id, path, status, current_step, progress_percent, metadata
    )
    values (
      v_company_id, p_user_id, v_path, 'in_progress',
      case v_path
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

    if v_path = 'agency_setup' then
      insert into public.onboarding_steps (session_id, company_id, step_code, title, sort_order) values
        (v_session_id, v_company_id, 'agency_profile', 'Byråuppgifter', 10),
        (v_session_id, v_company_id, 'team', 'Bjud in teamet', 20),
        (v_session_id, v_company_id, 'first_client', 'Lägg till första kundbolaget', 30),
        (v_session_id, v_company_id, 'dashboard', 'Öppna byråöversikten', 40);
    elsif v_path = 'bank_automation' then
      insert into public.onboarding_steps (session_id, company_id, step_code, title, sort_order) values
        (v_session_id, v_company_id, 'company', 'Bolagsuppgifter', 10),
        (v_session_id, v_company_id, 'bank', 'Koppla bank', 20),
        (v_session_id, v_company_id, 'transactions', 'Importera transaktioner', 30),
        (v_session_id, v_company_id, 'rules', 'Bekräfta regler', 40),
        (v_session_id, v_company_id, 'review', 'Granska förslag', 50);
    elsif v_path = 'year_end_one_time' then
      insert into public.onboarding_steps (session_id, company_id, step_code, title, sort_order) values
        (v_session_id, v_company_id, 'import', 'Importera SIE', 10),
        (v_session_id, v_company_id, 'fiscal_year', 'Välj räkenskapsår', 20),
        (v_session_id, v_company_id, 'analysis', 'Bokslutskontroller', 30),
        (v_session_id, v_company_id, 'payment', 'Välj bokslut', 40),
        (v_session_id, v_company_id, 'export', 'Skapa exportpaket', 50);
    elsif v_path = 'bankgiro_autogiro' then
      insert into public.onboarding_steps (session_id, company_id, step_code, title, sort_order) values
        (v_session_id, v_company_id, 'business_profile', 'Bolagsuppgifter', 10),
        (v_session_id, v_company_id, 'owners', 'Ägare och verklig huvudman', 20),
        (v_session_id, v_company_id, 'usage', 'Användning och volym', 30),
        (v_session_id, v_company_id, 'documents', 'Dokument', 40),
        (v_session_id, v_company_id, 'review', 'Granskning', 50);
    else
      insert into public.onboarding_steps (session_id, company_id, step_code, title, sort_order) values
        (v_session_id, v_company_id, 'company', 'Bolagsuppgifter', 10),
        (v_session_id, v_company_id, 'fiscal_year', 'Räkenskapsår', 20),
        (v_session_id, v_company_id, 'vat_period', 'Momsperiod', 30),
        (v_session_id, v_company_id, 'plan', 'Välj prisplan', 40),
        (v_session_id, v_company_id, 'dashboard', 'Öppna översikten', 50);
    end if;

    -- The company/byrå profile was collected and validated during signup.
    -- Mark only that persisted step complete; later accounting, bank and
    -- payment work remains pending until the user completes it in the product.
    if v_path in ('bookkeeping_direct', 'bank_automation') then
      update public.onboarding_steps
      set status = 'completed', completed_at = now()
      where session_id = v_session_id and step_code = 'company';

      update public.onboarding_sessions
      set current_step = case when v_path = 'bank_automation' then 'bank' else 'fiscal_year' end,
          progress_percent = 25,
          updated_at = now()
      where id = v_session_id;
    elsif v_path = 'agency_setup' then
      update public.onboarding_steps
      set status = 'completed', completed_at = now()
      where session_id = v_session_id and step_code = 'agency_profile';

      update public.onboarding_sessions
      set current_step = 'team', progress_percent = 25, updated_at = now()
      where id = v_session_id;
    end if;

    insert into public.user_preferences (
      user_id, active_company_id, active_workspace_type, active_agency_id
    )
    values (
      p_user_id,
      v_company_id,
      case when v_draft.workspace_type = 'agency' then 'agency' else 'company' end,
      v_agency_id
    )
    on conflict (user_id) do update set
      active_company_id = excluded.active_company_id,
      active_workspace_type = excluded.active_workspace_type,
      active_agency_id = excluded.active_agency_id,
      updated_at = now();

    update public.signup_drafts
    set status = 'provisioned',
        provisioned_company_id = v_company_id,
        provisioned_agency_id = v_agency_id,
        provision_error = null,
        provision_error_code = null,
        provision_error_category = null,
        provision_error_at = null
    where id = v_draft.id;
  exception when others then
    get stacked diagnostics
      v_error_code = returned_sqlstate,
      v_error_message = message_text;
  end;

  if v_error_code is not null then
    update public.signup_drafts
    set status = 'failed',
        provision_error = left(coalesce(v_error_message, 'workspace provisioning failed'), 500),
        provision_error_code = v_error_code,
        provision_error_category = public.signup_provision_error_category(v_error_code),
        provision_error_at = now(),
        provisioned_company_id = null,
        provisioned_agency_id = null
    where id = v_draft.id;

    begin
      insert into public.auth_audit_events (
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

    return query select
      'failed'::text,
      null::uuid,
      null::uuid,
      v_draft.workspace_type,
      null::text,
      v_reference;
    return;
  end if;

  -- Separate best-effort work after the core workspace was successfully
  -- committed. Its own failures are intentionally isolated.
  begin
    perform public.finalize_signup_draft_provisioning_v2(v_draft.id, p_user_id);
  exception when others then
    null;
  end;

  return query select
    'provisioned'::text,
    v_company_id,
    v_agency_id,
    v_draft.workspace_type,
    case when v_draft.workspace_type = 'agency' then '/onboarding/agency' else '/onboarding/workspace' end,
    v_reference;
end;
$$;

-- Keep the legacy RPC callable for integrations that still expect its old
-- four-column result. It now delegates to the recoverable implementation and
-- never performs registry work in the critical transaction.
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
    p.company_id,
    p.agency_id,
    p.workspace_type,
    p.onboarding_path
  from public.provision_verified_signup_draft_v2(p_user_id) p
  where p.provision_state = 'provisioned';
$$;

revoke all on function public.finalize_signup_draft_provisioning_v2(uuid, uuid) from public;
revoke all on function public.provision_verified_signup_draft_v2(uuid) from public;
revoke all on function public.provision_verified_signup_draft(uuid) from public;
grant execute on function public.finalize_signup_draft_provisioning_v2(uuid, uuid) to service_role;
grant execute on function public.provision_verified_signup_draft_v2(uuid) to service_role;
grant execute on function public.provision_verified_signup_draft(uuid) to service_role;

notify pgrst, 'reload schema';
