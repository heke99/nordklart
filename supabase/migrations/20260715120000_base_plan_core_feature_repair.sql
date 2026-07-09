-- Base-plan core feature repair.
--
-- The current sellable catalog (company_start/plus/pro, agency_start/plus/pro,
-- seeded in 20260630150000) omitted several features the archived legacy plans
-- (start_monthly/auto_monthly/agency_monthly, 20260628172000) always included
-- and that the product sells as included in every base plan:
--
--   invoicing.core        — customer invoices, articles, recurring invoices
--   onboarding.paths      — onboarding flows
--   bank.automation       — bank connection & sync
--   bank.provider_model   — provider-agnostic bank data
--   bank.transaction_ingest — transaction import/dedupe
--   bank.matching         — rule-based matching
--   bank.autobook         — confidence-gated autobooking
--   year_end.ixbrl        — iXBRL export in year-end (legacy plans had it)
--
-- Without this repair a paying customer on any current plan gets 403 from
-- every `invoice.*` / `bank.*` gated route (featureForOperation →
-- company_feature_access → deny) with no add-on to buy. There is no invoicing
-- or bank add-on in the catalog, so these are base features, not upsells.
--
-- Follows the seed pattern of 20260630150000: patch the ACTIVE version of
-- each base plan with the commercial-mutation bypass (plan versions are
-- otherwise immutable after publish — the immutability guard stays intact
-- for runtime writes).
--
-- pg-test: covered-by tests/pg/commercial-catalog.pg.test.ts

select set_config('nordklart.commercial_mutation', 'on', false);

with active_versions as (
  select distinct on (pp.code) pp.code as plan_code, pv.id as plan_version_id
  from public.platform_price_plans pp
  join public.platform_plan_versions pv on pv.plan_id = pp.id
  where pp.code in ('company_start','company_plus','company_pro','agency_start','agency_plus','agency_pro')
    and pv.status = 'active'
  order by pp.code, pv.version_number desc
), desired(plan_code, feature_code, limit_value, limit_unit) as (
  select plan_code, feature_code, null::numeric, null::text
  from (
    values
      ('company_start'), ('company_plus'), ('company_pro'),
      ('agency_start'), ('agency_plus'), ('agency_pro')
  ) as plans(plan_code)
  cross join (
    values
      ('invoicing.core'),
      ('onboarding.paths'),
      ('bank.automation'),
      ('bank.provider_model'),
      ('bank.transaction_ingest'),
      ('bank.matching'),
      ('bank.autobook'),
      ('year_end.ixbrl')
  ) as features(feature_code)
)
insert into public.platform_plan_version_features (plan_version_id, feature_id, enabled, limit_value, limit_unit)
select av.plan_version_id, pf.id, true, d.limit_value, d.limit_unit
from desired d
join active_versions av on av.plan_code = d.plan_code
join public.platform_features pf on pf.code = d.feature_code
on conflict (plan_version_id, feature_id) do update set
  enabled = true,
  limit_value = excluded.limit_value,
  limit_unit = excluded.limit_unit,
  updated_at = now();

select set_config('nordklart.commercial_mutation', 'off', false);

notify pgrst, 'reload schema';
