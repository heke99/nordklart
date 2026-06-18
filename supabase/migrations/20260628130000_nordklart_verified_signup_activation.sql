-- Verified signup activation: email confirmation -> password -> first login -> workspace.
-- No company, team, membership or onboarding session is created from the email
-- confirmation device. Provisioning stays in the existing atomic function and
-- is invoked only after a successful password login.

alter table public.signup_drafts
  add column if not exists email_verified_at timestamptz,
  add column if not exists password_set_at timestamptz,
  add column if not exists company_registry_source text not null default 'manual',
  add column if not exists company_registry_status text not null default 'not_requested',
  add column if not exists company_registry_checked_at timestamptz,
  add column if not exists company_registry_payload jsonb not null default '{}'::jsonb;

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
      'expired',
      'cancelled',
      'failed'
    )
  );

alter table public.signup_drafts
  drop constraint if exists signup_drafts_registry_source_check;
alter table public.signup_drafts
  add constraint signup_drafts_registry_source_check
  check (company_registry_source in ('manual', 'bolagsverket', 'skatteverket'));

alter table public.signup_drafts
  drop constraint if exists signup_drafts_registry_status_check;
alter table public.signup_drafts
  add constraint signup_drafts_registry_status_check
  check (company_registry_status in ('not_requested', 'verified', 'not_found', 'ceased', 'manual_review'));

alter table public.signup_drafts
  drop constraint if exists signup_drafts_org_number_format_check;
alter table public.signup_drafts
  add constraint signup_drafts_org_number_format_check
  check (org_number is null or org_number ~ '^[0-9]{10}$');

create index if not exists idx_signup_drafts_activation
  on public.signup_drafts(claimed_by_user_id, expires_at)
  where status in ('email_verified_pending_password', 'ready_for_first_login', 'provisioning');

create table if not exists public.company_registry_snapshots (
  id uuid primary key default gen_random_uuid(),
  signup_draft_id uuid references public.signup_drafts(id) on delete set null,
  company_id uuid references public.companies(id) on delete cascade,
  provider text not null check (provider in ('manual', 'bolagsverket', 'skatteverket')),
  lookup_status text not null check (lookup_status in ('not_requested', 'verified', 'not_found', 'ceased', 'manual_review')),
  organization_number text,
  normalized_data jsonb not null default '{}'::jsonb,
  source_payload jsonb not null default '{}'::jsonb,
  retrieved_at timestamptz,
  user_confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (organization_number is null or organization_number ~ '^[0-9]{10}$')
);

create unique index if not exists uq_company_registry_snapshot_company_provider
  on public.company_registry_snapshots(company_id, provider)
  where company_id is not null;
create index if not exists idx_company_registry_snapshots_draft
  on public.company_registry_snapshots(signup_draft_id)
  where signup_draft_id is not null;

alter table public.company_registry_snapshots enable row level security;
grant select, insert, update on public.company_registry_snapshots to service_role;

drop trigger if exists company_registry_snapshots_updated_at on public.company_registry_snapshots;
create trigger company_registry_snapshots_updated_at
  before update on public.company_registry_snapshots
  for each row execute function public.update_updated_at_column();

create or replace function public.verify_signup_draft_email(
  p_draft_id uuid,
  p_user_id uuid,
  p_token_hash text
)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_draft public.signup_drafts%rowtype;
  v_email text;
  v_confirmed_at timestamptz;
begin
  select * into v_draft
  from public.signup_drafts
  where id = p_draft_id
  for update;

  if not found or v_draft.token_hash <> p_token_hash then
    raise exception 'invalid signup draft' using errcode = '42501';
  end if;

  select lower(email), email_confirmed_at
  into v_email, v_confirmed_at
  from auth.users
  where id = p_user_id;

  if v_email is null or v_email <> v_draft.login_email or v_confirmed_at is null then
    raise exception 'signup draft email is not verified' using errcode = '42501';
  end if;

  if v_draft.status = 'email_verified_pending_password'
    and v_draft.claimed_by_user_id = p_user_id then
    return true;
  end if;

  if v_draft.status <> 'pending_verification' or v_draft.expires_at <= now() then
    update public.signup_drafts
    set status = case when expires_at <= now() then 'expired' else status end,
        provision_error = case when expires_at <= now() then 'email confirmation expired' else provision_error end
    where id = p_draft_id;
    raise exception 'signup draft cannot be verified' using errcode = 'P0001';
  end if;

  update public.signup_drafts
  set status = 'email_verified_pending_password',
      claimed_by_user_id = p_user_id,
      email_verified_at = now(),
      -- A verified user gets a controlled activation window that is longer
      -- than the email link lifetime, so onboarding can continue on another device.
      expires_at = greatest(expires_at, now() + interval '30 days'),
      provision_error = null
  where id = p_draft_id;

  insert into public.auth_audit_events (user_id, email, event_type, status, user_agent, metadata)
  values (
    p_user_id,
    v_draft.login_email,
    'signup_email_verified',
    'success',
    v_draft.user_agent,
    jsonb_build_object('signup_draft_id', v_draft.id, 'ip_address', v_draft.ip_address)
  );

  return true;
end;
$$;

create or replace function public.mark_signup_draft_password_set(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_draft public.signup_drafts%rowtype;
begin
  select * into v_draft
  from public.signup_drafts
  where claimed_by_user_id = p_user_id
    and status = 'email_verified_pending_password'
  order by updated_at desc
  limit 1
  for update;

  -- No signup draft is normal for BankID and existing accounts.
  if not found then
    return false;
  end if;

  if v_draft.expires_at <= now() then
    update public.signup_drafts
    set status = 'expired', provision_error = 'activation window expired'
    where id = v_draft.id;
    raise exception 'signup activation expired' using errcode = 'P0001';
  end if;

  update public.signup_drafts
  set status = 'ready_for_first_login',
      password_set_at = now(),
      provision_error = null
  where id = v_draft.id;

  return true;
end;
$$;

create or replace function public.provision_verified_signup_draft(p_user_id uuid)
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
  v_current public.signup_drafts%rowtype;
begin
  select * into v_draft
  from public.signup_drafts
  where claimed_by_user_id = p_user_id
    and status in ('ready_for_first_login', 'provisioned')
  order by updated_at desc
  limit 1
  for update;

  if not found then
    return;
  end if;

  if v_draft.expires_at <= now() and v_draft.status <> 'provisioned' then
    update public.signup_drafts
    set status = 'expired', provision_error = 'activation window expired'
    where id = v_draft.id;
    raise exception 'signup activation expired' using errcode = 'P0001';
  end if;

  -- The existing provisioning routine remains the single source of truth for
  -- company/team/onboarding writes. It accepts a hashed token, so passing the
  -- stored hash here never reconstructs or exposes the original secret.
  if v_draft.status = 'ready_for_first_login' then
    update public.signup_drafts
    set status = 'pending_verification'
    where id = v_draft.id;
  end if;

  return query
  select * from public.provision_signup_draft(v_draft.id, p_user_id, v_draft.token_hash);

  select * into v_current
  from public.signup_drafts
  where id = v_draft.id;

  if v_current.provisioned_company_id is not null then
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
      v_current.id,
      v_current.provisioned_company_id,
      v_current.company_registry_source,
      v_current.company_registry_status,
      v_current.org_number,
      jsonb_strip_nulls(jsonb_build_object(
        'company_name', v_current.company_name,
        'legal_form', v_current.legal_form,
        'address_line1', v_current.address_line1,
        'postal_code', v_current.postal_code,
        'city', v_current.city,
        'contact_email', v_current.contact_email,
        'phone', v_current.phone
      )),
      v_current.company_registry_payload,
      v_current.company_registry_checked_at,
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
  end if;
end;
$$;

revoke all on function public.verify_signup_draft_email(uuid, uuid, text) from public;
revoke all on function public.mark_signup_draft_password_set(uuid) from public;
revoke all on function public.provision_verified_signup_draft(uuid) from public;
grant execute on function public.verify_signup_draft_email(uuid, uuid, text) to service_role;
grant execute on function public.mark_signup_draft_password_set(uuid) to service_role;
grant execute on function public.provision_verified_signup_draft(uuid) to service_role;

notify pgrst, 'reload schema';
