-- =============================================================================
-- SRU codes on the chart of accounts come from the declaration mapping
--
-- chart_of_accounts.sru_code was seeded by 20240101000021 (and the TS
-- computeSRUCode that mirrored it) with codes that exist on neither INK2R nor
-- NE: 7203 for every financial asset, 7210–7212 for current assets, 7310–7325
-- for the NE rows, 7220/7221 for equity. SIE export wrote them out as #SRU
-- records, and the chart showed them to users.
--
-- This replaces the ranges with the BAS kopplingstabeller that the INK2R and
-- NE engines use (INK2_P1_intervall 2024-11-19, NE_EJ_K1-Intervall-231002).
-- The rows below are GENERATED from lib/reports/sru/account-sru.ts; the
-- pg-real test compares every account 1000–8999 against it, so the two cannot
-- drift.
--
--   * bas_sru_ranges: reference data (entity, from, to, code).
--   * bas_sru_code(account, entity): the code an account reports to.
--   * chart_of_accounts trigger: on INSERT the code is derived for every BAS
--     account (a supplied value is kept only for accounts the table does not
--     cover, and only if it is a real field on the company's form); on UPDATE
--     a user may pick another real field, never an invented one.
--   * backfill of every existing chart row.
--
-- pg-test: covered-by tests/pg/bas-sru-codes.pg.test.ts
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.bas_sru_ranges (
  entity_type  text NOT NULL CHECK (entity_type IN ('aktiebolag', 'enskild_firma')),
  account_from text NOT NULL CHECK (account_from ~ '^\d{4}$'),
  account_to   text NOT NULL CHECK (account_to ~ '^\d{4}$'),
  sru_code     text NOT NULL CHECK (sru_code ~ '^\d{4}$'),
  PRIMARY KEY (entity_type, account_from),
  CHECK (account_to >= account_from)
);

ALTER TABLE public.bas_sru_ranges ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bas_sru_ranges_select ON public.bas_sru_ranges;
CREATE POLICY bas_sru_ranges_select ON public.bas_sru_ranges
  FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.bas_sru_ranges FROM anon;

DELETE FROM public.bas_sru_ranges;
INSERT INTO public.bas_sru_ranges (entity_type, account_from, account_to, sru_code) VALUES
  -- aktiebolag
  ('aktiebolag', '1000', '1087', '7201'),
  ('aktiebolag', '1088', '1088', '7202'),
  ('aktiebolag', '1089', '1099', '7201'),
  ('aktiebolag', '1100', '1119', '7214'),
  ('aktiebolag', '1120', '1129', '7216'),
  ('aktiebolag', '1130', '1179', '7214'),
  ('aktiebolag', '1180', '1189', '7217'),
  ('aktiebolag', '1190', '1199', '7214'),
  ('aktiebolag', '1200', '1279', '7215'),
  ('aktiebolag', '1280', '1289', '7217'),
  ('aktiebolag', '1290', '1299', '7215'),
  ('aktiebolag', '1310', '1319', '7230'),
  ('aktiebolag', '1320', '1329', '7232'),
  ('aktiebolag', '1330', '1335', '7231'),
  ('aktiebolag', '1336', '1337', '7233'),
  ('aktiebolag', '1338', '1339', '7231'),
  ('aktiebolag', '1340', '1345', '7232'),
  ('aktiebolag', '1346', '1347', '7235'),
  ('aktiebolag', '1348', '1349', '7232'),
  ('aktiebolag', '1350', '1359', '7233'),
  ('aktiebolag', '1360', '1369', '7234'),
  ('aktiebolag', '1370', '1389', '7235'),
  ('aktiebolag', '1410', '1429', '7241'),
  ('aktiebolag', '1440', '1449', '7242'),
  ('aktiebolag', '1450', '1469', '7243'),
  ('aktiebolag', '1470', '1479', '7245'),
  ('aktiebolag', '1480', '1489', '7246'),
  ('aktiebolag', '1490', '1499', '7244'),
  ('aktiebolag', '1510', '1559', '7251'),
  ('aktiebolag', '1560', '1572', '7252'),
  ('aktiebolag', '1573', '1573', '7261'),
  ('aktiebolag', '1574', '1579', '7252'),
  ('aktiebolag', '1580', '1589', '7251'),
  ('aktiebolag', '1610', '1619', '7261'),
  ('aktiebolag', '1620', '1629', '7262'),
  ('aktiebolag', '1630', '1659', '7261'),
  ('aktiebolag', '1660', '1669', '7252'),
  ('aktiebolag', '1671', '1672', '7252'),
  ('aktiebolag', '1673', '1673', '7261'),
  ('aktiebolag', '1674', '1679', '7252'),
  ('aktiebolag', '1680', '1699', '7261'),
  ('aktiebolag', '1700', '1799', '7263'),
  ('aktiebolag', '1800', '1859', '7271'),
  ('aktiebolag', '1860', '1869', '7270'),
  ('aktiebolag', '1870', '1899', '7271'),
  ('aktiebolag', '1900', '1999', '7281'),
  ('aktiebolag', '2080', '2089', '7301'),
  ('aktiebolag', '2090', '2099', '7302'),
  ('aktiebolag', '2110', '2139', '7321'),
  ('aktiebolag', '2150', '2159', '7322'),
  ('aktiebolag', '2160', '2199', '7323'),
  ('aktiebolag', '2210', '2219', '7331'),
  ('aktiebolag', '2220', '2229', '7333'),
  ('aktiebolag', '2230', '2239', '7332'),
  ('aktiebolag', '2240', '2299', '7333'),
  ('aktiebolag', '2310', '2329', '7350'),
  ('aktiebolag', '2330', '2339', '7351'),
  ('aktiebolag', '2340', '2359', '7352'),
  ('aktiebolag', '2360', '2372', '7353'),
  ('aktiebolag', '2373', '2373', '7354'),
  ('aktiebolag', '2374', '2379', '7353'),
  ('aktiebolag', '2380', '2399', '7354'),
  ('aktiebolag', '2410', '2419', '7361'),
  ('aktiebolag', '2420', '2429', '7362'),
  ('aktiebolag', '2430', '2439', '7363'),
  ('aktiebolag', '2440', '2449', '7365'),
  ('aktiebolag', '2450', '2459', '7364'),
  ('aktiebolag', '2460', '2472', '7367'),
  ('aktiebolag', '2473', '2473', '7369'),
  ('aktiebolag', '2474', '2479', '7367'),
  ('aktiebolag', '2480', '2489', '7360'),
  ('aktiebolag', '2490', '2491', '7369'),
  ('aktiebolag', '2492', '2492', '7366'),
  ('aktiebolag', '2493', '2499', '7369'),
  ('aktiebolag', '2500', '2599', '7368'),
  ('aktiebolag', '2600', '2873', '7369'),
  ('aktiebolag', '2874', '2879', '7367'),
  ('aktiebolag', '2880', '2899', '7369'),
  ('aktiebolag', '2900', '2999', '7370'),
  ('aktiebolag', '3000', '3799', '7410'),
  ('aktiebolag', '3800', '3899', '7412'),
  ('aktiebolag', '3900', '3999', '7413'),
  ('aktiebolag', '4000', '4199', '7511'),
  ('aktiebolag', '4200', '4299', '7512'),
  ('aktiebolag', '4300', '4799', '7511'),
  ('aktiebolag', '4900', '4909', '7411'),
  ('aktiebolag', '4910', '4929', '7511'),
  ('aktiebolag', '4930', '4959', '7411'),
  ('aktiebolag', '4960', '4969', '7512'),
  ('aktiebolag', '4970', '4979', '7411'),
  ('aktiebolag', '4980', '4989', '7512'),
  ('aktiebolag', '4990', '4999', '7411'),
  ('aktiebolag', '5000', '6999', '7513'),
  ('aktiebolag', '7000', '7699', '7514'),
  ('aktiebolag', '7700', '7739', '7515'),
  ('aktiebolag', '7740', '7749', '7516'),
  ('aktiebolag', '7750', '7789', '7515'),
  ('aktiebolag', '7790', '7799', '7516'),
  ('aktiebolag', '7800', '7899', '7515'),
  ('aktiebolag', '7900', '7999', '7517'),
  ('aktiebolag', '8000', '8069', '7414'),
  ('aktiebolag', '8070', '8089', '7521'),
  ('aktiebolag', '8090', '8099', '7414'),
  ('aktiebolag', '8100', '8112', '7415'),
  ('aktiebolag', '8113', '8113', '7423'),
  ('aktiebolag', '8114', '8117', '7415'),
  ('aktiebolag', '8118', '8118', '7423'),
  ('aktiebolag', '8119', '8122', '7415'),
  ('aktiebolag', '8123', '8123', '7423'),
  ('aktiebolag', '8124', '8132', '7415'),
  ('aktiebolag', '8133', '8133', '7423'),
  ('aktiebolag', '8134', '8169', '7415'),
  ('aktiebolag', '8170', '8189', '7521'),
  ('aktiebolag', '8190', '8199', '7415'),
  ('aktiebolag', '8200', '8269', '7416'),
  ('aktiebolag', '8270', '8289', '7521'),
  ('aktiebolag', '8290', '8299', '7416'),
  ('aktiebolag', '8300', '8369', '7417'),
  ('aktiebolag', '8370', '8389', '7521'),
  ('aktiebolag', '8390', '8399', '7417'),
  ('aktiebolag', '8400', '8499', '7522'),
  ('aktiebolag', '8810', '8810', '7420'),
  ('aktiebolag', '8811', '8811', '7525'),
  ('aktiebolag', '8812', '8819', '7420'),
  ('aktiebolag', '8820', '8829', '7419'),
  ('aktiebolag', '8830', '8839', '7524'),
  ('aktiebolag', '8840', '8849', '7527'),
  ('aktiebolag', '8850', '8859', '7421'),
  ('aktiebolag', '8860', '8899', '7422'),
  ('aktiebolag', '8900', '8989', '7528'),
  -- enskild_firma
  ('enskild_firma', '1000', '1099', '7200'),
  ('enskild_firma', '1100', '1129', '7210'),
  ('enskild_firma', '1130', '1149', '7211'),
  ('enskild_firma', '1150', '1179', '7210'),
  ('enskild_firma', '1180', '1189', '7211'),
  ('enskild_firma', '1190', '1199', '7210'),
  ('enskild_firma', '1200', '1290', '7212'),
  ('enskild_firma', '1291', '1291', '7211'),
  ('enskild_firma', '1292', '1299', '7212'),
  ('enskild_firma', '1300', '1399', '7213'),
  ('enskild_firma', '1400', '1499', '7240'),
  ('enskild_firma', '1500', '1599', '7250'),
  ('enskild_firma', '1600', '1899', '7260'),
  ('enskild_firma', '1900', '1999', '7280'),
  ('enskild_firma', '2000', '2099', '7300'),
  ('enskild_firma', '2100', '2199', '7320'),
  ('enskild_firma', '2200', '2299', '7330'),
  ('enskild_firma', '2300', '2399', '7380'),
  ('enskild_firma', '2410', '2419', '7380'),
  ('enskild_firma', '2420', '2439', '7383'),
  ('enskild_firma', '2440', '2449', '7382'),
  ('enskild_firma', '2450', '2459', '7383'),
  ('enskild_firma', '2460', '2479', '7382'),
  ('enskild_firma', '2480', '2489', '7380'),
  ('enskild_firma', '2490', '2999', '7383'),
  ('enskild_firma', '3000', '3003', '7400'),
  ('enskild_firma', '3004', '3004', '7401'),
  ('enskild_firma', '3005', '3799', '7400'),
  ('enskild_firma', '3800', '3899', '7403'),
  ('enskild_firma', '3900', '3910', '7400'),
  ('enskild_firma', '3911', '3912', '7401'),
  ('enskild_firma', '3913', '3999', '7400'),
  ('enskild_firma', '4000', '4999', '7500'),
  ('enskild_firma', '5000', '6999', '7501'),
  ('enskild_firma', '7000', '7699', '7502'),
  ('enskild_firma', '7700', '7719', '7505'),
  ('enskild_firma', '7720', '7729', '7504'),
  ('enskild_firma', '7730', '7739', '7505'),
  ('enskild_firma', '7740', '7749', '7503'),
  ('enskild_firma', '7750', '7769', '7505'),
  ('enskild_firma', '7770', '7779', '7504'),
  ('enskild_firma', '7780', '7789', '7505'),
  ('enskild_firma', '7790', '7799', '7503'),
  ('enskild_firma', '7800', '7819', '7505'),
  ('enskild_firma', '7820', '7829', '7504'),
  ('enskild_firma', '7830', '7839', '7505'),
  ('enskild_firma', '7840', '7849', '7504'),
  ('enskild_firma', '7850', '7899', '7505'),
  ('enskild_firma', '7900', '7999', '7503'),
  ('enskild_firma', '8000', '8069', '7403'),
  ('enskild_firma', '8070', '8089', '7503'),
  ('enskild_firma', '8090', '8169', '7403'),
  ('enskild_firma', '8170', '8189', '7503'),
  ('enskild_firma', '8190', '8269', '7403'),
  ('enskild_firma', '8270', '8289', '7503'),
  ('enskild_firma', '8290', '8369', '7403'),
  ('enskild_firma', '8370', '8389', '7503'),
  ('enskild_firma', '8390', '8399', '7403'),
  ('enskild_firma', '8400', '8429', '7503'),
  ('enskild_firma', '8430', '8459', '7403'),
  ('enskild_firma', '8460', '8469', '7503'),
  ('enskild_firma', '8470', '8479', '7403'),
  ('enskild_firma', '8480', '8489', '7503'),
  ('enskild_firma', '8490', '8499', '7403'),
  ('enskild_firma', '8810', '8819', '7403'),
  ('enskild_firma', '8850', '8859', '7505'),
  ('enskild_firma', '8860', '8869', '7403'),
  ('enskild_firma', '8880', '8889', '7403')

;

-- Official numeric field codes per form (Skatteverket 2025P4).
CREATE OR REPLACE FUNCTION public.sru_code_is_valid(p_code text, p_entity text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $function$
  SELECT CASE
    WHEN p_entity = 'enskild_firma' THEN p_code = ANY (ARRAY['7200', '7210', '7211', '7212', '7213', '7240', '7250', '7260', '7280', '7300', '7320', '7330', '7380', '7381', '7382', '7383', '7400', '7401', '7402', '7403', '7500', '7501', '7502', '7503', '7504', '7505', '7440'])
    ELSE p_code = ANY (ARRAY['7201', '7202', '7214', '7215', '7216', '7217', '7230', '7231', '7233', '7232', '7234', '7235', '7241', '7242', '7243', '7244', '7245', '7246', '7251', '7252', '7261', '7262', '7263', '7270', '7271', '7281', '7301', '7302', '7321', '7322', '7323', '7331', '7332', '7333', '7350', '7351', '7352', '7353', '7354', '7360', '7361', '7362', '7363', '7364', '7365', '7366', '7367', '7369', '7368', '7370', '7410', '7411', '7510', '7412', '7413', '7511', '7512', '7513', '7514', '7515', '7516', '7517', '7414', '7518', '7415', '7519', '7423', '7530', '7416', '7520', '7417', '7521', '7522', '7524', '7419', '7420', '7525', '7421', '7526', '7422', '7527', '7528', '7450', '7550'])
  END;
$function$;

CREATE OR REPLACE FUNCTION public.bas_sru_code(p_account text, p_entity text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $function$
  SELECT r.sru_code
    FROM public.bas_sru_ranges r
   WHERE r.entity_type = CASE WHEN p_entity = 'enskild_firma' THEN 'enskild_firma' ELSE 'aktiebolag' END
     AND p_account BETWEEN r.account_from AND r.account_to
   LIMIT 1;
$function$;

GRANT EXECUTE ON FUNCTION public.sru_code_is_valid(text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bas_sru_code(text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.set_chart_of_accounts_sru_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_entity  text;
  v_derived text;
BEGIN
  SELECT entity_type INTO v_entity FROM public.companies WHERE id = NEW.company_id;
  v_derived := public.bas_sru_code(NEW.account_number, v_entity);

  IF TG_OP = 'INSERT' THEN
    IF v_derived IS NOT NULL THEN
      NEW.sru_code := v_derived;
    ELSIF NEW.sru_code IS NOT NULL AND NOT public.sru_code_is_valid(NEW.sru_code, v_entity) THEN
      NEW.sru_code := NULL;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE of sru_code: an explicit choice must be a real field on the form.
  IF NEW.sru_code IS DISTINCT FROM OLD.sru_code
     AND NEW.sru_code IS NOT NULL
     AND NOT public.sru_code_is_valid(NEW.sru_code, v_entity) THEN
    RAISE EXCEPTION 'SRU-koden % finns inte på %.', NEW.sru_code,
      CASE WHEN v_entity = 'enskild_firma' THEN 'NE-blanketten' ELSE 'INK2R' END
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_chart_of_accounts_sru_code() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS set_chart_of_accounts_sru_code ON public.chart_of_accounts;
CREATE TRIGGER set_chart_of_accounts_sru_code
  BEFORE INSERT OR UPDATE OF sru_code ON public.chart_of_accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.set_chart_of_accounts_sru_code();

-- Backfill. Written as a direct UPDATE of the column the trigger guards; the
-- derived codes are always valid, so the UPDATE branch never raises.
UPDATE public.chart_of_accounts coa
   SET sru_code = COALESCE(
         public.bas_sru_code(coa.account_number, c.entity_type),
         CASE WHEN public.sru_code_is_valid(coa.sru_code, c.entity_type) THEN coa.sru_code END
       )
  FROM public.companies c
 WHERE c.id = coa.company_id
   AND coa.sru_code IS DISTINCT FROM COALESCE(
         public.bas_sru_code(coa.account_number, c.entity_type),
         CASE WHEN public.sru_code_is_valid(coa.sru_code, c.entity_type) THEN coa.sru_code END
       );

COMMIT;
