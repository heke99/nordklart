-- Make complimentary access authoritative at resolution time.
--
-- A complimentary_full_access grant is a commercial override, not a plan and
-- not merely a snapshot of grant-feature rows. The previous resolver still
-- required a matching commercial_access_grant_features row for every feature.
-- That allowed stale/missing snapshot rows (or a stale dashboard RSC payload)
-- to make a valid Full Access company look unlicensed.
--
-- The snapshot table is retained for diagnostics and non-complimentary custom
-- grants, but the two canonical complimentary grant types are now resolved
-- directly from the active grant row + the feature catalogue rule.

create or replace function public.company_feature_access(
  p_company_id uuid,
  p_feature_code text
)
returns table (
  allowed boolean,
  reason text,
  source_type text,
  source_id uuid,
  expires_at timestamptz,
  limit_value numeric,
  limit_unit text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_source record;
  v_has_expired_source boolean := false;
  v_is_service_role boolean := coalesce(auth.role(), '') = 'service_role';
begin
  if not v_is_service_role and not public.user_can_access_company_v2(p_company_id) then
    return query select false, 'unauthorized', null::text, null::uuid, null::timestamptz, null::numeric, null::text;
    return;
  end if;

  select
    exists (
      select 1
      from public.company_entitlements ce
      where ce.company_id = p_company_id
        and ce.feature_code = p_feature_code
        and ce.source not in ('plan', 'one_time_purchase')
        and ce.enabled = true
        and ce.starts_at <= now()
        and ce.expires_at is not null
        and ce.expires_at <= now()
    )
    or exists (
      select 1
      from public.commercial_access_grants cag
      where cag.company_id = p_company_id
        and cag.status in ('scheduled', 'active')
        and cag.starts_at <= now()
        and cag.expires_at is not null
        and cag.expires_at <= now()
        and (
          (
            cag.grant_type in ('complimentary_full_access', 'complimentary_bankgiro')
            and exists (select 1 from public.platform_features pf where pf.code = p_feature_code)
            and public.complimentary_grant_includes_feature(cag.grant_type, p_feature_code)
          )
          or exists (
            select 1
            from public.commercial_access_grant_features cagf
            join public.platform_features pf on pf.id = cagf.feature_id
            where cagf.grant_id = cag.id
              and cagf.enabled = true
              and pf.code = p_feature_code
          )
        )
    )
  into v_has_expired_source;

  select * into v_source
  from (
    select
      10 as priority,
      'manual_entitlement'::text as source_type,
      ce.id as source_id,
      ce.expires_at,
      ce.limit_value,
      ce.limit_unit
    from public.company_entitlements ce
    where ce.company_id = p_company_id
      and ce.feature_code = p_feature_code
      and ce.source not in ('plan', 'one_time_purchase')
      and ce.enabled = true
      and ce.starts_at <= now()
      and (ce.expires_at is null or ce.expires_at > now())

    union all

    -- Canonical complimentary grants are authoritative. They do not depend on
    -- materialised commercial_access_grant_features rows being complete.
    select
      15,
      'commercial_grant'::text,
      cag.id,
      cag.expires_at,
      null::numeric,
      null::text
    from public.commercial_access_grants cag
    where cag.company_id = p_company_id
      and cag.grant_type in ('complimentary_full_access', 'complimentary_bankgiro')
      and cag.status in ('scheduled', 'active')
      and cag.starts_at <= now()
      and (cag.expires_at is null or cag.expires_at > now())
      and exists (select 1 from public.platform_features pf where pf.code = p_feature_code)
      and public.complimentary_grant_includes_feature(cag.grant_type, p_feature_code)

    union all

    -- Other/custom grants continue to use their explicit feature snapshot.
    select
      20,
      'commercial_grant'::text,
      cag.id,
      cag.expires_at,
      cagf.limit_value,
      cagf.limit_unit
    from public.commercial_access_grants cag
    join public.commercial_access_grant_features cagf on cagf.grant_id = cag.id
    join public.platform_features pf on pf.id = cagf.feature_id
    where cag.company_id = p_company_id
      and cag.grant_type not in ('complimentary_full_access', 'complimentary_bankgiro')
      and pf.code = p_feature_code
      and cag.status in ('scheduled', 'active')
      and cagf.enabled = true
      and cag.starts_at <= now()
      and (cag.expires_at is null or cag.expires_at > now())

    union all

    select
      30,
      'subscription_item'::text,
      csi.id,
      case
        when csi.status = 'past_due' then coalesce(csi.grace_ends_at, cs.grace_ends_at)
        else coalesce(csi.current_period_end, cs.current_period_end, cs.trial_ends_at)
      end,
      pvf.limit_value,
      pvf.limit_unit
    from public.company_subscription_items csi
    join public.company_subscriptions cs on cs.id = csi.subscription_id
    join public.platform_plan_version_features pvf
      on pvf.plan_version_id = csi.plan_version_id
     and pvf.enabled = true
    join public.platform_features pf on pf.id = pvf.feature_id
    where csi.company_id = p_company_id
      and cs.company_id = p_company_id
      and pf.code = p_feature_code
      and (
        csi.status in ('trialing', 'active')
        or (csi.status = 'past_due' and csi.grace_ends_at > now())
      )
      and (
        cs.status in ('trialing', 'active')
        or (cs.status = 'past_due' and cs.grace_ends_at > now())
      )
      and csi.starts_at <= now()
      and cs.starts_at <= now()
      and (
        csi.current_period_end is null
        or csi.current_period_end > now()
        or (csi.status = 'past_due' and csi.grace_ends_at > now())
      )
      and (
        cs.current_period_end is null
        or cs.current_period_end > now()
        or (cs.status = 'past_due' and cs.grace_ends_at > now())
      )
      and (cs.trial_ends_at is null or cs.status <> 'trialing' or cs.trial_ends_at > now())
  ) candidates
  order by priority, expires_at nulls last
  limit 1;

  if not found then
    return query select false,
      case when v_has_expired_source then 'expired' else 'missing_entitlement' end,
      null::text, null::uuid, null::timestamptz, null::numeric, null::text;
    return;
  end if;

  -- Full Access never bypasses Bankgiro provider readiness. A separate
  -- complimentary_bankgiro grant (or paid add-on) grants the product, while
  -- operations remain blocked until provisioning is complete.
  if p_feature_code = 'bankgiro.operations'
     and not exists (
       select 1
       from public.bankgiro_applications ba
       join public.payment_provider_accounts ppa
         on ppa.company_id = ba.company_id
        and (ppa.bankgiro_application_id = ba.id or ppa.bankgiro_application_id is null)
       where ba.company_id = p_company_id
         and ba.status = 'active'
         and ba.provider_setup_status = 'active'
         and ba.documents_status = 'ready'
         and ppa.status = 'active'
     ) then
    return query select false, 'provisioning_pending', v_source.source_type, v_source.source_id,
      v_source.expires_at, v_source.limit_value, v_source.limit_unit;
    return;
  end if;

  return query select true, null::text, v_source.source_type, v_source.source_id,
    v_source.expires_at, v_source.limit_value, v_source.limit_unit;
end;
$$;

revoke all on function public.company_feature_access(uuid, text) from public;
grant execute on function public.company_feature_access(uuid, text) to authenticated, service_role;

-- Read the complete effective catalogue through one security-definer RPC.
-- This avoids sidebar state depending on a multi-table security_invoker view
-- and preserves reason/source metadata for diagnostics and redirects.
create or replace function public.company_feature_access_catalog(
  p_company_id uuid
)
returns table (
  feature_code text,
  feature_name text,
  category text,
  risk_level text,
  enabled boolean,
  reason text,
  source_type text,
  source_id uuid,
  expires_at timestamptz,
  limit_value numeric,
  limit_unit text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_is_service_role boolean := coalesce(auth.role(), '') = 'service_role';
begin
  if not v_is_service_role and not public.user_can_access_company_v2(p_company_id) then
    return;
  end if;

  return query
  select
    feature.code,
    feature.name,
    feature.category,
    feature.risk_level::text,
    access.allowed,
    access.reason,
    access.source_type,
    access.source_id,
    access.expires_at,
    access.limit_value,
    access.limit_unit
  from public.platform_features feature
  cross join lateral public.company_feature_access(p_company_id, feature.code) access
  order by feature.category, feature.code;
end;
$$;

revoke all on function public.company_feature_access_catalog(uuid) from public;
grant execute on function public.company_feature_access_catalog(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
