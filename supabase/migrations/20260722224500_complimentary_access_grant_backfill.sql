-- Keep Complimentary Full Access and Complimentary Bankgiro aligned with the
-- live feature catalog.
--
-- Root cause repaired here:
--   commercial_access_grant_features is a materialised feature snapshot.
--   Grants created before later platform_features rows were introduced never
--   received those rows, so company_feature_access() returned
--   missing_entitlement even though the grant itself was active.
--
-- This migration:
--   1. backfills every active/scheduled complimentary grant;
--   2. re-enables expected rows that were left disabled;
--   3. automatically propagates future feature-catalog inserts;
--   4. exposes an idempotent superadmin repair RPC for targeted diagnostics.
--
-- Complimentary Full Access deliberately continues to exclude all Bankgiro /
-- Autogiro features. Those require a separate complimentary_bankgiro grant,
-- and bankgiro.operations still requires completed provider provisioning.

create or replace function public.complimentary_grant_includes_feature(
  p_grant_type text,
  p_feature_code text
)
returns boolean
language sql
immutable
parallel safe
set search_path = public
as $$
  select case p_grant_type
    when 'complimentary_full_access' then
      p_feature_code not like 'bankgiro.%'
      and p_feature_code <> 'bankgiro.provider_module'
    when 'complimentary_bankgiro' then
      p_feature_code like 'bankgiro.%'
      or p_feature_code = 'bankgiro.provider_module'
    else false
  end;
$$;

revoke all on function public.complimentary_grant_includes_feature(text, text) from public;
grant execute on function public.complimentary_grant_includes_feature(text, text) to authenticated, service_role;

-- Keep creation of new grants on the same catalog rule as the repair path.
-- This especially matters for complimentary_bankgiro, whose original function
-- used a fixed four-feature allowlist.
create or replace function public.platform_grant_complimentary_full_access(
  p_company_id uuid,
  p_starts_at timestamptz default now(),
  p_expires_at timestamptz default null,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grant_id uuid;
  v_status text := case when coalesce(p_starts_at, now()) <= now() then 'active' else 'scheduled' end;
begin
  perform public.require_platform_commercial_admin();

  if not exists (select 1 from public.companies where id = p_company_id) then
    raise exception 'Bolaget finns inte.' using errcode = 'P0002';
  end if;
  if p_expires_at is not null and p_expires_at <= coalesce(p_starts_at, now()) then
    raise exception 'Slutdatum måste vara senare än startdatum.' using errcode = '22023';
  end if;

  insert into public.commercial_access_grants (
    company_id, grant_type, status, starts_at, expires_at, note, granted_by, metadata
  ) values (
    p_company_id,
    'complimentary_full_access',
    v_status,
    coalesce(p_starts_at, now()),
    p_expires_at,
    nullif(trim(p_note), ''),
    auth.uid(),
    jsonb_build_object('label', 'Complimentary Full Access')
  ) returning id into v_grant_id;

  insert into public.commercial_access_grant_features (grant_id, feature_id, enabled)
  select v_grant_id, feature.id, true
  from public.platform_features feature
  where public.complimentary_grant_includes_feature('complimentary_full_access', feature.code);

  return v_grant_id;
end;
$$;

create or replace function public.platform_grant_complimentary_bankgiro(
  p_company_id uuid,
  p_starts_at timestamptz default now(),
  p_expires_at timestamptz default null,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grant_id uuid;
  v_status text := case when coalesce(p_starts_at, now()) <= now() then 'active' else 'scheduled' end;
begin
  perform public.require_platform_commercial_admin();

  if not exists (select 1 from public.companies where id = p_company_id) then
    raise exception 'Bolaget finns inte.' using errcode = 'P0002';
  end if;
  if p_expires_at is not null and p_expires_at <= coalesce(p_starts_at, now()) then
    raise exception 'Slutdatum måste vara senare än startdatum.' using errcode = '22023';
  end if;

  insert into public.commercial_access_grants (
    company_id, grant_type, status, starts_at, expires_at, note, granted_by, metadata
  ) values (
    p_company_id,
    'complimentary_bankgiro',
    v_status,
    coalesce(p_starts_at, now()),
    p_expires_at,
    nullif(trim(p_note), ''),
    auth.uid(),
    jsonb_build_object('label', 'Complimentary Bankgiro')
  ) returning id into v_grant_id;

  insert into public.commercial_access_grant_features (grant_id, feature_id, enabled)
  select v_grant_id, feature.id, true
  from public.platform_features feature
  where public.complimentary_grant_includes_feature('complimentary_bankgiro', feature.code);

  return v_grant_id;
end;
$$;

revoke all on function public.platform_grant_complimentary_full_access(uuid, timestamptz, timestamptz, text) from public;
revoke all on function public.platform_grant_complimentary_bankgiro(uuid, timestamptz, timestamptz, text) from public;
grant execute on function public.platform_grant_complimentary_full_access(uuid, timestamptz, timestamptz, text) to authenticated;
grant execute on function public.platform_grant_complimentary_bankgiro(uuid, timestamptz, timestamptz, text) to authenticated;

-- Repair all currently effective or future-scheduled complimentary grants.
insert into public.commercial_access_grant_features (
  grant_id,
  feature_id,
  enabled
)
select
  access_grant.id,
  feature.id,
  true
from public.commercial_access_grants access_grant
cross join public.platform_features feature
where access_grant.grant_type in ('complimentary_full_access', 'complimentary_bankgiro')
  and access_grant.status in ('active', 'scheduled')
  and (access_grant.expires_at is null or access_grant.expires_at > now())
  and public.complimentary_grant_includes_feature(access_grant.grant_type, feature.code)
on conflict (grant_id, feature_id) do update set
  enabled = true,
  updated_at = now();

create or replace function public.sync_new_feature_to_complimentary_grants()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.commercial_access_grant_features (
    grant_id,
    feature_id,
    enabled
  )
  select
    access_grant.id,
    new.id,
    true
  from public.commercial_access_grants access_grant
  where access_grant.grant_type in ('complimentary_full_access', 'complimentary_bankgiro')
    and access_grant.status in ('active', 'scheduled')
    and (access_grant.expires_at is null or access_grant.expires_at > now())
    and public.complimentary_grant_includes_feature(access_grant.grant_type, new.code)
  on conflict (grant_id, feature_id) do update set
    enabled = true,
    updated_at = now();

  return new;
end;
$$;

revoke all on function public.sync_new_feature_to_complimentary_grants() from public;

drop trigger if exists platform_features_sync_complimentary_grants on public.platform_features;
create trigger platform_features_sync_complimentary_grants
  after insert on public.platform_features
  for each row execute function public.sync_new_feature_to_complimentary_grants();

create or replace function public.platform_repair_complimentary_access_grants(
  p_company_id uuid default null
)
returns table (
  grants_scanned integer,
  missing_rows_before integer,
  disabled_rows_before integer,
  rows_repaired integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_platform_commercial_admin();

  if p_company_id is not null
     and not exists (select 1 from public.companies where id = p_company_id) then
    raise exception 'Bolaget finns inte.' using errcode = 'P0002';
  end if;

  return query
  with expected as (
    select
      access_grant.id as grant_id,
      feature.id as feature_id
    from public.commercial_access_grants access_grant
    cross join public.platform_features feature
    where access_grant.grant_type in ('complimentary_full_access', 'complimentary_bankgiro')
      and access_grant.status in ('active', 'scheduled')
      and (access_grant.expires_at is null or access_grant.expires_at > now())
      and (p_company_id is null or access_grant.company_id = p_company_id)
      and public.complimentary_grant_includes_feature(access_grant.grant_type, feature.code)
  ), expected_state as (
    select
      expected.grant_id,
      expected.feature_id,
      grant_feature.id as grant_feature_id,
      grant_feature.enabled
    from expected
    left join public.commercial_access_grant_features grant_feature
      on grant_feature.grant_id = expected.grant_id
     and grant_feature.feature_id = expected.feature_id
  ), before_state as (
    select
      count(distinct expected_state.grant_id)::integer as grants_scanned,
      count(*) filter (where expected_state.grant_feature_id is null)::integer as missing_rows_before,
      count(*) filter (where expected_state.grant_feature_id is not null and expected_state.enabled is false)::integer as disabled_rows_before
    from expected_state
  ), repaired as (
    insert into public.commercial_access_grant_features (
      grant_id,
      feature_id,
      enabled
    )
    select
      expected_state.grant_id,
      expected_state.feature_id,
      true
    from expected_state
    where expected_state.grant_feature_id is null
       or expected_state.enabled is false
    on conflict (grant_id, feature_id) do update set
      enabled = true,
      updated_at = now()
    returning 1 as repaired_row
  )
  select
    before_state.grants_scanned,
    before_state.missing_rows_before,
    before_state.disabled_rows_before,
    count(repaired.repaired_row)::integer
  from before_state
  left join repaired on true
  group by
    before_state.grants_scanned,
    before_state.missing_rows_before,
    before_state.disabled_rows_before;
end;
$$;

revoke all on function public.platform_repair_complimentary_access_grants(uuid) from public;
grant execute on function public.platform_repair_complimentary_access_grants(uuid) to authenticated;

-- Operational diagnostic for superadmin/company billing views. The view does
-- not bypass company access: security_invoker + the explicit predicate keep it
-- scoped through the existing company authorization model.
create or replace view public.commercial_access_grant_coverage_v
with (security_invoker = true)
as
with expected as (
  select
    access_grant.id as grant_id,
    access_grant.company_id,
    access_grant.grant_type,
    access_grant.status,
    access_grant.starts_at,
    access_grant.expires_at,
    feature.id as feature_id
  from public.commercial_access_grants access_grant
  cross join public.platform_features feature
  where access_grant.grant_type in ('complimentary_full_access', 'complimentary_bankgiro')
    and public.complimentary_grant_includes_feature(access_grant.grant_type, feature.code)
)
select
  expected.grant_id,
  expected.company_id,
  expected.grant_type,
  expected.status,
  expected.starts_at,
  expected.expires_at,
  count(*)::integer as expected_feature_count,
  count(*) filter (where grant_feature.enabled is true)::integer as enabled_feature_count,
  count(*) filter (where grant_feature.id is null or grant_feature.enabled is false)::integer as missing_feature_count,
  count(*) filter (where grant_feature.enabled is false)::integer as disabled_feature_count
from expected
left join public.commercial_access_grant_features grant_feature
  on grant_feature.grant_id = expected.grant_id
 and grant_feature.feature_id = expected.feature_id
where coalesce(auth.role(), '') = 'service_role'
   or public.user_can_access_company_v2(expected.company_id)
group by
  expected.grant_id,
  expected.company_id,
  expected.grant_type,
  expected.status,
  expected.starts_at,
  expected.expires_at;

grant select on public.commercial_access_grant_coverage_v to authenticated, service_role;

notify pgrst, 'reload schema';
