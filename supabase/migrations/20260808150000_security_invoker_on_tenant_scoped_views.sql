-- Stop four tenant-scoped views from bypassing RLS.
--
-- A PostgreSQL view runs with the privileges of its OWNER unless it is created
-- with `security_invoker = true`. These four are owned by a superuser, carry no
-- tenant predicate of their own, and are granted SELECT to `authenticated` — so
-- the row-level security on the tables underneath them was never evaluated for
-- the querying user.
--
-- Measured on a replayed database before this migration, as an ordinary
-- authenticated member of one company:
--
--   customer_ar_balances                    388 rows, ALL belonging to other companies
--   company_commercial_usage_v            4 433 foreign rows
--   company_effective_commercial_limits_v 22 165 foreign rows
--   agency_commercial_usage_v               104 rows across every agency
--
-- customer_ar_balances exposes customer ids and outstanding receivable amounts
-- per company. That is every tenant's order book readable by every other
-- tenant — a confidentiality breach, and for an accounting product handling
-- other companies' books, a serious one.
--
-- The fix is `security_invoker = true`, which makes the underlying tables' RLS
-- apply to whoever is querying. The tables already carry correct company-scoped
-- policies, so no policy work is needed and legitimate access is unchanged:
-- after this migration a member sees exactly their own company's rows.
--
-- Deliberately NOT changed:
--
--   skatteverket_connections_v   already filters `company_id IN (SELECT
--                                user_company_ids())` in the view body, so it is
--                                safe as-is. Left alone rather than changed for
--                                tidiness — an unnecessary edit to a working
--                                security boundary is its own risk.
--   public_price_plans_v         public price catalogue, deliberately readable
--   public_price_start_v         by `anon`. No tenant data. Definer rights are
--                                the point: there is no session to scope to.
--   *_discrepancies_v1           service_role only (verified via
--   cancelled_committed_journal_entry_inventory
--                                has_table_privilege) — no tenant can reach
--                                them, so definer semantics leak nothing.
--
-- pg-test: covered-by tests/pg/view-tenant-isolation.pg.test.ts

BEGIN;

ALTER VIEW public.customer_ar_balances SET (security_invoker = true);
ALTER VIEW public.company_commercial_usage_v SET (security_invoker = true);
ALTER VIEW public.agency_commercial_usage_v SET (security_invoker = true);
ALTER VIEW public.company_effective_commercial_limits_v SET (security_invoker = true);

COMMIT;

NOTIFY pgrst, 'reload schema';
