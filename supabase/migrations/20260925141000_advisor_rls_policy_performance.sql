-- =============================================================================
-- Supabase performance advisor: RLS policies
--
--   WARN multiple_permissive_policies ... 355 (61 tables)
--   WARN auth_rls_initplan .............. 97  (53 tables)
--
-- Generated from the live policy catalog (pg_policies after a full replay,
-- identical to production: same 635 policies, same md5 over every
-- name/command/role/USING/WITH CHECK) and then reviewed. Access does not
-- change; only how often Postgres evaluates the expressions.
--
-- Part 1 — one permissive policy per (table, role, command).
--   Most of these tables had "<t>_select FOR SELECT" next to "<t>_write FOR
--   ALL", so every SELECT evaluated both. Permissive policies combine with OR,
--   per command, and Postgres does not pair a policy's USING with its own
--   WITH CHECK when several apply. The replacement is therefore exact:
--     SELECT  USING      = OR of USING of the SELECT and ALL policies
--     INSERT  WITH CHECK = OR of WITH CHECK (ALL: WITH CHECK, else USING)
--     UPDATE  USING      = OR of USING;  WITH CHECK = OR of (WITH CHECK, else USING)
--     DELETE  USING      = OR of USING
--   A policy without USING contributes nothing to USING (it never granted row
--   visibility) and is left out of the OR. Role sets were uniform within every
--   (table, command) group, so no role widens. RESTRICTIVE policies are not
--   touched.
--
-- Part 2 — auth.uid() / auth.jwt() / auth.role() / current_setting() wrapped
--   in a scalar subquery, so it becomes an InitPlan evaluated once per
--   statement instead of once per row (the pattern Supabase documents). The
--   policies rebuilt in part 1 are already wrapped.
--
-- Pinned by tests/pg/advisor-hardening.pg.test.ts (catalog invariants) and
-- the existing tenant-isolation and RLS suites (behaviour).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Part 1: one permissive policy per (table, role, command)
-- ---------------------------------------------------------------------------

-- agency_client_status_snapshots: agency_client_status_select (SELECT), agency_client_status_write (ALL)
DROP POLICY agency_client_status_select ON public.agency_client_status_snapshots;
DROP POLICY agency_client_status_write ON public.agency_client_status_snapshots;
CREATE POLICY agency_client_status_snapshots_select ON public.agency_client_status_snapshots AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (((is_platform_admin() OR user_is_agency_member(agency_id) OR user_can_access_company_v2(company_id))) OR ((is_platform_admin() OR user_is_agency_admin(agency_id))));
CREATE POLICY agency_client_status_snapshots_insert ON public.agency_client_status_snapshots AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK ((is_platform_admin() OR user_is_agency_admin(agency_id)));
CREATE POLICY agency_client_status_snapshots_update ON public.agency_client_status_snapshots AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING ((is_platform_admin() OR user_is_agency_admin(agency_id)))
  WITH CHECK ((is_platform_admin() OR user_is_agency_admin(agency_id)));
CREATE POLICY agency_client_status_snapshots_delete ON public.agency_client_status_snapshots AS PERMISSIVE FOR DELETE TO PUBLIC
  USING ((is_platform_admin() OR user_is_agency_admin(agency_id)));

-- agency_invitations: agency_invitations_platform_write (ALL), agency_invitations_select_admin (SELECT)
DROP POLICY agency_invitations_platform_write ON public.agency_invitations;
DROP POLICY agency_invitations_select_admin ON public.agency_invitations;
CREATE POLICY agency_invitations_select ON public.agency_invitations AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((is_platform_admin()) OR ((is_platform_admin() OR (EXISTS ( SELECT 1
   FROM agency_members am
  WHERE ((am.agency_id = agency_invitations.agency_id) AND (am.user_id = ( SELECT auth.uid() AS uid)) AND (am.status = 'active'::text) AND (am.role = ANY (ARRAY['agency_owner'::text, 'agency_admin'::text]))))))));
CREATE POLICY agency_invitations_insert ON public.agency_invitations AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY agency_invitations_update ON public.agency_invitations AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY agency_invitations_delete ON public.agency_invitations AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- agency_members: agency_members_select (SELECT), agency_members_write (ALL)
DROP POLICY agency_members_select ON public.agency_members;
DROP POLICY agency_members_write ON public.agency_members;
CREATE POLICY agency_members_select ON public.agency_members AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (((is_platform_admin() OR user_is_agency_member(agency_id))) OR (user_is_agency_admin(agency_id)));
CREATE POLICY agency_members_insert ON public.agency_members AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (user_is_agency_admin(agency_id));
CREATE POLICY agency_members_update ON public.agency_members AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (user_is_agency_admin(agency_id))
  WITH CHECK (user_is_agency_admin(agency_id));
CREATE POLICY agency_members_delete ON public.agency_members AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (user_is_agency_admin(agency_id));

-- agency_templates: agency_templates_select (SELECT), agency_templates_write (ALL)
DROP POLICY agency_templates_select ON public.agency_templates;
DROP POLICY agency_templates_write ON public.agency_templates;
CREATE POLICY agency_templates_select ON public.agency_templates AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (((is_platform_admin() OR user_is_agency_member(agency_id))) OR ((is_platform_admin() OR user_is_agency_admin(agency_id))));
CREATE POLICY agency_templates_insert ON public.agency_templates AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK ((is_platform_admin() OR user_is_agency_admin(agency_id)));
CREATE POLICY agency_templates_update ON public.agency_templates AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING ((is_platform_admin() OR user_is_agency_admin(agency_id)))
  WITH CHECK ((is_platform_admin() OR user_is_agency_admin(agency_id)));
CREATE POLICY agency_templates_delete ON public.agency_templates AS PERMISSIVE FOR DELETE TO PUBLIC
  USING ((is_platform_admin() OR user_is_agency_admin(agency_id)));

-- api_client_scopes: api_client_scopes_select (SELECT), api_client_scopes_write (ALL)
DROP POLICY api_client_scopes_select ON public.api_client_scopes;
DROP POLICY api_client_scopes_write ON public.api_client_scopes;
CREATE POLICY api_client_scopes_select ON public.api_client_scopes AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (((EXISTS ( SELECT 1
   FROM api_keys k
  WHERE ((k.id = api_client_scopes.api_key_id) AND user_can_access_company_v2(k.company_id))))) OR ((EXISTS ( SELECT 1
   FROM api_keys k
  WHERE ((k.id = api_client_scopes.api_key_id) AND user_can_write_company(k.company_id))))));
CREATE POLICY api_client_scopes_insert ON public.api_client_scopes AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK ((EXISTS ( SELECT 1
   FROM api_keys k
  WHERE ((k.id = api_client_scopes.api_key_id) AND user_can_write_company(k.company_id)))));
CREATE POLICY api_client_scopes_update ON public.api_client_scopes AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING ((EXISTS ( SELECT 1
   FROM api_keys k
  WHERE ((k.id = api_client_scopes.api_key_id) AND user_can_write_company(k.company_id)))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM api_keys k
  WHERE ((k.id = api_client_scopes.api_key_id) AND user_can_write_company(k.company_id)))));
CREATE POLICY api_client_scopes_delete ON public.api_client_scopes AS PERMISSIVE FOR DELETE TO PUBLIC
  USING ((EXISTS ( SELECT 1
   FROM api_keys k
  WHERE ((k.id = api_client_scopes.api_key_id) AND user_can_write_company(k.company_id)))));

-- api_clients: api_clients_select (SELECT), api_clients_write (ALL)
DROP POLICY api_clients_select ON public.api_clients;
DROP POLICY api_clients_write ON public.api_clients;
CREATE POLICY api_clients_select ON public.api_clients AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (((user_can_access_company_v2(company_id) OR is_platform_admin())) OR ((user_can_write_company(company_id) OR is_platform_admin())));
CREATE POLICY api_clients_insert ON public.api_clients AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK ((user_can_write_company(company_id) OR is_platform_admin()));
CREATE POLICY api_clients_update ON public.api_clients AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING ((user_can_write_company(company_id) OR is_platform_admin()))
  WITH CHECK ((user_can_write_company(company_id) OR is_platform_admin()));
CREATE POLICY api_clients_delete ON public.api_clients AS PERMISSIVE FOR DELETE TO PUBLIC
  USING ((user_can_write_company(company_id) OR is_platform_admin()));

-- api_scopes: api_scopes_admin_write (ALL), api_scopes_select (SELECT)
DROP POLICY api_scopes_admin_write ON public.api_scopes;
DROP POLICY api_scopes_select ON public.api_scopes;
CREATE POLICY api_scopes_select ON public.api_scopes AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((is_platform_admin()) OR ((( SELECT auth.uid() AS uid) IS NOT NULL)));
CREATE POLICY api_scopes_insert ON public.api_scopes AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY api_scopes_update ON public.api_scopes AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY api_scopes_delete ON public.api_scopes AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- automation_decisions: automation_decisions_select (SELECT), automation_decisions_write (ALL)
DROP POLICY automation_decisions_select ON public.automation_decisions;
DROP POLICY automation_decisions_write ON public.automation_decisions;
CREATE POLICY automation_decisions_select ON public.automation_decisions AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((user_can_access_company_v2(company_id)) OR (user_can_write_company(company_id)));
CREATE POLICY automation_decisions_insert ON public.automation_decisions AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (user_can_write_company(company_id));
CREATE POLICY automation_decisions_update ON public.automation_decisions AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));
CREATE POLICY automation_decisions_delete ON public.automation_decisions AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (user_can_write_company(company_id));

-- bank_accounts: bank_accounts_select (SELECT), bank_accounts_write (ALL)
DROP POLICY bank_accounts_select ON public.bank_accounts;
DROP POLICY bank_accounts_write ON public.bank_accounts;
CREATE POLICY bank_accounts_select ON public.bank_accounts AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((user_can_access_company_v2(company_id)) OR (user_can_write_company(company_id)));
CREATE POLICY bank_accounts_insert ON public.bank_accounts AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (user_can_write_company(company_id));
CREATE POLICY bank_accounts_update ON public.bank_accounts AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));
CREATE POLICY bank_accounts_delete ON public.bank_accounts AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (user_can_write_company(company_id));

-- bank_data_providers: bank_data_providers_admin_write (ALL), bank_data_providers_select (SELECT)
DROP POLICY bank_data_providers_admin_write ON public.bank_data_providers;
DROP POLICY bank_data_providers_select ON public.bank_data_providers;
CREATE POLICY bank_data_providers_select ON public.bank_data_providers AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((is_platform_admin()) OR ((( SELECT auth.uid() AS uid) IS NOT NULL)));
CREATE POLICY bank_data_providers_insert ON public.bank_data_providers AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY bank_data_providers_update ON public.bank_data_providers AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY bank_data_providers_delete ON public.bank_data_providers AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- bankgiro_application_documents: bankgiro_application_documents_platform_write (ALL), bankgiro_application_documents_select (SELECT)
DROP POLICY bankgiro_application_documents_platform_write ON public.bankgiro_application_documents;
DROP POLICY bankgiro_application_documents_select ON public.bankgiro_application_documents;
CREATE POLICY bankgiro_application_documents_select ON public.bankgiro_application_documents AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((is_platform_admin()) OR (user_can_access_company_v2(company_id)));
CREATE POLICY bankgiro_application_documents_insert ON public.bankgiro_application_documents AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY bankgiro_application_documents_update ON public.bankgiro_application_documents AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY bankgiro_application_documents_delete ON public.bankgiro_application_documents AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- bankgiro_applications: bankgiro_applications_platform_write (ALL), bankgiro_applications_select (SELECT)
DROP POLICY bankgiro_applications_platform_write ON public.bankgiro_applications;
DROP POLICY bankgiro_applications_select ON public.bankgiro_applications;
CREATE POLICY bankgiro_applications_select ON public.bankgiro_applications AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((is_platform_admin()) OR (user_can_access_company_v2(company_id)));
CREATE POLICY bankgiro_applications_insert ON public.bankgiro_applications AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY bankgiro_applications_update ON public.bankgiro_applications AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY bankgiro_applications_delete ON public.bankgiro_applications AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- bankgiro_provider_status_events: bankgiro_provider_status_events_platform_write (ALL), bankgiro_provider_status_events_select (SELECT)
DROP POLICY bankgiro_provider_status_events_platform_write ON public.bankgiro_provider_status_events;
DROP POLICY bankgiro_provider_status_events_select ON public.bankgiro_provider_status_events;
CREATE POLICY bankgiro_provider_status_events_select ON public.bankgiro_provider_status_events AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((is_platform_admin()) OR (user_can_access_company_v2(company_id)));
CREATE POLICY bankgiro_provider_status_events_insert ON public.bankgiro_provider_status_events AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY bankgiro_provider_status_events_update ON public.bankgiro_provider_status_events AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY bankgiro_provider_status_events_delete ON public.bankgiro_provider_status_events AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- billing_checkout_sessions: billing_checkout_sessions_platform_write (ALL), billing_checkout_sessions_select (SELECT)
DROP POLICY billing_checkout_sessions_platform_write ON public.billing_checkout_sessions;
DROP POLICY billing_checkout_sessions_select ON public.billing_checkout_sessions;
CREATE POLICY billing_checkout_sessions_select ON public.billing_checkout_sessions AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((is_platform_admin()) OR (user_can_manage_company_billing(company_id)));
CREATE POLICY billing_checkout_sessions_insert ON public.billing_checkout_sessions AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY billing_checkout_sessions_update ON public.billing_checkout_sessions AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY billing_checkout_sessions_delete ON public.billing_checkout_sessions AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- billing_events: billing_events_platform_write (ALL), billing_events_select (SELECT)
DROP POLICY billing_events_platform_write ON public.billing_events;
DROP POLICY billing_events_select ON public.billing_events;
CREATE POLICY billing_events_select ON public.billing_events AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((is_platform_admin()) OR (user_can_access_company_v2(company_id)));
CREATE POLICY billing_events_insert ON public.billing_events AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY billing_events_update ON public.billing_events AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY billing_events_delete ON public.billing_events AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- bookkeeping_automation_rules: bookkeeping_automation_rules_select (SELECT), bookkeeping_automation_rules_write (ALL)
DROP POLICY bookkeeping_automation_rules_select ON public.bookkeeping_automation_rules;
DROP POLICY bookkeeping_automation_rules_write ON public.bookkeeping_automation_rules;
CREATE POLICY bookkeeping_automation_rules_select ON public.bookkeeping_automation_rules AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((user_can_access_company_v2(company_id)) OR (user_can_write_company(company_id)));
CREATE POLICY bookkeeping_automation_rules_insert ON public.bookkeeping_automation_rules AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (user_can_write_company(company_id));
CREATE POLICY bookkeeping_automation_rules_update ON public.bookkeeping_automation_rules AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));
CREATE POLICY bookkeeping_automation_rules_delete ON public.bookkeeping_automation_rules AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (user_can_write_company(company_id));

-- commercial_access_grant_features: commercial_access_grant_features_platform_write (ALL), commercial_access_grant_features_select (SELECT)
DROP POLICY commercial_access_grant_features_platform_write ON public.commercial_access_grant_features;
DROP POLICY commercial_access_grant_features_select ON public.commercial_access_grant_features;
CREATE POLICY commercial_access_grant_features_select ON public.commercial_access_grant_features AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((is_platform_admin()) OR ((EXISTS ( SELECT 1
   FROM commercial_access_grants cag
  WHERE ((cag.id = commercial_access_grant_features.grant_id) AND user_can_access_company_v2(cag.company_id))))));
CREATE POLICY commercial_access_grant_features_insert ON public.commercial_access_grant_features AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY commercial_access_grant_features_update ON public.commercial_access_grant_features AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY commercial_access_grant_features_delete ON public.commercial_access_grant_features AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- commercial_access_grants: commercial_access_grants_platform_write (ALL), commercial_access_grants_select (SELECT)
DROP POLICY commercial_access_grants_platform_write ON public.commercial_access_grants;
DROP POLICY commercial_access_grants_select ON public.commercial_access_grants;
CREATE POLICY commercial_access_grants_select ON public.commercial_access_grants AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((is_platform_admin()) OR (user_can_access_company_v2(company_id)));
CREATE POLICY commercial_access_grants_insert ON public.commercial_access_grants AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY commercial_access_grants_update ON public.commercial_access_grants AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY commercial_access_grants_delete ON public.commercial_access_grants AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- company_billing_profiles: company_billing_profiles_platform_write (ALL), company_billing_profiles_select (SELECT)
DROP POLICY company_billing_profiles_platform_write ON public.company_billing_profiles;
DROP POLICY company_billing_profiles_select ON public.company_billing_profiles;
CREATE POLICY company_billing_profiles_select ON public.company_billing_profiles AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((is_platform_admin()) OR (user_can_manage_company_billing(company_id)));
CREATE POLICY company_billing_profiles_insert ON public.company_billing_profiles AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY company_billing_profiles_update ON public.company_billing_profiles AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY company_billing_profiles_delete ON public.company_billing_profiles AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- company_entitlements: company_entitlements_platform_write (ALL), company_entitlements_select (SELECT)
DROP POLICY company_entitlements_platform_write ON public.company_entitlements;
DROP POLICY company_entitlements_select ON public.company_entitlements;
CREATE POLICY company_entitlements_select ON public.company_entitlements AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((is_platform_admin()) OR (user_can_access_company_v2(company_id)));
CREATE POLICY company_entitlements_insert ON public.company_entitlements AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY company_entitlements_update ON public.company_entitlements AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY company_entitlements_delete ON public.company_entitlements AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- company_subscription_change_requests: company_subscription_change_requests_customer_insert (INSERT), company_subscription_change_requests_platform_write (ALL), company_subscription_change_requests_select (SELECT)
DROP POLICY company_subscription_change_requests_customer_insert ON public.company_subscription_change_requests;
DROP POLICY company_subscription_change_requests_platform_write ON public.company_subscription_change_requests;
DROP POLICY company_subscription_change_requests_select ON public.company_subscription_change_requests;
CREATE POLICY company_subscription_change_requests_select ON public.company_subscription_change_requests AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((is_platform_admin()) OR (user_can_manage_company_billing(company_id)));
CREATE POLICY company_subscription_change_requests_insert ON public.company_subscription_change_requests AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (((user_can_manage_company_billing(company_id) AND (requested_by = ( SELECT auth.uid() AS uid)))) OR (is_platform_admin()));
CREATE POLICY company_subscription_change_requests_update ON public.company_subscription_change_requests AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY company_subscription_change_requests_delete ON public.company_subscription_change_requests AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- company_subscription_items: company_subscription_items_platform_write (ALL), company_subscription_items_select (SELECT)
DROP POLICY company_subscription_items_platform_write ON public.company_subscription_items;
DROP POLICY company_subscription_items_select ON public.company_subscription_items;
CREATE POLICY company_subscription_items_select ON public.company_subscription_items AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((is_platform_admin()) OR (user_can_access_company_v2(company_id)));
CREATE POLICY company_subscription_items_insert ON public.company_subscription_items AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY company_subscription_items_update ON public.company_subscription_items AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY company_subscription_items_delete ON public.company_subscription_items AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- company_subscriptions: company_subscriptions_platform_write (ALL), company_subscriptions_select (SELECT)
DROP POLICY company_subscriptions_platform_write ON public.company_subscriptions;
DROP POLICY company_subscriptions_select ON public.company_subscriptions;
CREATE POLICY company_subscriptions_select ON public.company_subscriptions AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((is_platform_admin()) OR (user_can_access_company_v2(company_id)));
CREATE POLICY company_subscriptions_insert ON public.company_subscriptions AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY company_subscriptions_update ON public.company_subscriptions AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY company_subscriptions_delete ON public.company_subscriptions AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- document_ocr_runs: document_ocr_runs_select (SELECT), document_ocr_runs_service_write (ALL)
DROP POLICY document_ocr_runs_select ON public.document_ocr_runs;
DROP POLICY document_ocr_runs_service_write ON public.document_ocr_runs;
CREATE POLICY document_ocr_runs_select ON public.document_ocr_runs AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (((is_platform_admin() OR (EXISTS ( SELECT 1
   FROM company_members cm
  WHERE ((cm.company_id = document_ocr_runs.company_id) AND (cm.user_id = ( SELECT auth.uid() AS uid))))))) OR (is_platform_admin()));
CREATE POLICY document_ocr_runs_insert ON public.document_ocr_runs AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY document_ocr_runs_update ON public.document_ocr_runs AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY document_ocr_runs_delete ON public.document_ocr_runs AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- email_templates: email_templates_admin_write (ALL), email_templates_authenticated_read (SELECT)
DROP POLICY email_templates_admin_write ON public.email_templates;
DROP POLICY email_templates_authenticated_read ON public.email_templates;
CREATE POLICY email_templates_select ON public.email_templates AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((is_platform_admin()) OR (((( SELECT auth.uid() AS uid) IS NOT NULL) OR (status = 'active'::text))));
CREATE POLICY email_templates_insert ON public.email_templates AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY email_templates_update ON public.email_templates AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY email_templates_delete ON public.email_templates AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- onboarding_choices: onboarding_choices_select (SELECT), onboarding_choices_session_access (ALL), onboarding_choices_write (ALL)
DROP POLICY onboarding_choices_select ON public.onboarding_choices;
DROP POLICY onboarding_choices_session_access ON public.onboarding_choices;
DROP POLICY onboarding_choices_write ON public.onboarding_choices;
CREATE POLICY onboarding_choices_select ON public.onboarding_choices AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((user_can_access_company_v2(company_id)) OR ((EXISTS ( SELECT 1
   FROM onboarding_sessions os
  WHERE ((os.id = onboarding_choices.session_id) AND (((os.company_id IS NULL) AND (os.user_id = ( SELECT auth.uid() AS uid))) OR ((os.company_id IS NOT NULL) AND user_can_write_company(os.company_id))))))) OR (user_can_write_company(company_id)));
CREATE POLICY onboarding_choices_insert ON public.onboarding_choices AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (((EXISTS ( SELECT 1
   FROM onboarding_sessions os
  WHERE ((os.id = onboarding_choices.session_id) AND (((os.company_id IS NULL) AND (os.user_id = ( SELECT auth.uid() AS uid))) OR ((os.company_id IS NOT NULL) AND user_can_write_company(os.company_id))))))) OR (user_can_write_company(company_id)));
CREATE POLICY onboarding_choices_update ON public.onboarding_choices AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (((EXISTS ( SELECT 1
   FROM onboarding_sessions os
  WHERE ((os.id = onboarding_choices.session_id) AND (((os.company_id IS NULL) AND (os.user_id = ( SELECT auth.uid() AS uid))) OR ((os.company_id IS NOT NULL) AND user_can_write_company(os.company_id))))))) OR (user_can_write_company(company_id)))
  WITH CHECK (((EXISTS ( SELECT 1
   FROM onboarding_sessions os
  WHERE ((os.id = onboarding_choices.session_id) AND (((os.company_id IS NULL) AND (os.user_id = ( SELECT auth.uid() AS uid))) OR ((os.company_id IS NOT NULL) AND user_can_write_company(os.company_id))))))) OR (user_can_write_company(company_id)));
CREATE POLICY onboarding_choices_delete ON public.onboarding_choices AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (((EXISTS ( SELECT 1
   FROM onboarding_sessions os
  WHERE ((os.id = onboarding_choices.session_id) AND (((os.company_id IS NULL) AND (os.user_id = ( SELECT auth.uid() AS uid))) OR ((os.company_id IS NOT NULL) AND user_can_write_company(os.company_id))))))) OR (user_can_write_company(company_id)));

-- onboarding_sessions: onboarding_sessions_company_select (SELECT), onboarding_sessions_company_write (ALL), onboarding_sessions_select (SELECT), onboarding_sessions_user_without_company (ALL), onboarding_sessions_write (ALL)
DROP POLICY onboarding_sessions_company_select ON public.onboarding_sessions;
DROP POLICY onboarding_sessions_company_write ON public.onboarding_sessions;
DROP POLICY onboarding_sessions_select ON public.onboarding_sessions;
DROP POLICY onboarding_sessions_user_without_company ON public.onboarding_sessions;
DROP POLICY onboarding_sessions_write ON public.onboarding_sessions;
CREATE POLICY onboarding_sessions_select ON public.onboarding_sessions AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((((company_id IS NOT NULL) AND user_can_access_company_v2(company_id))) OR (((company_id IS NOT NULL) AND user_can_write_company(company_id))) OR (user_can_access_company_v2(company_id)) OR (((company_id IS NULL) AND (user_id = ( SELECT auth.uid() AS uid)))) OR (user_can_write_company(company_id)));
CREATE POLICY onboarding_sessions_insert ON public.onboarding_sessions AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK ((((company_id IS NOT NULL) AND user_can_write_company(company_id))) OR (((company_id IS NULL) AND (user_id = ( SELECT auth.uid() AS uid)))) OR (user_can_write_company(company_id)));
CREATE POLICY onboarding_sessions_update ON public.onboarding_sessions AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING ((((company_id IS NOT NULL) AND user_can_write_company(company_id))) OR (((company_id IS NULL) AND (user_id = ( SELECT auth.uid() AS uid)))) OR (user_can_write_company(company_id)))
  WITH CHECK ((((company_id IS NOT NULL) AND user_can_write_company(company_id))) OR (((company_id IS NULL) AND (user_id = ( SELECT auth.uid() AS uid)))) OR (user_can_write_company(company_id)));
CREATE POLICY onboarding_sessions_delete ON public.onboarding_sessions AS PERMISSIVE FOR DELETE TO PUBLIC
  USING ((((company_id IS NOT NULL) AND user_can_write_company(company_id))) OR (((company_id IS NULL) AND (user_id = ( SELECT auth.uid() AS uid)))) OR (user_can_write_company(company_id)));

-- onboarding_steps: onboarding_steps_select (SELECT), onboarding_steps_session_access (ALL), onboarding_steps_write (ALL)
DROP POLICY onboarding_steps_select ON public.onboarding_steps;
DROP POLICY onboarding_steps_session_access ON public.onboarding_steps;
DROP POLICY onboarding_steps_write ON public.onboarding_steps;
CREATE POLICY onboarding_steps_select ON public.onboarding_steps AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((user_can_access_company_v2(company_id)) OR ((EXISTS ( SELECT 1
   FROM onboarding_sessions os
  WHERE ((os.id = onboarding_steps.session_id) AND (((os.company_id IS NULL) AND (os.user_id = ( SELECT auth.uid() AS uid))) OR ((os.company_id IS NOT NULL) AND user_can_write_company(os.company_id))))))) OR (user_can_write_company(company_id)));
CREATE POLICY onboarding_steps_insert ON public.onboarding_steps AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (((EXISTS ( SELECT 1
   FROM onboarding_sessions os
  WHERE ((os.id = onboarding_steps.session_id) AND (((os.company_id IS NULL) AND (os.user_id = ( SELECT auth.uid() AS uid))) OR ((os.company_id IS NOT NULL) AND user_can_write_company(os.company_id))))))) OR (user_can_write_company(company_id)));
CREATE POLICY onboarding_steps_update ON public.onboarding_steps AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (((EXISTS ( SELECT 1
   FROM onboarding_sessions os
  WHERE ((os.id = onboarding_steps.session_id) AND (((os.company_id IS NULL) AND (os.user_id = ( SELECT auth.uid() AS uid))) OR ((os.company_id IS NOT NULL) AND user_can_write_company(os.company_id))))))) OR (user_can_write_company(company_id)))
  WITH CHECK (((EXISTS ( SELECT 1
   FROM onboarding_sessions os
  WHERE ((os.id = onboarding_steps.session_id) AND (((os.company_id IS NULL) AND (os.user_id = ( SELECT auth.uid() AS uid))) OR ((os.company_id IS NOT NULL) AND user_can_write_company(os.company_id))))))) OR (user_can_write_company(company_id)));
CREATE POLICY onboarding_steps_delete ON public.onboarding_steps AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (((EXISTS ( SELECT 1
   FROM onboarding_sessions os
  WHERE ((os.id = onboarding_steps.session_id) AND (((os.company_id IS NULL) AND (os.user_id = ( SELECT auth.uid() AS uid))) OR ((os.company_id IS NOT NULL) AND user_can_write_company(os.company_id))))))) OR (user_can_write_company(company_id)));

-- one_time_purchases: one_time_purchases_platform_write (ALL), one_time_purchases_select (SELECT)
DROP POLICY one_time_purchases_platform_write ON public.one_time_purchases;
DROP POLICY one_time_purchases_select ON public.one_time_purchases;
CREATE POLICY one_time_purchases_select ON public.one_time_purchases AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((is_platform_admin()) OR (user_can_access_company_v2(company_id)));
CREATE POLICY one_time_purchases_insert ON public.one_time_purchases AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY one_time_purchases_update ON public.one_time_purchases AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY one_time_purchases_delete ON public.one_time_purchases AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- payment_collection_events: payment_collection_events_platform_write (ALL), payment_collection_events_select (SELECT)
DROP POLICY payment_collection_events_platform_write ON public.payment_collection_events;
DROP POLICY payment_collection_events_select ON public.payment_collection_events;
CREATE POLICY payment_collection_events_select ON public.payment_collection_events AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((is_platform_admin()) OR ((user_can_access_company_v2(company_id) OR is_platform_admin())));
CREATE POLICY payment_collection_events_insert ON public.payment_collection_events AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY payment_collection_events_update ON public.payment_collection_events AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY payment_collection_events_delete ON public.payment_collection_events AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- payment_collections: payment_collections_platform_write (ALL), payment_collections_select (SELECT)
DROP POLICY payment_collections_platform_write ON public.payment_collections;
DROP POLICY payment_collections_select ON public.payment_collections;
CREATE POLICY payment_collections_select ON public.payment_collections AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((is_platform_admin()) OR (user_can_access_company_v2(company_id)));
CREATE POLICY payment_collections_insert ON public.payment_collections AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY payment_collections_update ON public.payment_collections AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY payment_collections_delete ON public.payment_collections AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- payment_mandates: payment_mandates_platform_write (ALL), payment_mandates_select (SELECT)
DROP POLICY payment_mandates_platform_write ON public.payment_mandates;
DROP POLICY payment_mandates_select ON public.payment_mandates;
CREATE POLICY payment_mandates_select ON public.payment_mandates AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((is_platform_admin()) OR (user_can_access_company_v2(company_id)));
CREATE POLICY payment_mandates_insert ON public.payment_mandates AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY payment_mandates_update ON public.payment_mandates AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY payment_mandates_delete ON public.payment_mandates AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- payment_provider_accounts: payment_provider_accounts_platform_write (ALL), payment_provider_accounts_select (SELECT)
DROP POLICY payment_provider_accounts_platform_write ON public.payment_provider_accounts;
DROP POLICY payment_provider_accounts_select ON public.payment_provider_accounts;
CREATE POLICY payment_provider_accounts_select ON public.payment_provider_accounts AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((is_platform_admin()) OR ((user_can_access_company_v2(company_id) OR is_platform_admin())));
CREATE POLICY payment_provider_accounts_insert ON public.payment_provider_accounts AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY payment_provider_accounts_update ON public.payment_provider_accounts AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY payment_provider_accounts_delete ON public.payment_provider_accounts AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- payment_providers: payment_providers_admin_write (ALL), payment_providers_select (SELECT)
DROP POLICY payment_providers_admin_write ON public.payment_providers;
DROP POLICY payment_providers_select ON public.payment_providers;
CREATE POLICY payment_providers_select ON public.payment_providers AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((is_platform_admin()) OR ((( SELECT auth.uid() AS uid) IS NOT NULL)));
CREATE POLICY payment_providers_insert ON public.payment_providers AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY payment_providers_update ON public.payment_providers AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY payment_providers_delete ON public.payment_providers AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- payment_reconciliation_items: payment_reconciliation_items_platform_write (ALL), payment_reconciliation_items_select (SELECT)
DROP POLICY payment_reconciliation_items_platform_write ON public.payment_reconciliation_items;
DROP POLICY payment_reconciliation_items_select ON public.payment_reconciliation_items;
CREATE POLICY payment_reconciliation_items_select ON public.payment_reconciliation_items AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((is_platform_admin()) OR (user_can_access_company_v2(company_id)));
CREATE POLICY payment_reconciliation_items_insert ON public.payment_reconciliation_items AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY payment_reconciliation_items_update ON public.payment_reconciliation_items AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY payment_reconciliation_items_delete ON public.payment_reconciliation_items AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- pending_operations: pending_operations_automation_insert (INSERT), pending_operations_chat_insert (INSERT), pending_operations_select (SELECT), pending_operations_update (UPDATE)
DROP POLICY pending_operations_automation_insert ON public.pending_operations;
DROP POLICY pending_operations_chat_insert ON public.pending_operations;
DROP POLICY pending_operations_select ON public.pending_operations;
DROP POLICY pending_operations_update ON public.pending_operations;
CREATE POLICY pending_operations_select ON public.pending_operations AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((company_id IN ( SELECT user_company_ids() AS user_company_ids)));
CREATE POLICY pending_operations_insert ON public.pending_operations AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK ((((actor_type = 'automation'::text) AND (( SELECT auth.uid() AS uid) = user_id) AND user_can_write_company(company_id))) OR (((actor_type = 'agent_chat'::text) AND (( SELECT auth.uid() AS uid) = user_id) AND user_can_write_company(company_id))));
CREATE POLICY pending_operations_update ON public.pending_operations AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));

-- platform_features: platform_features_admin_write (ALL), platform_features_select (SELECT)
DROP POLICY platform_features_admin_write ON public.platform_features;
DROP POLICY platform_features_select ON public.platform_features;
CREATE POLICY platform_features_select ON public.platform_features AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((is_platform_admin()) OR ((( SELECT auth.uid() AS uid) IS NOT NULL)));
CREATE POLICY platform_features_insert ON public.platform_features AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY platform_features_update ON public.platform_features AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY platform_features_delete ON public.platform_features AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- platform_plan_features: platform_plan_features_admin_write (ALL), platform_plan_features_select (SELECT)
DROP POLICY platform_plan_features_admin_write ON public.platform_plan_features;
DROP POLICY platform_plan_features_select ON public.platform_plan_features;
CREATE POLICY platform_plan_features_select ON public.platform_plan_features AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((is_platform_admin()) OR ((( SELECT auth.uid() AS uid) IS NOT NULL)));
CREATE POLICY platform_plan_features_insert ON public.platform_plan_features AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY platform_plan_features_update ON public.platform_plan_features AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY platform_plan_features_delete ON public.platform_plan_features AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- platform_plan_version_features: platform_plan_version_features_admin_write (ALL), platform_plan_version_features_select (SELECT)
DROP POLICY platform_plan_version_features_admin_write ON public.platform_plan_version_features;
DROP POLICY platform_plan_version_features_select ON public.platform_plan_version_features;
CREATE POLICY platform_plan_version_features_select ON public.platform_plan_version_features AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((is_platform_admin()) OR ((is_platform_admin() OR (EXISTS ( SELECT 1
   FROM platform_plan_versions pv
  WHERE ((pv.id = platform_plan_version_features.plan_version_id) AND (pv.status <> 'draft'::text)))))));
CREATE POLICY platform_plan_version_features_insert ON public.platform_plan_version_features AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY platform_plan_version_features_update ON public.platform_plan_version_features AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY platform_plan_version_features_delete ON public.platform_plan_version_features AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- platform_plan_versions: platform_plan_versions_admin_write (ALL), platform_plan_versions_select (SELECT)
DROP POLICY platform_plan_versions_admin_write ON public.platform_plan_versions;
DROP POLICY platform_plan_versions_select ON public.platform_plan_versions;
CREATE POLICY platform_plan_versions_select ON public.platform_plan_versions AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((is_platform_admin()) OR (((status <> 'draft'::text) OR is_platform_admin())));
CREATE POLICY platform_plan_versions_insert ON public.platform_plan_versions AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY platform_plan_versions_update ON public.platform_plan_versions AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY platform_plan_versions_delete ON public.platform_plan_versions AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- platform_price_plans: platform_price_plans_admin_write (ALL), platform_price_plans_select (SELECT)
DROP POLICY platform_price_plans_admin_write ON public.platform_price_plans;
DROP POLICY platform_price_plans_select ON public.platform_price_plans;
CREATE POLICY platform_price_plans_select ON public.platform_price_plans AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((is_platform_admin()) OR ((( SELECT auth.uid() AS uid) IS NOT NULL)));
CREATE POLICY platform_price_plans_insert ON public.platform_price_plans AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY platform_price_plans_update ON public.platform_price_plans AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY platform_price_plans_delete ON public.platform_price_plans AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- platform_products: platform_products_admin_write (ALL), platform_products_select (SELECT)
DROP POLICY platform_products_admin_write ON public.platform_products;
DROP POLICY platform_products_select ON public.platform_products;
CREATE POLICY platform_products_select ON public.platform_products AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((is_platform_admin()) OR ((( SELECT auth.uid() AS uid) IS NOT NULL)));
CREATE POLICY platform_products_insert ON public.platform_products AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY platform_products_update ON public.platform_products AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY platform_products_delete ON public.platform_products AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- platform_roles: platform_roles_admin_write (ALL), platform_roles_select (SELECT)
DROP POLICY platform_roles_admin_write ON public.platform_roles;
DROP POLICY platform_roles_select ON public.platform_roles;
CREATE POLICY platform_roles_select ON public.platform_roles AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((is_platform_admin()) OR (((user_id = ( SELECT auth.uid() AS uid)) OR is_platform_admin())));
CREATE POLICY platform_roles_insert ON public.platform_roles AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY platform_roles_update ON public.platform_roles AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY platform_roles_delete ON public.platform_roles AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- review_queue_items: review_queue_items_select (SELECT), review_queue_items_write (ALL)
DROP POLICY review_queue_items_select ON public.review_queue_items;
DROP POLICY review_queue_items_write ON public.review_queue_items;
CREATE POLICY review_queue_items_select ON public.review_queue_items AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((user_can_access_company_v2(company_id)) OR (user_can_write_company(company_id)));
CREATE POLICY review_queue_items_insert ON public.review_queue_items AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (user_can_write_company(company_id));
CREATE POLICY review_queue_items_update ON public.review_queue_items AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));
CREATE POLICY review_queue_items_delete ON public.review_queue_items AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (user_can_write_company(company_id));

-- skatteverket_deadlines: skatteverket_deadlines_select (SELECT), skatteverket_deadlines_write (ALL)
DROP POLICY skatteverket_deadlines_select ON public.skatteverket_deadlines;
DROP POLICY skatteverket_deadlines_write ON public.skatteverket_deadlines;
CREATE POLICY skatteverket_deadlines_select ON public.skatteverket_deadlines AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (((user_can_access_company_v2(company_id) OR is_platform_admin())) OR ((user_can_write_company(company_id) OR is_platform_admin())));
CREATE POLICY skatteverket_deadlines_insert ON public.skatteverket_deadlines AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK ((user_can_write_company(company_id) OR is_platform_admin()));
CREATE POLICY skatteverket_deadlines_update ON public.skatteverket_deadlines AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING ((user_can_write_company(company_id) OR is_platform_admin()))
  WITH CHECK ((user_can_write_company(company_id) OR is_platform_admin()));
CREATE POLICY skatteverket_deadlines_delete ON public.skatteverket_deadlines AS PERMISSIVE FOR DELETE TO PUBLIC
  USING ((user_can_write_company(company_id) OR is_platform_admin()));

-- skatteverket_service_catalog: skatteverket_service_catalog_admin (ALL), skatteverket_service_catalog_read (SELECT)
DROP POLICY skatteverket_service_catalog_admin ON public.skatteverket_service_catalog;
DROP POLICY skatteverket_service_catalog_read ON public.skatteverket_service_catalog;
CREATE POLICY skatteverket_service_catalog_select ON public.skatteverket_service_catalog AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((is_platform_admin()) OR (((( SELECT auth.role() AS role) = 'authenticated'::text) OR is_platform_admin())));
CREATE POLICY skatteverket_service_catalog_insert ON public.skatteverket_service_catalog AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY skatteverket_service_catalog_update ON public.skatteverket_service_catalog AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY skatteverket_service_catalog_delete ON public.skatteverket_service_catalog AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- stripe_invoice_records: stripe_invoice_records_platform_write (ALL), stripe_invoice_records_select (SELECT)
DROP POLICY stripe_invoice_records_platform_write ON public.stripe_invoice_records;
DROP POLICY stripe_invoice_records_select ON public.stripe_invoice_records;
CREATE POLICY stripe_invoice_records_select ON public.stripe_invoice_records AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((is_platform_admin()) OR (user_can_manage_company_billing(company_id)));
CREATE POLICY stripe_invoice_records_insert ON public.stripe_invoice_records AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY stripe_invoice_records_update ON public.stripe_invoice_records AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY stripe_invoice_records_delete ON public.stripe_invoice_records AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- stripe_webhook_events: stripe_webhook_events_platform_select (SELECT), stripe_webhook_events_platform_write (ALL)
DROP POLICY stripe_webhook_events_platform_select ON public.stripe_webhook_events;
DROP POLICY stripe_webhook_events_platform_write ON public.stripe_webhook_events;
CREATE POLICY stripe_webhook_events_select ON public.stripe_webhook_events AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (is_platform_admin());
CREATE POLICY stripe_webhook_events_insert ON public.stripe_webhook_events AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY stripe_webhook_events_update ON public.stripe_webhook_events AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY stripe_webhook_events_delete ON public.stripe_webhook_events AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- tax_codes: tax_codes_select (SELECT), tax_codes_write (ALL)
DROP POLICY tax_codes_select ON public.tax_codes;
DROP POLICY tax_codes_write ON public.tax_codes;
CREATE POLICY tax_codes_select ON public.tax_codes AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((((company_id IS NULL) OR user_can_access_company_v2(company_id) OR is_platform_admin())) OR (((company_id IS NOT NULL) AND (user_can_write_company(company_id) OR is_platform_admin()))));
CREATE POLICY tax_codes_insert ON public.tax_codes AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (((company_id IS NOT NULL) AND (user_can_write_company(company_id) OR is_platform_admin())));
CREATE POLICY tax_codes_update ON public.tax_codes AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (((company_id IS NOT NULL) AND (user_can_write_company(company_id) OR is_platform_admin())))
  WITH CHECK (((company_id IS NOT NULL) AND (user_can_write_company(company_id) OR is_platform_admin())));
CREATE POLICY tax_codes_delete ON public.tax_codes AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (((company_id IS NOT NULL) AND (user_can_write_company(company_id) OR is_platform_admin())));

-- tax_submission_events: tax_submission_events_select (SELECT), tax_submission_events_write (ALL)
DROP POLICY tax_submission_events_select ON public.tax_submission_events;
DROP POLICY tax_submission_events_write ON public.tax_submission_events;
CREATE POLICY tax_submission_events_select ON public.tax_submission_events AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (((user_can_access_company_v2(company_id) OR is_platform_admin())) OR ((user_can_write_company(company_id) OR is_platform_admin())));
CREATE POLICY tax_submission_events_insert ON public.tax_submission_events AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK ((user_can_write_company(company_id) OR is_platform_admin()));
CREATE POLICY tax_submission_events_update ON public.tax_submission_events AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING ((user_can_write_company(company_id) OR is_platform_admin()))
  WITH CHECK ((user_can_write_company(company_id) OR is_platform_admin()));
CREATE POLICY tax_submission_events_delete ON public.tax_submission_events AS PERMISSIVE FOR DELETE TO PUBLIC
  USING ((user_can_write_company(company_id) OR is_platform_admin()));

-- tax_submissions: tax_submissions_select (SELECT), tax_submissions_write (ALL)
DROP POLICY tax_submissions_select ON public.tax_submissions;
DROP POLICY tax_submissions_write ON public.tax_submissions;
CREATE POLICY tax_submissions_select ON public.tax_submissions AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (((user_can_access_company_v2(company_id) OR is_platform_admin())) OR ((user_can_write_company(company_id) OR is_platform_admin())));
CREATE POLICY tax_submissions_insert ON public.tax_submissions AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK ((user_can_write_company(company_id) OR is_platform_admin()));
CREATE POLICY tax_submissions_update ON public.tax_submissions AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING ((user_can_write_company(company_id) OR is_platform_admin()))
  WITH CHECK ((user_can_write_company(company_id) OR is_platform_admin()));
CREATE POLICY tax_submissions_delete ON public.tax_submissions AS PERMISSIVE FOR DELETE TO PUBLIC
  USING ((user_can_write_company(company_id) OR is_platform_admin()));

-- transaction_match_candidates: transaction_match_candidates_select (SELECT), transaction_match_candidates_write (ALL)
DROP POLICY transaction_match_candidates_select ON public.transaction_match_candidates;
DROP POLICY transaction_match_candidates_write ON public.transaction_match_candidates;
CREATE POLICY transaction_match_candidates_select ON public.transaction_match_candidates AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((user_can_access_company_v2(company_id)) OR (user_can_write_company(company_id)));
CREATE POLICY transaction_match_candidates_insert ON public.transaction_match_candidates AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (user_can_write_company(company_id));
CREATE POLICY transaction_match_candidates_update ON public.transaction_match_candidates AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));
CREATE POLICY transaction_match_candidates_delete ON public.transaction_match_candidates AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (user_can_write_company(company_id));

-- usage_metering: usage_metering_platform_write (ALL), usage_metering_select (SELECT)
DROP POLICY usage_metering_platform_write ON public.usage_metering;
DROP POLICY usage_metering_select ON public.usage_metering;
CREATE POLICY usage_metering_select ON public.usage_metering AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((is_platform_admin()) OR (user_can_access_company_v2(company_id)));
CREATE POLICY usage_metering_insert ON public.usage_metering AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY usage_metering_update ON public.usage_metering AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY usage_metering_delete ON public.usage_metering AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- webhook_deliveries: webhook_deliveries_select (SELECT), webhook_deliveries_write (ALL)
DROP POLICY webhook_deliveries_select ON public.webhook_deliveries;
DROP POLICY webhook_deliveries_write ON public.webhook_deliveries;
CREATE POLICY webhook_deliveries_select ON public.webhook_deliveries AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((user_can_access_company_v2(company_id)) OR (user_can_write_company(company_id)));
CREATE POLICY webhook_deliveries_insert ON public.webhook_deliveries AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (user_can_write_company(company_id));
CREATE POLICY webhook_deliveries_update ON public.webhook_deliveries AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));
CREATE POLICY webhook_deliveries_delete ON public.webhook_deliveries AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (user_can_write_company(company_id));

-- webhook_endpoints: webhook_endpoints_select (SELECT), webhook_endpoints_write (ALL)
DROP POLICY webhook_endpoints_select ON public.webhook_endpoints;
DROP POLICY webhook_endpoints_write ON public.webhook_endpoints;
CREATE POLICY webhook_endpoints_select ON public.webhook_endpoints AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((user_can_access_company_v2(company_id)) OR (user_can_write_company(company_id)));
CREATE POLICY webhook_endpoints_insert ON public.webhook_endpoints AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (user_can_write_company(company_id));
CREATE POLICY webhook_endpoints_update ON public.webhook_endpoints AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));
CREATE POLICY webhook_endpoints_delete ON public.webhook_endpoints AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (user_can_write_company(company_id));

-- webhook_events: webhook_events_admin (ALL), webhook_events_read (SELECT)
DROP POLICY webhook_events_admin ON public.webhook_events;
DROP POLICY webhook_events_read ON public.webhook_events;
CREATE POLICY webhook_events_select ON public.webhook_events AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((is_platform_admin()) OR (((( SELECT auth.role() AS role) = 'authenticated'::text) OR is_platform_admin())));
CREATE POLICY webhook_events_insert ON public.webhook_events AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY webhook_events_update ON public.webhook_events AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY webhook_events_delete ON public.webhook_events AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- year_end_adjustments: year_end_adjustments_select (SELECT), year_end_adjustments_write (ALL)
DROP POLICY year_end_adjustments_select ON public.year_end_adjustments;
DROP POLICY year_end_adjustments_write ON public.year_end_adjustments;
CREATE POLICY year_end_adjustments_select ON public.year_end_adjustments AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((user_can_access_company_v2(company_id)) OR (user_can_write_company(company_id)));
CREATE POLICY year_end_adjustments_insert ON public.year_end_adjustments AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (user_can_write_company(company_id));
CREATE POLICY year_end_adjustments_update ON public.year_end_adjustments AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));
CREATE POLICY year_end_adjustments_delete ON public.year_end_adjustments AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (user_can_write_company(company_id));

-- year_end_checks: year_end_checks_select (SELECT), year_end_checks_write (ALL)
DROP POLICY year_end_checks_select ON public.year_end_checks;
DROP POLICY year_end_checks_write ON public.year_end_checks;
CREATE POLICY year_end_checks_select ON public.year_end_checks AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((user_can_access_company_v2(company_id)) OR (user_can_write_company(company_id)));
CREATE POLICY year_end_checks_insert ON public.year_end_checks AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (user_can_write_company(company_id));
CREATE POLICY year_end_checks_update ON public.year_end_checks AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));
CREATE POLICY year_end_checks_delete ON public.year_end_checks AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (user_can_write_company(company_id));

-- year_end_deliverables: year_end_deliverables_select (SELECT), year_end_deliverables_write (ALL)
DROP POLICY year_end_deliverables_select ON public.year_end_deliverables;
DROP POLICY year_end_deliverables_write ON public.year_end_deliverables;
CREATE POLICY year_end_deliverables_select ON public.year_end_deliverables AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((user_can_access_company_v2(company_id)) OR (user_can_write_company(company_id)));
CREATE POLICY year_end_deliverables_insert ON public.year_end_deliverables AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (user_can_write_company(company_id));
CREATE POLICY year_end_deliverables_update ON public.year_end_deliverables AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));
CREATE POLICY year_end_deliverables_delete ON public.year_end_deliverables AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (user_can_write_company(company_id));

-- year_end_projects: year_end_projects_select (SELECT), year_end_projects_write (ALL)
DROP POLICY year_end_projects_select ON public.year_end_projects;
DROP POLICY year_end_projects_write ON public.year_end_projects;
CREATE POLICY year_end_projects_select ON public.year_end_projects AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((user_can_access_company_v2(company_id)) OR (user_can_write_company(company_id)));
CREATE POLICY year_end_projects_insert ON public.year_end_projects AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (user_can_write_company(company_id));
CREATE POLICY year_end_projects_update ON public.year_end_projects AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));
CREATE POLICY year_end_projects_delete ON public.year_end_projects AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (user_can_write_company(company_id));

-- year_end_purchase_access: year_end_purchase_access_platform_write (ALL), year_end_purchase_access_select (SELECT)
DROP POLICY year_end_purchase_access_platform_write ON public.year_end_purchase_access;
DROP POLICY year_end_purchase_access_select ON public.year_end_purchase_access;
CREATE POLICY year_end_purchase_access_select ON public.year_end_purchase_access AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((is_platform_admin()) OR ((user_can_access_company_v2(company_id) OR is_platform_admin())));
CREATE POLICY year_end_purchase_access_insert ON public.year_end_purchase_access AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (is_platform_admin());
CREATE POLICY year_end_purchase_access_update ON public.year_end_purchase_access AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
CREATE POLICY year_end_purchase_access_delete ON public.year_end_purchase_access AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (is_platform_admin());

-- ---------------------------------------------------------------------------
-- Part 2: evaluate auth.* / current_setting() once per statement (initplan)
-- ---------------------------------------------------------------------------
ALTER POLICY agencies_insert ON public.agencies
  WITH CHECK ((is_platform_admin() OR (created_by = ( SELECT auth.uid() AS uid))));
ALTER POLICY agency_clients_select ON public.agency_clients
  USING ((is_platform_admin() OR user_is_agency_member(agency_id) OR (EXISTS ( SELECT 1
   FROM company_members cm
  WHERE ((cm.company_id = agency_clients.company_id) AND (cm.user_id = ( SELECT auth.uid() AS uid)) AND (cm.role = ANY (ARRAY['owner'::text, 'admin'::text])))))));
ALTER POLICY agent_conversations_delete ON public.agent_conversations
  USING (((company_id IN ( SELECT user_company_ids() AS user_company_ids)) AND (user_id = ( SELECT auth.uid() AS uid))));
ALTER POLICY agent_conversations_insert ON public.agent_conversations
  WITH CHECK (((company_id IN ( SELECT user_company_ids() AS user_company_ids)) AND (user_id = ( SELECT auth.uid() AS uid))));
ALTER POLICY agent_conversations_update ON public.agent_conversations
  USING (((company_id IN ( SELECT user_company_ids() AS user_company_ids)) AND (user_id = ( SELECT auth.uid() AS uid))))
  WITH CHECK (((company_id IN ( SELECT user_company_ids() AS user_company_ids)) AND (user_id = ( SELECT auth.uid() AS uid))));
ALTER POLICY agent_messages_insert ON public.agent_messages
  WITH CHECK ((EXISTS ( SELECT 1
   FROM agent_conversations ac
  WHERE ((ac.id = agent_messages.conversation_id) AND (ac.company_id IN ( SELECT user_company_ids() AS user_company_ids)) AND (ac.user_id = ( SELECT auth.uid() AS uid))))));
ALTER POLICY annual_report_projects_insert ON public.annual_report_projects
  WITH CHECK ((user_can_write_company(company_id) AND (status = 'draft'::text) AND (annual_report_locked = false) AND (preflight_status = 'not_run'::text) AND (blocking_issue_count = 0) AND (current_version_id IS NULL) AND (submission_blocked = true) AND (created_by = ( SELECT auth.uid() AS uid))));
ALTER POLICY auth_audit_events_own_read ON public.auth_audit_events
  USING (((user_id = ( SELECT auth.uid() AS uid)) OR is_platform_admin() OR ((company_id IS NOT NULL) AND user_can_access_company_v2(company_id))));
ALTER POLICY "Users read own enrichment" ON public.bankid_enrichment
  USING ((( SELECT auth.uid() AS uid) = user_id));
ALTER POLICY bankid_identities_delete ON public.bankid_identities
  USING ((( SELECT auth.uid() AS uid) = user_id));
ALTER POLICY bankid_identities_select ON public.bankid_identities
  USING ((( SELECT auth.uid() AS uid) = user_id));
ALTER POLICY bankid_sessions_insert ON public.bankid_sessions
  WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
ALTER POLICY bankid_sessions_select ON public.bankid_sessions
  USING ((user_id = ( SELECT auth.uid() AS uid)));
ALTER POLICY bankid_sessions_update ON public.bankid_sessions
  USING ((user_id = ( SELECT auth.uid() AS uid)));
ALTER POLICY bolagsverket_avtal_acceptances_insert ON public.bolagsverket_avtal_acceptances
  WITH CHECK ((user_can_access_company_v2(company_id) AND (user_id = ( SELECT auth.uid() AS uid))));
ALTER POLICY chat_messages_delete ON public.chat_messages
  USING (((company_id IN ( SELECT user_company_ids() AS user_company_ids)) AND (user_id = ( SELECT auth.uid() AS uid))));
ALTER POLICY chat_messages_insert ON public.chat_messages
  WITH CHECK (((company_id IN ( SELECT user_company_ids() AS user_company_ids)) AND (user_id = ( SELECT auth.uid() AS uid))));
ALTER POLICY chat_messages_update ON public.chat_messages
  USING (((company_id IN ( SELECT user_company_ids() AS user_company_ids)) AND (user_id = ( SELECT auth.uid() AS uid))));
ALTER POLICY chat_sessions_delete ON public.chat_sessions
  USING (((company_id IN ( SELECT user_company_ids() AS user_company_ids)) AND (user_id = ( SELECT auth.uid() AS uid))));
ALTER POLICY chat_sessions_insert ON public.chat_sessions
  WITH CHECK (((company_id IN ( SELECT user_company_ids() AS user_company_ids)) AND (user_id = ( SELECT auth.uid() AS uid))));
ALTER POLICY chat_sessions_update ON public.chat_sessions
  USING (((company_id IN ( SELECT user_company_ids() AS user_company_ids)) AND (user_id = ( SELECT auth.uid() AS uid))));
ALTER POLICY company_access_requests_insert ON public.company_access_requests
  WITH CHECK (((requester_user_id = ( SELECT auth.uid() AS uid)) OR is_platform_admin()));
ALTER POLICY company_access_requests_select ON public.company_access_requests
  USING (((requester_user_id = ( SELECT auth.uid() AS uid)) OR user_is_company_admin(company_id) OR is_platform_admin()));
ALTER POLICY company_authorization_attestations_select ON public.company_authorization_attestations
  USING (((user_id = ( SELECT auth.uid() AS uid)) OR user_is_company_admin(company_id) OR is_platform_admin()));
ALTER POLICY company_inboxes_insert ON public.company_inboxes
  WITH CHECK ((company_id IN ( SELECT cm.company_id
   FROM company_members cm
  WHERE ((cm.user_id = ( SELECT auth.uid() AS uid)) AND (cm.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));
ALTER POLICY company_inboxes_update ON public.company_inboxes
  USING ((company_id IN ( SELECT cm.company_id
   FROM company_members cm
  WHERE ((cm.user_id = ( SELECT auth.uid() AS uid)) AND (cm.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));
ALTER POLICY customer_account_credits_insert ON public.customer_account_credits
  WITH CHECK (((user_id = ( SELECT auth.uid() AS uid)) AND (company_id IN ( SELECT company_members.company_id
   FROM company_members
  WHERE (company_members.user_id = ( SELECT auth.uid() AS uid))))));
ALTER POLICY customer_account_credits_select ON public.customer_account_credits
  USING ((company_id IN ( SELECT company_members.company_id
   FROM company_members
  WHERE (company_members.user_id = ( SELECT auth.uid() AS uid)))));
ALTER POLICY customer_account_credits_update ON public.customer_account_credits
  USING ((company_id IN ( SELECT company_members.company_id
   FROM company_members
  WHERE (company_members.user_id = ( SELECT auth.uid() AS uid)))))
  WITH CHECK ((company_id IN ( SELECT company_members.company_id
   FROM company_members
  WHERE (company_members.user_id = ( SELECT auth.uid() AS uid)))));
ALTER POLICY extension_toggles_delete ON public.extension_toggles
  USING ((( SELECT auth.uid() AS uid) = user_id));
ALTER POLICY extension_toggles_insert ON public.extension_toggles
  WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
ALTER POLICY extension_toggles_select ON public.extension_toggles
  USING ((( SELECT auth.uid() AS uid) = user_id));
ALTER POLICY extension_toggles_update ON public.extension_toggles
  USING ((( SELECT auth.uid() AS uid) = user_id));
ALTER POLICY fiscal_period_reopen_requests_insert ON public.fiscal_period_reopen_requests
  WITH CHECK ((user_can_write_company(company_id) AND (requested_by = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM resolve_company_access(fiscal_period_reopen_requests.company_id) access(company_id, access_source, agency_id, effective_role, can_read, can_write, can_review, can_manage_company, can_manage_agency, can_manage_platform)
  WHERE (access.effective_role = ANY (ARRAY['platform_admin'::text, 'company_owner'::text, 'company_admin'::text, 'accountant'::text])))) AND (approved_by IS NULL) AND (status = ANY (ARRAY['requested'::text, 'blocked'::text]))));
ALTER POLICY idempotency_keys_select_own ON public.idempotency_keys
  USING ((( SELECT auth.uid() AS uid) = user_id));
ALTER POLICY invoice_financing_providers_select ON public.invoice_financing_providers
  USING ((( SELECT auth.uid() AS uid) IS NOT NULL));
ALTER POLICY invoice_payment_adjustments_insert ON public.invoice_payment_adjustments
  WITH CHECK (((user_id = ( SELECT auth.uid() AS uid)) AND (company_id IN ( SELECT company_members.company_id
   FROM company_members
  WHERE (company_members.user_id = ( SELECT auth.uid() AS uid))))));
ALTER POLICY invoice_payment_adjustments_select ON public.invoice_payment_adjustments
  USING ((company_id IN ( SELECT company_members.company_id
   FROM company_members
  WHERE (company_members.user_id = ( SELECT auth.uid() AS uid)))));
ALTER POLICY invoice_payment_adjustments_update ON public.invoice_payment_adjustments
  USING ((company_id IN ( SELECT company_members.company_id
   FROM company_members
  WHERE (company_members.user_id = ( SELECT auth.uid() AS uid)))))
  WITH CHECK ((company_id IN ( SELECT company_members.company_id
   FROM company_members
  WHERE (company_members.user_id = ( SELECT auth.uid() AS uid)))));
ALTER POLICY legal_acceptances_own_read ON public.legal_acceptances
  USING (((user_id = ( SELECT auth.uid() AS uid)) OR is_platform_admin() OR ((company_id IS NOT NULL) AND user_can_access_company_v2(company_id))));
ALTER POLICY legal_acceptances_service_insert ON public.legal_acceptances
  WITH CHECK (((user_id = ( SELECT auth.uid() AS uid)) OR is_platform_admin()));
ALTER POLICY notification_settings_delete ON public.notification_settings
  USING ((( SELECT auth.uid() AS uid) = user_id));
ALTER POLICY notification_settings_insert ON public.notification_settings
  WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
ALTER POLICY notification_settings_select ON public.notification_settings
  USING ((( SELECT auth.uid() AS uid) = user_id));
ALTER POLICY notification_settings_update ON public.notification_settings
  USING ((( SELECT auth.uid() AS uid) = user_id));
ALTER POLICY oauth_client_registrations_delete_own ON public.oauth_client_registrations
  USING ((user_id = ( SELECT auth.uid() AS uid)));
ALTER POLICY oauth_client_registrations_insert_own ON public.oauth_client_registrations
  WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
ALTER POLICY oauth_client_registrations_select_own ON public.oauth_client_registrations
  USING ((user_id = ( SELECT auth.uid() AS uid)));
ALTER POLICY oauth_client_registrations_update_own ON public.oauth_client_registrations
  USING ((user_id = ( SELECT auth.uid() AS uid)))
  WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
ALTER POLICY profiles_insert ON public.profiles
  WITH CHECK ((( SELECT auth.uid() AS uid) = id));
ALTER POLICY profiles_select ON public.profiles
  USING ((( SELECT auth.uid() AS uid) = id));
ALTER POLICY profiles_update ON public.profiles
  USING ((( SELECT auth.uid() AS uid) = id));
ALTER POLICY provider_consent_tokens_delete ON public.provider_consent_tokens
  USING ((consent_id IN ( SELECT provider_consents.id
   FROM provider_consents
  WHERE (provider_consents.company_id IN ( SELECT provider_consents.company_id
           FROM team_members
          WHERE (team_members.user_id = ( SELECT auth.uid() AS uid)))))));
ALTER POLICY provider_consent_tokens_insert ON public.provider_consent_tokens
  WITH CHECK ((consent_id IN ( SELECT provider_consents.id
   FROM provider_consents
  WHERE (provider_consents.company_id IN ( SELECT provider_consents.company_id
           FROM team_members
          WHERE (team_members.user_id = ( SELECT auth.uid() AS uid)))))));
ALTER POLICY provider_consent_tokens_select ON public.provider_consent_tokens
  USING ((consent_id IN ( SELECT provider_consents.id
   FROM provider_consents
  WHERE (provider_consents.company_id IN ( SELECT provider_consents.company_id
           FROM team_members
          WHERE (team_members.user_id = ( SELECT auth.uid() AS uid)))))));
ALTER POLICY provider_consent_tokens_update ON public.provider_consent_tokens
  USING ((consent_id IN ( SELECT provider_consents.id
   FROM provider_consents
  WHERE (provider_consents.company_id IN ( SELECT provider_consents.company_id
           FROM team_members
          WHERE (team_members.user_id = ( SELECT auth.uid() AS uid)))))));
ALTER POLICY provider_otc_delete ON public.provider_otc
  USING ((consent_id IN ( SELECT provider_consents.id
   FROM provider_consents
  WHERE (provider_consents.company_id IN ( SELECT provider_consents.company_id
           FROM team_members
          WHERE (team_members.user_id = ( SELECT auth.uid() AS uid)))))));
ALTER POLICY provider_otc_insert ON public.provider_otc
  WITH CHECK ((consent_id IN ( SELECT provider_consents.id
   FROM provider_consents
  WHERE (provider_consents.company_id IN ( SELECT provider_consents.company_id
           FROM team_members
          WHERE (team_members.user_id = ( SELECT auth.uid() AS uid)))))));
ALTER POLICY provider_otc_select ON public.provider_otc
  USING ((consent_id IN ( SELECT provider_consents.id
   FROM provider_consents
  WHERE (provider_consents.company_id IN ( SELECT provider_consents.company_id
           FROM team_members
          WHERE (team_members.user_id = ( SELECT auth.uid() AS uid)))))));
ALTER POLICY provider_otc_update ON public.provider_otc
  USING ((consent_id IN ( SELECT provider_consents.id
   FROM provider_consents
  WHERE (provider_consents.company_id IN ( SELECT provider_consents.company_id
           FROM team_members
          WHERE (team_members.user_id = ( SELECT auth.uid() AS uid)))))));
ALTER POLICY push_subscriptions_delete ON public.push_subscriptions
  USING ((( SELECT auth.uid() AS uid) = user_id));
ALTER POLICY push_subscriptions_insert ON public.push_subscriptions
  WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
ALTER POLICY push_subscriptions_select ON public.push_subscriptions
  USING ((( SELECT auth.uid() AS uid) = user_id));
ALTER POLICY push_subscriptions_update ON public.push_subscriptions
  USING ((( SELECT auth.uid() AS uid) = user_id));
ALTER POLICY payroll_config_select ON public.salary_payroll_config
  USING ((( SELECT auth.role() AS role) = 'authenticated'::text));
ALTER POLICY signed_consents_insert ON public.signed_consents
  WITH CHECK (((user_id = ( SELECT auth.uid() AS uid)) AND user_can_access_company_v2(company_id)));
ALTER POLICY tax_tables_select ON public.tax_table_rates
  USING ((( SELECT auth.role() AS role) = 'authenticated'::text));
ALTER POLICY teams_insert ON public.teams
  WITH CHECK ((created_by = ( SELECT auth.uid() AS uid)));
ALTER POLICY teams_update ON public.teams
  USING ((user_is_team_admin(id) OR (created_by = ( SELECT auth.uid() AS uid))))
  WITH CHECK ((user_is_team_admin(id) OR (created_by = ( SELECT auth.uid() AS uid))));
ALTER POLICY user_preferences_insert ON public.user_preferences
  WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
ALTER POLICY user_preferences_select ON public.user_preferences
  USING ((( SELECT auth.uid() AS uid) = user_id));
ALTER POLICY user_preferences_update ON public.user_preferences
  USING ((( SELECT auth.uid() AS uid) = user_id));
ALTER POLICY voucher_gap_explanations_insert ON public.voucher_gap_explanations
  WITH CHECK ((user_can_write_company(company_id) AND (EXISTS ( SELECT 1
   FROM (team_members tm
     JOIN companies c ON ((c.team_id = tm.team_id)))
  WHERE ((c.id = voucher_gap_explanations.company_id) AND (tm.user_id = ( SELECT auth.uid() AS uid)) AND (tm.role = ANY (ARRAY['owner'::text, 'admin'::text])))))));
ALTER POLICY voucher_gap_explanations_update ON public.voucher_gap_explanations
  USING ((user_can_write_company(company_id) AND (EXISTS ( SELECT 1
   FROM (team_members tm
     JOIN companies c ON ((c.team_id = tm.team_id)))
  WHERE ((c.id = voucher_gap_explanations.company_id) AND (tm.user_id = ( SELECT auth.uid() AS uid)) AND (tm.role = ANY (ARRAY['owner'::text, 'admin'::text])))))));
ALTER POLICY "Members can delete company webhooks" ON public.webhooks
  USING ((company_id IN ( SELECT company_members.company_id
   FROM company_members
  WHERE (company_members.user_id = ( SELECT auth.uid() AS uid)))));
ALTER POLICY "Members can insert company webhooks" ON public.webhooks
  WITH CHECK ((company_id IN ( SELECT company_members.company_id
   FROM company_members
  WHERE (company_members.user_id = ( SELECT auth.uid() AS uid)))));
ALTER POLICY "Members can update company webhooks" ON public.webhooks
  USING ((company_id IN ( SELECT company_members.company_id
   FROM company_members
  WHERE (company_members.user_id = ( SELECT auth.uid() AS uid)))));
ALTER POLICY "Members can view company webhooks" ON public.webhooks
  USING ((company_id IN ( SELECT company_members.company_id
   FROM company_members
  WHERE (company_members.user_id = ( SELECT auth.uid() AS uid)))));

NOTIFY pgrst, 'reload schema';
