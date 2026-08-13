-- Converge the last two views that disagree with the migration chain.
--
-- Both are older bodies that production kept because the migrations replacing
-- them were never applied, and a view body is invisible to any check that only
-- asks whether the view exists.
--
-- api_webhook_overview_v reads an entirely different table in production. The
-- old body aggregates public.webhook_endpoints and its denormalised
-- failure_count / last_delivery_at columns; the canonical body aggregates
-- public.webhooks joined to public.webhook_deliveries, counting the deliveries
-- that actually failed. Same five output columns, different source of truth —
-- so the overview a company sees for its webhooks has been computed from a
-- table the rest of the system no longer maintains.
--
-- company_feature_access_v reassembles entitlements by hand in production:
-- LEFT JOINs across company_entitlements, company_subscriptions and
-- platform_plan_features, with the answer to "is this feature on" coming from
-- company_has_feature() and the limits from max() over those joins. The
-- canonical body asks company_feature_access() once, per company and feature,
-- and takes allowed and both limit columns from it. That is the same
-- single-source-of-truth move made everywhere else in this remediation: one
-- implementation of an access decision, not two that can disagree.
--
-- CREATE OR REPLACE rather than DROP + CREATE, so the existing grants on both
-- views survive untouched. Both keep security_invoker = true, which is what
-- makes them respect the caller's RLS rather than the owner's.
--
-- On a database that already matches the chain this migration is a no-op.
--
-- pg-test: covered-by tests/pg/tenant-isolation-matrix.pg.test.ts

BEGIN;

CREATE OR REPLACE VIEW public.api_webhook_overview_v
WITH (security_invoker = true) AS
 SELECT w.company_id,
    count(*) AS endpoint_count,
    count(*) FILTER (WHERE ((w.active = true) AND (w.disabled_at IS NULL))) AS active_endpoint_count,
    count(wd.id) FILTER (WHERE (wd.status = ANY (ARRAY['failed'::text, 'dead'::text]))) AS failure_count,
    max(wd.delivered_at) AS last_delivery_at
   FROM (webhooks w
     LEFT JOIN webhook_deliveries wd ON ((wd.webhook_id = w.id)))
  GROUP BY w.company_id;

CREATE OR REPLACE VIEW public.company_feature_access_v
WITH (security_invoker = true) AS
 SELECT c.id AS company_id,
    f.code AS feature_code,
    f.name AS feature_name,
    f.category,
    f.risk_level,
    cfa.allowed AS enabled,
    cfa.limit_value,
    cfa.limit_unit
   FROM ((companies c
     CROSS JOIN platform_features f)
     CROSS JOIN LATERAL company_feature_access(c.id, f.code) cfa(allowed, reason, source_type, source_id, expires_at, limit_value, limit_unit))
  WHERE user_can_access_company_v2(c.id);

COMMIT;

NOTIFY pgrst, 'reload schema';
