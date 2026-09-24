-- =============================================================================
-- Close the SECURITY DEFINER surface to `authenticated`
--
-- 20260821210000 revoked EXECUTE from anon on every SECURITY DEFINER function
-- and deliberately left `authenticated` untouched. A catalog audit of what
-- that left behind found SECURITY DEFINER functions that a signed-in user can
-- call through PostgREST with ANOTHER tenant's id and no check in the body:
--
--   * sync_team_to_company(company, team) — a user creates their own team,
--     then calls it with a victim company id and lands in company_members as
--     an ACTIVE ADMIN. Privilege escalation to any company whose UUID is known.
--   * next_voucher_number — bumps another company's voucher counter, creating
--     voucher gaps that BFNAR 2013:2 then requires the victim to explain.
--   * detect_voucher_gaps, year_end_control_status,
--     year_end_profit_disposition_proposal, year_end_db_blockers and the
--     __year_end_* helpers — cross-tenant reads of financial state.
--   * seed_chart_of_accounts, generate_delivery_note_number,
--     get_next_arrival_number, check_and_increment_inbox_quota,
--     company_entity_type — cross-tenant writes / reads.
--   * cleanup_sandbox_user, finalize_sie_import, the signup provisioning
--     family, claim_due_webhook_deliveries, check_email_exists, … — functions
--     only the server (service role) or other SECURITY DEFINER functions call.
--
-- Two remedies, chosen per function from its call sites (app/, lib/,
-- extensions/, components/ and every SQL caller):
--
--   1. REVOKE from authenticated where no signed-in session ever calls it. The
--      server calls these through a service-role client, and SQL callers are
--      themselves SECURITY DEFINER (they execute as the owner), so nothing
--      legitimate loses access.
--   2. A tenant guard where user sessions do call it: the canonical claims
--      check from 20260619130100 — anon/authenticated must have access to
--      p_company_id (user_company_ids(), which includes agency access);
--      service_role and no-claims callers (MCP / API-key / cron / migrations /
--      the pg harness) bypass by design because their scoping happens in TS.
--
-- Function bodies below are the live definitions (pg_get_functiondef after the
-- full replay) with only the guard added.
--
-- Deliberately not changed: company_has_feature / company_feature_usage /
-- company_commercial_limit / assert_company_commercial_limit. Views owned by
-- postgres (platform_company_overview_v, agency_client_overview_v, …) call
-- them for companies the viewer is not a direct member of, and the claims
-- guard would break those views. They expose plan limits, not ledger data.
--
-- pg-test: covered-by tests/pg/security-definer-authenticated-surface.pg.test.ts
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Guard helper
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_company_member_claims(p_company_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
BEGIN
  IF v_jwt_role IN ('anon', 'authenticated')
     AND (p_company_id IS NULL OR p_company_id NOT IN (SELECT public.user_company_ids())) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.assert_company_member_claims(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assert_company_member_claims(uuid) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 1. Service-role / internal only
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_fn regprocedure;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosecdef
       AND p.proname = ANY (ARRAY[
         'sync_team_to_company',
         'cleanup_sandbox_user',
         'cleanup_expired_sandbox_users',
         'check_email_exists',
         'claim_due_webhook_deliveries',
         'mark_signup_draft_password_set',
         'provision_authorized_signup_draft_v4',
         'provision_signup_draft',
         'provision_verified_signup_draft',
         'provision_verified_signup_draft_v2',
         'provision_verified_signup_draft_core_v3',
         'finalize_signup_draft_provisioning_v2',
         'verify_signup_draft_email',
         'validate_and_increment_api_key',
         'update_overdue_supplier_invoices',
         'finalize_sie_import',
         'validate_version_chain',
         'seed_tax_codes_for_user',
         'year_end_db_blockers',
         '__year_end_adjustment_hash',
         '__year_end_control_status_workpaper_core_20260730',
         '__year_end_ledger_hash',
         '__year_end_readiness_hash',
         '__year_end_workpaper_category_snapshot'
       ])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
  END LOOP;
END;
$$;

-- -----------------------------------------------------------------------------
-- 2. Tenant guards on functions signed-in sessions call
-- -----------------------------------------------------------------------------

-- detect_voucher_gaps
CREATE OR REPLACE FUNCTION public.detect_voucher_gaps(p_company_id uuid, p_fiscal_period_id uuid, p_series text DEFAULT 'A'::text)
 RETURNS TABLE(gap_start integer, gap_end integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Tenant guard (20260924100000): anon/authenticated callers must have
  -- access to p_company_id; service_role / no-claims callers bypass by design.
  PERFORM public.assert_company_member_claims(p_company_id);

  RETURN QUERY
  WITH numbered AS (
    SELECT voucher_number,
           LEAD(voucher_number) OVER (ORDER BY voucher_number) AS next_number
    FROM public.journal_entries
    WHERE company_id = p_company_id
      AND fiscal_period_id = p_fiscal_period_id
      AND voucher_series = p_series
      AND status != 'draft'
    ORDER BY voucher_number
  )
  SELECT
    voucher_number + 1 AS gap_start,
    next_number - 1 AS gap_end
  FROM numbered
  WHERE next_number IS NOT NULL
    AND next_number > voucher_number + 1;
END;
$function$;

-- next_voucher_number
CREATE OR REPLACE FUNCTION public.next_voucher_number(p_company_id uuid, p_fiscal_period_id uuid, p_series text DEFAULT 'A'::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_next integer;
BEGIN
  -- Tenant guard (20260924100000): anon/authenticated callers must have
  -- access to p_company_id; service_role / no-claims callers bypass by design.
  PERFORM public.assert_company_member_claims(p_company_id);

  INSERT INTO public.voucher_sequences (company_id, user_id, fiscal_period_id, voucher_series, last_number)
  VALUES (p_company_id, auth.uid(), p_fiscal_period_id, p_series, 1)
  ON CONFLICT (company_id, fiscal_period_id, voucher_series)
  DO UPDATE SET
    last_number = public.voucher_sequences.last_number + 1,
    updated_at = now()
  RETURNING last_number INTO v_next;

  RETURN v_next;
END;
$function$;

-- seed_chart_of_accounts
CREATE OR REPLACE FUNCTION public.seed_chart_of_accounts(p_company_id uuid, p_entity_type text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_account_count integer;
  v_user_id uuid;
BEGIN
  -- Tenant guard (20260924100000): anon/authenticated callers must have
  -- access to p_company_id; service_role / no-claims callers bypass by design.
  PERFORM public.assert_company_member_claims(p_company_id);

  SELECT created_by INTO v_user_id FROM public.companies WHERE id = p_company_id;

  SELECT count(*) INTO v_account_count
  FROM public.chart_of_accounts
  WHERE company_id = p_company_id;

  IF v_account_count > 0 THEN
    RETURN;
  END IF;

  -- Assets (1xxx)
  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
  VALUES
    (v_user_id, p_company_id, '1510', 'Kundfordringar', 1, '15', 'asset', 'debit', 'k1', true),
    (v_user_id, p_company_id, '1910', 'Kassa', 1, '19', 'asset', 'debit', 'k1', true),
    (v_user_id, p_company_id, '1930', 'Foretagskonto / checkkonto', 1, '19', 'asset', 'debit', 'k1', true),
    (v_user_id, p_company_id, '1940', 'Ovriga bankkonton', 1, '19', 'asset', 'debit', 'k1', true);

  -- Equity (2xxx)
  IF p_entity_type = 'enskild_firma' THEN
    INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
    VALUES
      (v_user_id, p_company_id, '2010', 'Eget kapital', 2, '20', 'equity', 'credit', 'k1', true),
      (v_user_id, p_company_id, '2013', 'Ovriga egna uttag', 2, '20', 'equity', 'credit', 'k1', true),
      (v_user_id, p_company_id, '2018', 'Ovriga egna insattningar', 2, '20', 'equity', 'credit', 'k1', true);
  END IF;

  IF p_entity_type = 'aktiebolag' THEN
    INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
    VALUES
      (v_user_id, p_company_id, '2081', 'Aktiekapital', 2, '20', 'equity', 'credit', 'k1', true),
      (v_user_id, p_company_id, '2091', 'Balanserat resultat', 2, '20', 'equity', 'credit', 'k1', true),
      (v_user_id, p_company_id, '2099', 'Arets resultat', 2, '20', 'equity', 'credit', 'k1', true);
  END IF;

  -- Liabilities (2xxx) — corrected VAT account labels per BAS 2026
  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
  VALUES
    (v_user_id, p_company_id, '2440', 'Leverantorsskulder', 2, '24', 'liability', 'credit', 'k1', true),
    (v_user_id, p_company_id, '2611', 'Utgaende moms forsaljning inom Sverige, 25%', 2, '26', 'liability', 'credit', 'k1', true),
    (v_user_id, p_company_id, '2621', 'Utgaende moms forsaljning inom Sverige, 12%', 2, '26', 'liability', 'credit', 'k1', true),
    (v_user_id, p_company_id, '2631', 'Utgaende moms forsaljning inom Sverige,  6%', 2, '26', 'liability', 'credit', 'k1', true),
    (v_user_id, p_company_id, '2641', 'Debiterad ingaende moms', 2, '26', 'liability', 'credit', 'k1', true),
    (v_user_id, p_company_id, '2650', 'Redovisningskonto for moms', 2, '26', 'liability', 'credit', 'k1', true),
    (v_user_id, p_company_id, '2710', 'Personalskatt', 2, '27', 'liability', 'credit', 'k1', true),
    (v_user_id, p_company_id, '2731', 'Avrakning socialavgifter', 2, '27', 'liability', 'credit', 'k1', true);

  IF p_entity_type = 'aktiebolag' THEN
    INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
    VALUES
      (v_user_id, p_company_id, '2893', 'Skuld till aktieagare', 2, '28', 'liability', 'credit', 'k1', true);
  END IF;

  -- Revenue (3xxx)
  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
  VALUES
    (v_user_id, p_company_id, '3001', 'Forsaljning tjanster 25%', 3, '30', 'revenue', 'credit', 'k1', true),
    (v_user_id, p_company_id, '3002', 'Forsaljning varor 25%', 3, '30', 'revenue', 'credit', 'k1', true),
    (v_user_id, p_company_id, '3100', 'Momsfri forsaljning', 3, '31', 'revenue', 'credit', 'k1', true),
    (v_user_id, p_company_id, '3900', 'Ovriga rorelseintakter', 3, '39', 'revenue', 'credit', 'k1', true),
    (v_user_id, p_company_id, '3960', 'Valutakursvinster', 3, '39', 'revenue', 'credit', 'k1', true);

  -- COGS (4xxx)
  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
  VALUES
    (v_user_id, p_company_id, '4000', 'Varuinkop', 4, '40', 'expense', 'debit', 'k1', true);

  -- External expenses (5xxx-6xxx)
  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
  VALUES
    (v_user_id, p_company_id, '5010', 'Lokalhyra', 5, '50', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '5410', 'Forbrukningsinventarier', 5, '54', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '5420', 'Programvaror', 5, '54', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '5460', 'Forbrukningsmaterial', 5, '54', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '5800', 'Resekostnader', 5, '58', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '5910', 'Annonsering', 5, '59', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '6071', 'Representation avdragsgill', 6, '60', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '6110', 'Kontorsmateriel', 6, '61', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '6212', 'Mobiltelefon', 6, '62', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '6230', 'Datakommunikation', 6, '62', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '6530', 'Redovisningstjanster', 6, '65', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '6570', 'Bankavgifter', 6, '65', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '6991', 'Ovriga avdragsgilla kostnader', 6, '69', 'expense', 'debit', 'k1', true);

  -- Personnel (7xxx)
  IF p_entity_type = 'aktiebolag' THEN
    INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
    VALUES
      (v_user_id, p_company_id, '7010', 'Loner', 7, '70', 'expense', 'debit', 'k1', true),
      (v_user_id, p_company_id, '7210', 'Semesterloner', 7, '72', 'expense', 'debit', 'k1', true),
      (v_user_id, p_company_id, '7510', 'Arbetsgivaravgifter', 7, '75', 'expense', 'debit', 'k1', true);
  END IF;

  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
  VALUES
    (v_user_id, p_company_id, '7960', 'Valutakursforluster', 7, '79', 'expense', 'debit', 'k1', true);

  -- Financial (8xxx)
  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
  VALUES
    (v_user_id, p_company_id, '8310', 'Ranteintakter', 8, '83', 'revenue', 'credit', 'k1', true),
    (v_user_id, p_company_id, '8410', 'Rantekostnader', 8, '84', 'expense', 'debit', 'k1', true);
END;
$function$;

-- generate_delivery_note_number
CREATE OR REPLACE FUNCTION public.generate_delivery_note_number(p_company_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_number INTEGER;
  v_year TEXT;
BEGIN
  -- Tenant guard (20260924100000): anon/authenticated callers must have
  -- access to p_company_id; service_role / no-claims callers bypass by design.
  PERFORM public.assert_company_member_claims(p_company_id);

  UPDATE public.company_settings
  SET next_delivery_note_number = next_delivery_note_number + 1,
      updated_at = now()
  WHERE company_id = p_company_id
  RETURNING next_delivery_note_number - 1
  INTO v_number;

  IF v_number IS NULL THEN
    RAISE EXCEPTION 'Company settings not found for company %', p_company_id;
  END IF;

  v_year := EXTRACT(YEAR FROM CURRENT_DATE)::TEXT;
  RETURN 'FS-' || v_year || LPAD(v_number::TEXT, 3, '0');
END;
$function$;

-- get_next_arrival_number
CREATE OR REPLACE FUNCTION public.get_next_arrival_number(p_company_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_next integer;
BEGIN
  -- Tenant guard (20260924100000): anon/authenticated callers must have
  -- access to p_company_id; service_role / no-claims callers bypass by design.
  PERFORM public.assert_company_member_claims(p_company_id);

  SELECT COALESCE(MAX(arrival_number), 0) + 1
  INTO v_next
  FROM public.supplier_invoices
  WHERE company_id = p_company_id;

  RETURN v_next;
END;
$function$;

-- year_end_control_status
CREATE OR REPLACE FUNCTION public.year_end_control_status(p_company_id uuid, p_fiscal_period_id uuid)
 RETURNS TABLE(control_code text, control_category text, status text, ledger_amount numeric, supporting_register_amount numeric, difference numeric, source_type text, verification_method text, evidence_count integer, is_stale boolean, is_blocking boolean, message text, available_actions jsonb, metadata jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- Tenant guard (20260924100000).
  SELECT public.assert_company_member_claims(p_company_id);
  SELECT
    core.control_code,
    core.control_category,
    CASE
      WHEN wp.id IS NULL THEN core.status
      WHEN wp.status = 'imported_from_sie'
        AND core.status IN ('completion_required', 'manual_verification_required')
        THEN 'imported_from_sie'
      WHEN wp.status IN (
        'automatically_reconciled',
        'sie_balance_accepted',
        'external_evidence_verified',
        'manually_adjusted'
      ) AND abs(coalesce(wp.current_amount, 0) - coalesce(core.ledger_amount, 0)) < 0.01
        THEN wp.status
      WHEN wp.status IN ('actual_difference', 'blocking_accounting_error')
        OR abs(coalesce(wp.current_amount, 0) - coalesce(core.ledger_amount, 0)) >= 0.01
        THEN 'actual_difference'
      ELSE core.status
    END AS status,
    core.ledger_amount,
    CASE
      WHEN wp.status = 'imported_from_sie' AND core.status = 'reconciled'
        THEN core.supporting_register_amount
      WHEN wp.status = 'imported_from_sie'
        AND core.status IN ('completion_required', 'manual_verification_required')
        THEN NULL
      WHEN wp.id IS NOT NULL THEN wp.current_amount
      ELSE core.supporting_register_amount
    END AS supporting_register_amount,
    CASE
      WHEN wp.status = 'imported_from_sie' AND core.status = 'reconciled'
        THEN core.difference
      WHEN wp.status = 'imported_from_sie'
        AND core.status IN ('completion_required', 'manual_verification_required')
        THEN NULL
      WHEN wp.id IS NOT NULL
        THEN round(wp.current_amount - core.ledger_amount, 2)
      ELSE core.difference
    END AS difference,
    CASE
      WHEN wp.status = 'imported_from_sie' AND core.status = 'reconciled'
        THEN core.source_type
      ELSE coalesce(wp.source_type, core.source_type)
    END AS source_type,
    CASE
      WHEN wp.status = 'imported_from_sie' AND core.status = 'reconciled'
        THEN core.verification_method
      ELSE coalesce(wp.verification_method, core.verification_method)
    END AS verification_method,
    core.evidence_count,
    core.is_stale OR wp.pending_sie_import_id IS NOT NULL AS is_stale,
    CASE
      WHEN wp.id IS NULL THEN core.is_blocking
      WHEN wp.status = 'imported_from_sie'
        AND core.status IN ('completion_required', 'manual_verification_required')
        THEN true
      WHEN wp.status IN ('actual_difference', 'blocking_accounting_error')
        OR abs(coalesce(wp.current_amount, 0) - coalesce(core.ledger_amount, 0)) >= 0.01
        OR wp.pending_sie_import_id IS NOT NULL
        THEN true
      WHEN wp.status IN (
        'automatically_reconciled',
        'sie_balance_accepted',
        'external_evidence_verified',
        'manually_adjusted'
      ) THEN false
      ELSE core.is_blocking
    END AS is_blocking,
    CASE
      WHEN wp.pending_sie_import_id IS NOT NULL
        THEN 'En ny SIE-import avviker från tidigare godkänt underlag. Välj vilket värde som ska gälla.'
      WHEN wp.status = 'imported_from_sie'
        AND core.status IN ('completion_required', 'manual_verification_required')
        THEN format(
          '%s enligt importerad SIE: %s kr. Historiskt detaljregister saknas i Nordklart; bekräfta saldot eller verifiera ett externt underlag.',
          CASE core.control_category
            WHEN 'customer_receivables' THEN 'Kundfordringar'
            WHEN 'supplier_payables' THEN 'Leverantörsskulder'
            WHEN 'equity' THEN 'Eget kapital'
            WHEN 'tax' THEN 'Skatt'
            WHEN 'vat' THEN 'Moms'
            ELSE core.control_category
          END,
          to_char(coalesce(core.ledger_amount, 0), 'FM999G999G999G990D00')
        )
      WHEN wp.status = 'sie_balance_accepted'
        THEN 'Det importerade SIE-saldot är bekräftat som historiskt bokslutsunderlag. Ingen ny verifikation har skapats.'
      WHEN wp.status = 'automatically_reconciled'
        THEN 'Kontrollen är automatiskt avstämd från huvudboken.'
      WHEN wp.status = 'manually_adjusted'
        THEN 'Bokslutsunderlaget är manuellt kompletterat utan att huvudboken skrivits om.'
      WHEN wp.status = 'actual_difference'
        THEN 'Två faktiska värden skiljer sig. Förklara differensen eller skapa en korrigeringsverifikation om huvudboken är fel.'
      ELSE core.message
    END AS message,
    CASE
      WHEN wp.status = 'imported_from_sie'
        AND core.status IN ('completion_required', 'manual_verification_required')
        THEN jsonb_build_array(
          'accept_sie_balance',
          'verify_external_evidence',
          'adjust_workpaper'
        )
      WHEN wp.pending_sie_import_id IS NOT NULL
        THEN jsonb_build_array('resolve_reimport_conflict')
      ELSE core.available_actions
    END AS available_actions,
    core.metadata || CASE
      WHEN wp.id IS NULL THEN '{}'::jsonb
      ELSE jsonb_build_object(
        'workpaper_id', wp.id,
        'workpaper_status', wp.status,
        'source_sie_import_id', wp.source_sie_import_id,
        'account_numbers', to_jsonb(wp.account_numbers),
        'support_register_available', wp.support_register_available,
        'pending_sie_import_id', wp.pending_sie_import_id,
        'pending_imported_amount', wp.pending_imported_amount,
        'requires_confirmation', wp.status = 'imported_from_sie',
        'requires_accounting_correction', wp.status IN (
          'actual_difference', 'blocking_accounting_error'
        )
      )
    END AS metadata
  FROM public.__year_end_control_status_workpaper_core_20260730(
    p_company_id, p_fiscal_period_id
  ) core
  LEFT JOIN public.year_end_historical_workpapers wp
    ON wp.company_id = p_company_id
   AND wp.fiscal_period_id = p_fiscal_period_id
   AND wp.category = CASE core.control_category
     WHEN 'customer_receivables' THEN 'customer_receivables'
     WHEN 'supplier_payables' THEN 'supplier_payables'
     WHEN 'equity' THEN 'equity'
     WHEN 'tax' THEN 'tax'
     WHEN 'vat' THEN 'vat'
     ELSE '__not_a_workpaper_control__'
   END;
$function$;

-- year_end_profit_disposition_proposal
CREATE OR REPLACE FUNCTION public.year_end_profit_disposition_proposal(p_company_id uuid, p_fiscal_period_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_period_end date;
  v_current_result numeric;
  v_prior_free_equity numeric;
  v_available numeric;
BEGIN
  -- Tenant guard (20260924100000): anon/authenticated callers must have
  -- access to p_company_id; service_role / no-claims callers bypass by design.
  PERFORM public.assert_company_member_claims(p_company_id);

  SELECT fp.period_end INTO v_period_end
  FROM public.fiscal_periods fp
  WHERE fp.id = p_fiscal_period_id
    AND fp.company_id = p_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'YEAR_END_PROFIT_PROPOSAL_PERIOD_NOT_FOUND'
      USING ERRCODE = '22023';
  END IF;

  SELECT round(coalesce(sum(jel.credit_amount - jel.debit_amount), 0), 2)
  INTO v_current_result
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  WHERE je.company_id = p_company_id
    AND je.entry_date <= v_period_end
    AND je.status IN ('posted', 'reversed')
    AND jel.account_number BETWEEN '3000' AND '8999';

  SELECT round(coalesce(sum(jel.credit_amount - jel.debit_amount), 0), 2)
  INTO v_prior_free_equity
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  WHERE je.company_id = p_company_id
    AND je.entry_date <= v_period_end
    AND je.status IN ('posted', 'reversed')
    AND jel.account_number IN ('2091', '2098');

  v_available := round(v_prior_free_equity + v_current_result, 2);
  RETURN jsonb_build_object(
    'current_year_result', v_current_result,
    'free_equity', greatest(v_available, 0),
    'proposed_dividend', 0,
    'carried_forward', greatest(v_available, 0),
    'proposal_text', format(
      'Styrelsen föreslår att %s kr balanseras i ny räkning.',
      to_char(greatest(v_available, 0), 'FM999G999G999G990D00')
    )
  );
END;
$function$;

-- check_and_increment_inbox_quota
CREATE OR REPLACE FUNCTION public.check_and_increment_inbox_quota(p_company_id uuid, p_minute_max integer, p_day_max integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_minute_key   text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI');
  v_day_key      text := to_char(now() AT TIME ZONE 'Europe/Stockholm', 'YYYY-MM-DD');
  v_minute_count integer;
  v_day_count    integer;
BEGIN
  -- Tenant guard (20260924100000): anon/authenticated callers must have
  -- access to p_company_id; service_role / no-claims callers bypass by design.
  PERFORM public.assert_company_member_claims(p_company_id);

  -- 1) Minute window — slide upsert + increment, then check.
  INSERT INTO public.inbox_rate_counters (company_id, window_kind, window_key, count)
  VALUES (p_company_id, 'minute', v_minute_key, 1)
  ON CONFLICT (company_id, window_kind, window_key)
  DO UPDATE SET count = inbox_rate_counters.count + 1, updated_at = now()
  RETURNING count INTO v_minute_count;

  IF v_minute_count > p_minute_max THEN
    UPDATE public.inbox_rate_counters
      SET count = count - 1
      WHERE company_id = p_company_id
        AND window_kind = 'minute'
        AND window_key = v_minute_key;
    RETURN jsonb_build_object('ok', false, 'scope', 'minute', 'retry_after_sec', 60);
  END IF;

  -- 2) Day window — only checked when minute passed.
  INSERT INTO public.inbox_rate_counters (company_id, window_kind, window_key, count)
  VALUES (p_company_id, 'day', v_day_key, 1)
  ON CONFLICT (company_id, window_kind, window_key)
  DO UPDATE SET count = inbox_rate_counters.count + 1, updated_at = now()
  RETURNING count INTO v_day_count;

  IF v_day_count > p_day_max THEN
    -- Roll both counters back: the request didn't go through.
    UPDATE public.inbox_rate_counters
      SET count = count - 1
      WHERE company_id = p_company_id
        AND window_kind = 'day'
        AND window_key = v_day_key;
    UPDATE public.inbox_rate_counters
      SET count = count - 1
      WHERE company_id = p_company_id
        AND window_kind = 'minute'
        AND window_key = v_minute_key;
    RETURN jsonb_build_object('ok', false, 'scope', 'day', 'retry_after_sec', 3600);
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$function$;

-- company_entity_type
CREATE OR REPLACE FUNCTION public.company_entity_type(p_company_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- Tenant guard (20260924100000).
  SELECT public.assert_company_member_claims(p_company_id);
  SELECT entity_type FROM public.companies WHERE id = p_company_id
$function$;

-- check_and_increment_agent_quota
CREATE OR REPLACE FUNCTION public.check_and_increment_agent_quota(p_user_id uuid, p_minute_max integer, p_day_max integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_minute_key   text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI');
  v_day_key      text := to_char(now() AT TIME ZONE 'Europe/Stockholm', 'YYYY-MM-DD');
  v_minute_count integer;
  v_day_count    integer;
BEGIN
  -- A signed-in user may only consume their own quota. Without this any
  -- session could burn another user's minute/day window (a cheap DoS on the
  -- assistant). service_role / no-claims callers bypass by design.
  IF coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') IN ('anon', 'authenticated')
     AND p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'unauthorized: quota belongs to another user' USING ERRCODE = '42501';
  END IF;

  -- 1) Minute window — burst guard.
  INSERT INTO public.agent_rate_counters (user_id, window_kind, window_key, count)
  VALUES (p_user_id, 'minute', v_minute_key, 1)
  ON CONFLICT (user_id, window_kind, window_key)
  DO UPDATE SET count = agent_rate_counters.count + 1, updated_at = now()
  RETURNING count INTO v_minute_count;

  IF v_minute_count > p_minute_max THEN
    UPDATE public.agent_rate_counters SET count = count - 1
      WHERE user_id = p_user_id AND window_kind = 'minute' AND window_key = v_minute_key;
    RETURN jsonb_build_object('ok', false, 'scope', 'minute', 'retry_after_sec', 60);
  END IF;

  -- 2) Day window — slow-drip backstop (only checked once minute passes).
  INSERT INTO public.agent_rate_counters (user_id, window_kind, window_key, count)
  VALUES (p_user_id, 'day', v_day_key, 1)
  ON CONFLICT (user_id, window_kind, window_key)
  DO UPDATE SET count = agent_rate_counters.count + 1, updated_at = now()
  RETURNING count INTO v_day_count;

  IF v_day_count > p_day_max THEN
    -- Roll both counters back: the request didn't go through.
    UPDATE public.agent_rate_counters SET count = count - 1
      WHERE user_id = p_user_id AND window_kind = 'day' AND window_key = v_day_key;
    UPDATE public.agent_rate_counters SET count = count - 1
      WHERE user_id = p_user_id AND window_kind = 'minute' AND window_key = v_minute_key;
    RETURN jsonb_build_object('ok', false, 'scope', 'day', 'retry_after_sec', 3600);
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$function$;

COMMIT;
