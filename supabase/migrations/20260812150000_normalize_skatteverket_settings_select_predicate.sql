-- Normalise the last policy whose text differs between the chain and production.
--
-- skatteverket_company_settings_select is semantically identical on both sides;
-- the operands of the OR are simply written in the other order:
--
--   chain       (is_platform_admin() OR user_can_access_company_v2(company_id))
--   production  (user_can_access_company_v2(company_id) OR is_platform_admin())
--
-- Both functions are STABLE and side-effect free, so the two forms grant exactly
-- the same rows to exactly the same callers. Nothing about access changes here.
--
-- It is worth a migration anyway. The content fingerprint that found the real
-- drift this session compares definitions as text, and a single benign
-- difference means the comparison can never be asserted as an exact match — it
-- has to be read and re-judged by a human every time, which is precisely the
-- kind of standing exception that hides the next real difference. With this
-- normalised, "production equals a clean replay of the chain" becomes a
-- statement that either holds completely or does not.
--
-- pg-test: covered-by tests/pg/tenant-isolation-matrix.pg.test.ts

BEGIN;

DROP POLICY IF EXISTS skatteverket_company_settings_select ON public.skatteverket_company_settings;
CREATE POLICY skatteverket_company_settings_select ON public.skatteverket_company_settings
  FOR SELECT TO public
  USING ((is_platform_admin() OR user_can_access_company_v2(company_id)));

COMMIT;

NOTIFY pgrst, 'reload schema';
