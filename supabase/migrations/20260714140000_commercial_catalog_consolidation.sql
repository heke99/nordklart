-- Commercial catalog consolidation.
--
-- 1. Archive the legacy onboarding-era base plans and the legacy Bankgiro
--    add-on. They duplicate the public catalog:
--      start_monthly / auto_monthly / agency_monthly →
--        company_start / company_plus / company_pro / agency_*
--      bankgiro_addon_monthly (299 kr) → addon_bankgiro_operations (99 kr)
--    Archiving only affects the purchasable catalog (checkout rejects
--    non-active plans; the billing UI hides them from purchase). Existing
--    subscriptions keep their plan_version references and entitlements —
--    platform_plan_versions rows are untouched.
--    year_end_one_time stays active: it is the only one-time year-end SKU.
--
-- 2. public_price_plans_v: interval-aware price label. The previous view
--    hardcoded 'kr/mån' for every billing interval, mislabeling yearly and
--    one-time products.
--
-- pg-test: covered-by tests/pg/commercial-catalog.pg.test.ts

update public.platform_price_plans
set status = 'archived',
    is_public = false,
    is_default = false,
    updated_at = now()
where code in ('start_monthly', 'auto_monthly', 'agency_monthly', 'bankgiro_addon_monthly');

create or replace view public.public_price_plans_v
as
with current_versions as (
  select distinct on (pv.plan_id)
    pv.*
  from public.platform_plan_versions pv
  where pv.status = 'active'
    and pv.effective_from <= now()
    and (pv.effective_until is null or pv.effective_until > now())
  order by pv.plan_id, pv.version_number desc, pv.effective_from desc
), version_features as (
  select
    pvf.plan_version_id,
    jsonb_agg(
      jsonb_build_object(
        'code', pf.code,
        'name', pf.name,
        'category', pf.category,
        'limitValue', pvf.limit_value,
        'limitUnit', pvf.limit_unit
      ) order by pf.category, pf.code
    ) filter (where coalesce(pvf.enabled, true)) as features_json,
    jsonb_object_agg(pf.code, jsonb_build_object('value', pvf.limit_value, 'unit', pvf.limit_unit)) filter (
      where pf.code in ('company.users','external.advisors','payroll.employees','agency.clients','agency.staff')
    ) as limits_json
  from public.platform_plan_version_features pvf
  join public.platform_features pf on pf.id = pvf.feature_id
  group by pvf.plan_version_id
)
select
  pp.id as plan_id,
  cv.id as plan_version_id,
  pp.code as plan_code,
  coalesce(pp.public_name, pp.name) as public_name,
  coalesce(pp.public_summary, pp.description) as public_summary,
  pp.public_badge,
  pp.audience_type,
  pp.company_form_scope,
  pp.cta_label,
  pp.cta_href,
  pp.marketing_metadata,
  cv.currency,
  cv.price_excl_vat as monthly_price_ex_vat,
  cv.billing_interval,
  (
    'Från ' || trim(to_char(cv.price_excl_vat, 'FM999999990')) ||
    case cv.billing_interval
      when 'month' then ' kr/mån'
      when 'year' then ' kr/år'
      else ' kr'
    end
  ) as price_from_label,
  coalesce(vf.features_json, '[]'::jsonb) as features_json,
  coalesce(vf.limits_json, '{}'::jsonb) as limits_json,
  pp.public_sort_order,
  pp.sort_order
from public.platform_price_plans pp
join current_versions cv on cv.plan_id = pp.id
left join version_features vf on vf.plan_version_id = cv.id
where pp.status = 'active'
  and pp.is_public = true
  and pp.audience_type in ('company', 'agency')
order by pp.audience_type, pp.public_sort_order, pp.sort_order;

grant select on public.public_price_plans_v to anon, authenticated, service_role;

notify pgrst, 'reload schema';
