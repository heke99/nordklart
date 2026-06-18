-- Nordklart workspace + signup foundation (parts 1-4).
-- Keeps the accounting ledger immutable. This migration only adds identity,
-- workspace and access foundation around existing companies and agencies.

-- -----------------------------------------------------------------------------
-- 1. Workspace metadata and agency identity
-- -----------------------------------------------------------------------------

alter table public.user_preferences
  add column if not exists active_workspace_type text not null default 'company',
  add column if not exists active_agency_id uuid references public.agencies(id) on delete set null;

alter table public.user_preferences
  drop constraint if exists user_preferences_active_workspace_type_check;
alter table public.user_preferences
  add constraint user_preferences_active_workspace_type_check
  check (active_workspace_type in ('company', 'agency', 'platform'));

alter table public.agencies
  add column if not exists company_id uuid references public.companies(id) on delete set null,
  add column if not exists legal_form text,
  add column if not exists phone text,
  add column if not exists address_line1 text,
  add column if not exists address_line2 text,
  add column if not exists postal_code text,
  add column if not exists city text,
  add column if not exists country text not null default 'SE';

alter table public.agencies
  drop constraint if exists agencies_legal_form_check;
alter table public.agencies
  add constraint agencies_legal_form_check
  check (legal_form is null or legal_form in ('enskild_firma', 'aktiebolag'));

create unique index if not exists uq_agencies_company_id
  on public.agencies(company_id)
  where company_id is not null;

create index if not exists idx_user_preferences_active_agency
  on public.user_preferences(active_agency_id)
  where active_agency_id is not null;

-- Existing agencies created from legacy teams may not be linkable automatically
-- without guessing the agency's legal entity. New signup provisioning always
-- sets company_id; legacy rows stay intact for manual review/backfill.

-- -----------------------------------------------------------------------------
-- 2. Registration drafts: no company or privileges are created before verified
-- email. The token is random, stored only as a hash and consumed once.
-- -----------------------------------------------------------------------------

create table if not exists public.signup_drafts (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  status text not null default 'pending_verification'
    check (status in ('pending_verification', 'provisioning', 'provisioned', 'expired', 'cancelled', 'failed')),
  login_email text not null,
  first_name text not null,
  last_name text not null,
  workspace_type text not null check (workspace_type in ('company', 'agency')),
  legal_form text not null check (legal_form in ('enskild_firma', 'aktiebolag')),
  company_name text not null,
  org_number text,
  contact_email text not null,
  phone text,
  address_line1 text,
  address_line2 text,
  postal_code text,
  city text,
  country text not null default 'SE',
  onboarding_intent text,
  accepted_terms_at timestamptz not null,
  accepted_privacy_at timestamptz not null,
  ip_address text,
  user_agent text,
  claimed_by_user_id uuid references auth.users(id) on delete set null,
  provisioned_company_id uuid references public.companies(id) on delete set null,
  provisioned_agency_id uuid references public.agencies(id) on delete set null,
  provision_error text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (login_email = lower(login_email)),
  check (contact_email = lower(contact_email))
);

create index if not exists idx_signup_drafts_pending_email
  on public.signup_drafts(login_email, expires_at)
  where status = 'pending_verification';
create index if not exists idx_signup_drafts_user
  on public.signup_drafts(claimed_by_user_id)
  where claimed_by_user_id is not null;

alter table public.signup_drafts enable row level security;
grant select, insert, update on table public.signup_drafts to service_role;
-- No user-facing policies. Drafts are created and consumed only through server
-- routes/service role, which prevents enumeration and cross-user draft reads.

drop trigger if exists signup_drafts_updated_at on public.signup_drafts;
create trigger signup_drafts_updated_at
  before update on public.signup_drafts
  for each row execute function public.update_updated_at_column();

-- -----------------------------------------------------------------------------
-- 3. Central company access resolver. It is intentionally independent of the
-- old team sync and resolves direct membership, agency access and platform
-- administration in one place.
-- -----------------------------------------------------------------------------

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
      case cm.role when 'owner' then 90 when 'admin' then 80 when 'member' then 50 else 10 end
    from public.company_members cm
    where cm.company_id = p_company_id
      and cm.user_id = auth.uid()

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
    effective_role in ('platform_admin', 'company_owner', 'company_admin', 'accountant', 'client_user') as can_write,
    effective_role in ('platform_admin', 'company_owner', 'company_admin', 'accountant', 'reviewer') as can_review,
    effective_role in ('platform_admin', 'company_owner', 'company_admin') as can_manage_company,
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

-- Most company-scoped RLS policies already depend on user_company_ids(). Keep
-- that mature policy surface aligned with the same agency/platform resolver
-- instead of duplicating direct-membership checks per table.
create or replace function public.user_company_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select c.id
  from public.companies c
  where public.user_can_access_company_v2(c.id);
$$;

grant execute on function public.user_company_ids() to authenticated;

-- Make the base table policy match the resolver so server components, normal
-- queries and RLS agree for direct members, agency staff and platform admins.
drop policy if exists companies_select on public.companies;
create policy companies_select on public.companies
  for select using (public.user_can_access_company_v2(id));

-- -----------------------------------------------------------------------------
-- 4. Secure post-verification provisioning. Executed only with service role
-- after callback has an authenticated user and the one-time draft token.
-- -----------------------------------------------------------------------------

alter table public.onboarding_sessions
  drop constraint if exists onboarding_sessions_path_check;
alter table public.onboarding_sessions
  add constraint onboarding_sessions_path_check
  check (path in ('bookkeeping_direct', 'bank_automation', 'year_end_one_time', 'bankgiro_autogiro', 'agency_setup'));

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
set search_path = public
as $$
declare
  v_draft public.signup_drafts%rowtype;
  v_user_email text;
  v_company_id uuid;
  v_agency_id uuid;
  v_team_id uuid;
  v_session_id uuid;
  v_path text;
  v_terms_id uuid;
  v_privacy_id uuid;
begin
  select * into v_draft
  from public.signup_drafts
  where id = p_draft_id
  for update;

  if not found then
    raise exception 'signup draft not found' using errcode = 'P0002';
  end if;

  if v_draft.token_hash <> p_token_hash then
    raise exception 'invalid signup draft token' using errcode = '42501';
  end if;

  select lower(email) into v_user_email from auth.users where id = p_user_id;
  if v_user_email is null or v_user_email <> v_draft.login_email then
    raise exception 'signup draft email mismatch' using errcode = '42501';
  end if;

  if v_draft.status = 'provisioned' then
    if v_draft.claimed_by_user_id <> p_user_id then
      raise exception 'signup draft already claimed' using errcode = '42501';
    end if;
    return query select
      v_draft.provisioned_company_id,
      v_draft.provisioned_agency_id,
      v_draft.workspace_type,
      case when v_draft.workspace_type = 'agency' then '/onboarding/agency' else '/onboarding/workspace' end;
    return;
  end if;

  if v_draft.status <> 'pending_verification' or v_draft.expires_at <= now() then
    update public.signup_drafts
    set status = case when expires_at <= now() then 'expired' else status end,
        provision_error = case when expires_at <= now() then 'registration draft expired' else provision_error end
    where id = v_draft.id;
    raise exception 'signup draft cannot be provisioned' using errcode = 'P0001';
  end if;

  update public.signup_drafts
  set status = 'provisioning', claimed_by_user_id = p_user_id, provision_error = null
  where id = v_draft.id;

  -- A personal team remains a compatibility layer for existing team-aware
  -- functionality. An agency gets a named team; a normal company gets a
  -- personal team only when the user has none.
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

  insert into public.cash_accounts (company_id, ledger_account, currency, name, enabled, is_primary, source)
  values (v_company_id, '1930', 'SEK', 'Företagskonto (SEK)', true, true, 'manual')
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
    on conflict (agency_id, user_id) do update set role = 'agency_owner', updated_at = now();

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

  insert into public.onboarding_sessions (company_id, user_id, path, status, current_step, progress_percent, metadata)
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

  select id into v_terms_id
  from public.legal_text_versions
  where document_type = 'terms' and is_active
  order by effective_at desc limit 1;

  if v_terms_id is not null then
    insert into public.legal_acceptances (user_id, company_id, legal_text_version_id, document_type, source, accepted_at, ip_address, user_agent, metadata)
    values (p_user_id, v_company_id, v_terms_id, 'terms', 'register', v_draft.accepted_terms_at, null, v_draft.user_agent, jsonb_build_object('signup_draft_id', v_draft.id, 'ip_address', v_draft.ip_address))
    on conflict do nothing;
  end if;

  select id into v_privacy_id
  from public.legal_text_versions
  where document_type = 'privacy_policy' and is_active
  order by effective_at desc limit 1;

  if v_privacy_id is not null then
    insert into public.legal_acceptances (user_id, company_id, legal_text_version_id, document_type, source, accepted_at, ip_address, user_agent, metadata)
    values (p_user_id, v_company_id, v_privacy_id, 'privacy_policy', 'register', v_draft.accepted_privacy_at, null, v_draft.user_agent, jsonb_build_object('signup_draft_id', v_draft.id, 'ip_address', v_draft.ip_address))
    on conflict do nothing;
  end if;

  insert into public.auth_audit_events (user_id, company_id, email, event_type, status, ip_address, user_agent, metadata)
  values (p_user_id, v_company_id, v_draft.login_email, 'signup_workspace_provisioned', 'success', null, v_draft.user_agent,
    jsonb_build_object('workspace_type', v_draft.workspace_type, 'agency_id', v_agency_id, 'signup_draft_id', v_draft.id, 'ip_address', v_draft.ip_address));

  insert into public.user_preferences (user_id, active_company_id, active_workspace_type, active_agency_id)
  values (p_user_id, v_company_id, case when v_draft.workspace_type = 'agency' then 'agency' else 'company' end, v_agency_id)
  on conflict (user_id) do update set
    active_company_id = excluded.active_company_id,
    active_workspace_type = excluded.active_workspace_type,
    active_agency_id = excluded.active_agency_id,
    updated_at = now();

  update public.signup_drafts
  set status = 'provisioned',
      provisioned_company_id = v_company_id,
      provisioned_agency_id = v_agency_id,
      provision_error = null
  where id = v_draft.id;

  return query select
    v_company_id,
    v_agency_id,
    v_draft.workspace_type,
    case when v_draft.workspace_type = 'agency' then '/onboarding/agency' else '/onboarding/workspace' end;
exception when others then
  update public.signup_drafts
  set status = 'failed', provision_error = left(sqlerrm, 500)
  where id = p_draft_id and status = 'provisioning';
  raise;
end;
$$;

revoke all on function public.provision_signup_draft(uuid, uuid, text) from public;
grant execute on function public.provision_signup_draft(uuid, uuid, text) to service_role;
-- The Next.js callback uses the service role. This function intentionally has
-- no authenticated grant because a user must not choose a different user id.

-- Global roles remain explicitly server/bootstrap assigned. Public signup has
-- no policy or function path that inserts platform_roles.

notify pgrst, 'reload schema';
