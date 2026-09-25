-- =============================================================================
-- Supabase security advisor: close what it reports, keep what is by design
--
-- Advisor state on production after 20260925132000 (2026-09-25):
--   ERROR security_definer_view ................................. 3
--   WARN  function_search_path_mutable .......................... 18
--   WARN  authenticated_security_definer_function_executable .... 137
--   WARN  extension_in_public (btree_gist) ...................... 1
--
-- 1. EXECUTE on SECURITY DEFINER functions. Every one of the 137 was checked
--    against its call sites (app/, lib/, extensions/, components/, scripts/,
--    policies, views and SQL callers) and its body:
--
--    * 34 are trigger functions. Revoked (1a).
--    * 25 are never called by a signed-in session. Revoked (1b). Some of them
--      were holes, not hygiene:
--        - delete_user_account(uuid): any user could call it for themselves
--          through /rest/v1/rpc. It deletes audit_log for every company the
--          user created and runs with the journal immutability, retention and
--          document WORM triggers disabled — räkenskapsinformation the company
--          must keep for seven years (BFL 7 kap). Superseded by
--          anonymize_user_account and unused; revoked from service_role too.
--        - start_onboarding_session / queue_bank_transaction_review /
--          reserve_voucher_range / release_voucher_range: unused, and the two
--          voucher-range functions let any member (viewer included) move a
--          voucher sequence.
--    * create_company_with_owner stays callable but only for the anonymous
--      sandbox (3). A regular session could call it through PostgREST and get
--      an owner membership that never passed the BankID / Bolagsverket check
--      that create_company_for_founder enforces (20260925 phase 4).
--    * The remaining 78 are called from user sessions on purpose (RLS helpers,
--      numbering, onboarding, platform admin actions, year-end reads …) and
--      each checks its caller in the body. They stay; the advisor keeps
--      warning about them because it cannot read the body.
--      tests/pg/advisor-hardening.pg.test.ts pins that list.
--
-- 2. search_path pinned on the 18 functions that had none.
--
-- 4. The three SECURITY DEFINER views become security_invoker:
--    * skatteverket_connections_v reads skatteverket_tokens as the caller. The
--      caller gets a SELECT policy scoped to their companies and a column
--      grant WITHOUT access_token / refresh_token, so the token columns stay
--      unreadable for every session role (the table had full table-level
--      grants to anon and authenticated, held back only by "RLS, no policy").
--    * public_price_plans_v / public_price_start_v are read by the public
--      pricing page and /api/public/price-plan, now through the service client
--      on the server. anon/authenticated lose access to the views; the rows
--      were already public (active, is_public plans) but the view joined
--      platform tables the caller has no policy on.
--
-- 5. btree_gist moves out of public into extensions. The only dependant is the
--    no_overlapping_fiscal_periods exclusion constraint, which references the
--    operator class by OID and is unaffected.
-- =============================================================================

-- 1a. Trigger functions (34). EXECUTE is checked when a trigger is CREATED,
--     never when it fires, so no caller needs it. Through PostgREST they are
--     only an error surface ("trigger functions can only be called as
--     triggers") that the advisor rightly counts as exposed.
REVOKE EXECUTE ON FUNCTION public.block_document_deletion() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.auto_provision_company_inbox() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.block_operation_terminal_delete() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_webhook_delivery_immutability() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_retention_journal_entries() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.hydrate_subscription_plan_version() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prevent_payment_initiation_delete() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.write_audit_log() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.archive_year_end_fx_rate_snapshot() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.invalidate_historical_support_from_entry() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.invalidate_historical_support_from_sie_import() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.invalidate_year_end_manual_cash_from_entry() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.invalidate_year_end_manual_cash_from_line() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_entity_type_mirror() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.protect_year_end_manual_cash_document() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.seed_year_end_control_accounts() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_annual_report_document_lock() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_subscription_entitlements() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_year_end_bank_control_account() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_new_feature_to_complimentary_grants() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.remove_team_member_from_companies() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.assert_webhook_delivery_company_match() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.block_webhook_delivery_terminal_delete() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_operation_immutability() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.guard_legacy_plan_commercial_mutation() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.nordklart_handle_auth_signup_context() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.guard_plan_version_mutation() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.guard_plan_version_feature_mutation() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.signed_consents_immutable() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_team_member_to_companies() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.audit_annual_report_document_change() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.refresh_historical_workpapers_after_sie() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_document_metadata_immutability() FROM PUBLIC, anon, authenticated;

-- 1b. Functions no signed-in session calls (25). Callers are the service
--     role (Stripe webhook, cron), other SECURITY DEFINER functions (which
--     execute as the owner), or nothing at all any more.
REVOKE EXECUTE ON FUNCTION public.assert_company_commercial_limit(uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assert_company_commercial_limit(uuid,text,text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.assert_company_member_claims(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assert_company_member_claims(uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.company_entity_type(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.company_entity_type(uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.company_feature_usage(uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.company_feature_usage(uuid,text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.company_has_feature(uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.company_has_feature(uuid,text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.create_team_with_owner(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_team_with_owner(text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.delete_user_account(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.delete_user_account(uuid) FROM service_role;
REVOKE EXECUTE ON FUNCTION public.match_booking_templates(vector,integer,double precision) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_booking_templates(vector,integer,double precision) TO service_role;
REVOKE EXECUTE ON FUNCTION public.match_documents(vector,integer,double precision) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_documents(vector,integer,double precision) TO service_role;
REVOKE EXECUTE ON FUNCTION public.plan_version_snapshot(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.plan_version_snapshot(uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.platform_activate_due_price_plan_versions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.platform_activate_due_price_plan_versions() TO service_role;
REVOKE EXECUTE ON FUNCTION public.queue_bank_transaction_review(uuid,uuid,text,text,integer,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.queue_bank_transaction_review(uuid,uuid,text,text,integer,text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.release_voucher_range(uuid,uuid,text,integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_voucher_range(uuid,uuid,text,integer,integer) TO service_role;
REVOKE EXECUTE ON FUNCTION public.replace_period_opening_balance_link(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_period_opening_balance_link(uuid,uuid,uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.require_platform_commercial_admin() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.require_platform_commercial_admin() TO service_role;
REVOKE EXECUTE ON FUNCTION public.require_service_role() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.require_service_role() TO service_role;
REVOKE EXECUTE ON FUNCTION public.reserve_voucher_range(uuid,uuid,text,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_voucher_range(uuid,uuid,text,integer) TO service_role;
REVOKE EXECUTE ON FUNCTION public.start_onboarding_session(uuid,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_onboarding_session(uuid,text,uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.stripe_finalize_checkout(text,text,text,text,text,bigint,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stripe_finalize_checkout(text,text,text,text,text,bigint,text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.stripe_finalize_checkout_v2(text,text,text,text,text,bigint,bigint,bigint,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stripe_finalize_checkout_v2(text,text,text,text,text,bigint,bigint,bigint,text,text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.stripe_mark_checkout_expired(text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stripe_mark_checkout_expired(text,text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.stripe_record_invoice_event(text,text,text,text,text,bigint,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stripe_record_invoice_event(text,text,text,text,text,bigint,text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.stripe_record_invoice_event_v2(text,text,text,text,text,bigint,bigint,bigint,text,text,text,timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stripe_record_invoice_event_v2(text,text,text,text,text,bigint,bigint,bigint,text,text,text,timestamp with time zone) TO service_role;
REVOKE EXECUTE ON FUNCTION public.stripe_sync_subscription(text,text,text,text,text,timestamp with time zone,timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stripe_sync_subscription(text,text,text,text,text,timestamp with time zone,timestamp with time zone) TO service_role;
REVOKE EXECUTE ON FUNCTION public.stripe_sync_subscription_v2(text,text,text,text,text,timestamp with time zone,timestamp with time zone,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stripe_sync_subscription_v2(text,text,text,text,text,timestamp with time zone,timestamp with time zone,boolean) TO service_role;

-- 2. Pin search_path on the 18 functions that had none. "public, extensions,
--    pg_temp" is exactly what they resolved against before (the database
--    default minus $user), so no body changes meaning.
ALTER FUNCTION public.block_contradictory_invoice_denorm() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.skatteverket_audit_immutable() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.franvaro_audit_immutable() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.assign_franvaro_specifikationsnummer() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.enforce_asset_post_disposal_immutability() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.enforce_pending_operations_input_frozen() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.is_transaction_booked(uuid) SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.enforce_pending_operations_immutability() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.enforce_payment_company_consistency() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.enforce_depreciation_schedule_immutability() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.enforce_invoice_payment_adjustment_company_consistency() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.assign_franvaro_specifikationsnummer_on_update() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.enforce_signed_signature_request_immutability() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.enforce_document_journal_entry_immutability() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.enforce_transactions_document_immutability() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.assistant_faq_questions_text(jsonb) SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.enforce_pending_operations_no_delete() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.check_salary_day_hours_cap() SET search_path = public, extensions, pg_temp;

-- 3. create_company_with_owner: anonymous sandbox only.
CREATE OR REPLACE FUNCTION public.create_company_with_owner(p_name text, p_entity_type text, p_set_active boolean DEFAULT true, p_team_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid;
  v_company_id uuid;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Real companies are created by create_company_for_founder, through the
  -- onboarding server action, after the founder has been verified (BankID and
  -- Bolagsverket on hosted). This function stays reachable from a session only
  -- for the anonymous sandbox; a regular session calling it through PostgREST
  -- would get an unverified owner and skip that check entirely.
  IF coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Företag skapas via onboardingen.'
      USING ERRCODE = '42501',
            HINT = 'create_company_with_owner is reserved for the anonymous sandbox.';
  END IF;

  IF p_entity_type NOT IN ('enskild_firma', 'aktiebolag') THEN
    RAISE EXCEPTION 'Invalid entity_type: %', p_entity_type;
  END IF;

  -- Authorize p_team_id before any write. SECURITY DEFINER bypasses RLS, so
  -- we must verify membership ourselves; without this any authenticated user
  -- could attach a company to an arbitrary team.
  IF p_team_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.team_members
      WHERE team_id = p_team_id
        AND user_id = v_user_id
    ) THEN
      RAISE EXCEPTION 'Not a member of team %', p_team_id
        USING ERRCODE = '42501'; -- insufficient_privilege
    END IF;
  END IF;

  INSERT INTO public.companies (name, entity_type, created_by, team_id)
  VALUES (p_name, p_entity_type, v_user_id, p_team_id)
  RETURNING id INTO v_company_id;

  INSERT INTO public.company_members (company_id, user_id, role)
  VALUES (v_company_id, v_user_id, 'owner');

  -- Seed default 1930 SEK cash account so reconciliation routes work before
  -- any PSD2 connection is established. is_primary so the __PRIMARY_SEK__
  -- sentinel in skattekonto-booking resolves on day one.
  INSERT INTO public.cash_accounts (
    company_id, ledger_account, currency, name, enabled, is_primary, source
  )
  VALUES (
    v_company_id, '1930', 'SEK', 'Företagskonto (SEK)', true, true, 'manual'
  )
  ON CONFLICT (company_id, ledger_account) DO NOTHING;

  IF p_set_active THEN
    INSERT INTO public.user_preferences (user_id, active_company_id)
    VALUES (v_user_id, v_company_id)
    ON CONFLICT (user_id)
    DO UPDATE SET active_company_id = EXCLUDED.active_company_id;
  END IF;

  IF p_team_id IS NOT NULL THEN
    PERFORM public.sync_team_to_company(v_company_id, p_team_id);
  END IF;

  RETURN v_company_id;
END;
$function$;

-- 4a. skatteverket_connections_v as the caller, without the token columns.
REVOKE ALL ON public.skatteverket_tokens FROM anon, authenticated;
GRANT SELECT (id, company_id, user_id, scope, expires_at, created_at)
  ON public.skatteverket_tokens TO authenticated;

DROP POLICY IF EXISTS skatteverket_tokens_member_select ON public.skatteverket_tokens;
CREATE POLICY skatteverket_tokens_member_select ON public.skatteverket_tokens
  FOR SELECT TO authenticated
  USING (company_id IN (SELECT public.user_company_ids()));

ALTER VIEW public.skatteverket_connections_v SET (security_invoker = true);
REVOKE ALL ON public.skatteverket_connections_v FROM anon, authenticated;
GRANT SELECT ON public.skatteverket_connections_v TO authenticated;

-- 4b. Public pricing views: server-side only.
ALTER VIEW public.public_price_plans_v SET (security_invoker = true);
ALTER VIEW public.public_price_start_v SET (security_invoker = true);
REVOKE ALL ON public.public_price_plans_v FROM anon, authenticated;
REVOKE ALL ON public.public_price_start_v FROM anon, authenticated;
GRANT SELECT ON public.public_price_plans_v TO service_role;
GRANT SELECT ON public.public_price_start_v TO service_role;

-- 5. btree_gist out of public.
CREATE SCHEMA IF NOT EXISTS extensions;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension
     WHERE extname = 'btree_gist' AND extnamespace = 'public'::regnamespace
  ) THEN
    ALTER EXTENSION btree_gist SET SCHEMA extensions;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
