-- The third membership-only write surface: `FOR ALL` policies.
--
-- 20260808170000 swapped 147 write policies from membership to write
-- capability. 20260809100000 finished the child-row tables it missed.
-- 20260810120000 caught the second spelling of the read gate,
-- user_can_access_company_v2(). All three sweeps, and the guard in
-- tenant-isolation-matrix that was supposed to stop a fourth, share one filter:
--
--   cmd IN ('INSERT', 'UPDATE', 'DELETE')
--
-- A policy declared `FOR ALL` has cmd = 'ALL'. It covers SELECT, INSERT, UPDATE
-- and DELETE in a single row, so it is a write policy — and not one of the
-- three sweeps could see it. 22 of them authorize writes on read-level
-- membership across 20 tables, which is why the same defect has now been found
-- three times in three shapes.
--
-- What they gate is not peripheral:
--
--   api_client_scopes        the scopes attached to an API key. A viewer could
--                            widen their own key's authority, which converts a
--                            read-only seat into whatever the key can reach.
--   bank_accounts            the company's bank account records.
--   tax_declaration_*        six tables carrying INK2/NE declaration state,
--                            adjustments, fields, warnings and exports.
--   year_end_*               adjustments, checks, deliverables and projects —
--                            the year-end close itself.
--   webhook_endpoints        where company data gets delivered. Rewriting an
--                            endpoint redirects it.
--   automation_decisions, bookkeeping_automation_rules,
--   review_queue_items, transaction_match_candidates,
--   webhook_deliveries, onboarding_*
--
-- The rewrite is the same mechanical one as the previous three sweeps and
-- preserves everything else about each policy — name, command, roles,
-- permissiveness, and every additional condition. Only the company predicate
-- changes:
--
--   user_can_access_company_v2(company_id)  ->  user_can_write_company(company_id)
--
-- so onboarding_sessions_company_write keeps its `company_id IS NOT NULL`
-- guard, and api_client_scopes keeps reaching tenancy through its parent
-- api_keys row.
--
-- Keeping these as `FOR ALL` rather than splitting them per command is
-- deliberate: splitting would change the read behaviour too, and viewers must
-- keep reading. user_can_write_company() is false for a viewer and true for a
-- writer, so a `FOR ALL` policy carrying it grants a viewer nothing — which is
-- why the accompanying guard change treats 'ALL' as a write command rather
-- than banning the form.
--
-- pg-test: covered-by tests/pg/tenant-isolation-matrix.pg.test.ts

BEGIN;

-- api_client_scopes — reaches tenancy through its parent api_keys row --------
DROP POLICY IF EXISTS api_client_scopes_write ON public.api_client_scopes;
CREATE POLICY api_client_scopes_write ON public.api_client_scopes FOR ALL TO public
  USING (EXISTS (
    SELECT 1 FROM public.api_keys k
    WHERE k.id = api_client_scopes.api_key_id AND public.user_can_write_company(k.company_id)))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.api_keys k
    WHERE k.id = api_client_scopes.api_key_id AND public.user_can_write_company(k.company_id)));

-- automation and bookkeeping rules -------------------------------------------
DROP POLICY IF EXISTS automation_decisions_write ON public.automation_decisions;
CREATE POLICY automation_decisions_write ON public.automation_decisions FOR ALL TO public
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));

DROP POLICY IF EXISTS bookkeeping_automation_rules_write ON public.bookkeeping_automation_rules;
CREATE POLICY bookkeeping_automation_rules_write ON public.bookkeeping_automation_rules FOR ALL TO public
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));

-- bank accounts ---------------------------------------------------------------
DROP POLICY IF EXISTS bank_accounts_write ON public.bank_accounts;
CREATE POLICY bank_accounts_write ON public.bank_accounts FOR ALL TO public
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));

-- onboarding ------------------------------------------------------------------
DROP POLICY IF EXISTS onboarding_choices_write ON public.onboarding_choices;
CREATE POLICY onboarding_choices_write ON public.onboarding_choices FOR ALL TO public
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));

DROP POLICY IF EXISTS onboarding_sessions_write ON public.onboarding_sessions;
CREATE POLICY onboarding_sessions_write ON public.onboarding_sessions FOR ALL TO public
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));

DROP POLICY IF EXISTS onboarding_sessions_company_write ON public.onboarding_sessions;
CREATE POLICY onboarding_sessions_company_write ON public.onboarding_sessions FOR ALL TO public
  USING ((company_id IS NOT NULL) AND user_can_write_company(company_id))
  WITH CHECK ((company_id IS NOT NULL) AND user_can_write_company(company_id));

DROP POLICY IF EXISTS onboarding_steps_write ON public.onboarding_steps;
CREATE POLICY onboarding_steps_write ON public.onboarding_steps FOR ALL TO public
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));

-- review queue and matching ---------------------------------------------------
DROP POLICY IF EXISTS review_queue_items_write ON public.review_queue_items;
CREATE POLICY review_queue_items_write ON public.review_queue_items FOR ALL TO public
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));

DROP POLICY IF EXISTS transaction_match_candidates_write ON public.transaction_match_candidates;
CREATE POLICY transaction_match_candidates_write ON public.transaction_match_candidates FOR ALL TO public
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));

-- tax declarations ------------------------------------------------------------
DROP POLICY IF EXISTS tax_declaration_adjustments_access ON public.tax_declaration_adjustments;
CREATE POLICY tax_declaration_adjustments_access ON public.tax_declaration_adjustments FOR ALL TO public
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));

DROP POLICY IF EXISTS tax_declaration_exports_access ON public.tax_declaration_exports;
CREATE POLICY tax_declaration_exports_access ON public.tax_declaration_exports FOR ALL TO public
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));

DROP POLICY IF EXISTS tax_declaration_fields_access ON public.tax_declaration_fields;
CREATE POLICY tax_declaration_fields_access ON public.tax_declaration_fields FOR ALL TO public
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));

DROP POLICY IF EXISTS tax_declaration_projects_access ON public.tax_declaration_projects;
CREATE POLICY tax_declaration_projects_access ON public.tax_declaration_projects FOR ALL TO public
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));

DROP POLICY IF EXISTS tax_declaration_answers_access ON public.tax_declaration_questionnaire_answers;
CREATE POLICY tax_declaration_answers_access ON public.tax_declaration_questionnaire_answers FOR ALL TO public
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));

DROP POLICY IF EXISTS tax_declaration_warnings_access ON public.tax_declaration_warnings;
CREATE POLICY tax_declaration_warnings_access ON public.tax_declaration_warnings FOR ALL TO public
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));

-- webhooks --------------------------------------------------------------------
DROP POLICY IF EXISTS webhook_deliveries_write ON public.webhook_deliveries;
CREATE POLICY webhook_deliveries_write ON public.webhook_deliveries FOR ALL TO public
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));

DROP POLICY IF EXISTS webhook_endpoints_write ON public.webhook_endpoints;
CREATE POLICY webhook_endpoints_write ON public.webhook_endpoints FOR ALL TO public
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));

-- year-end --------------------------------------------------------------------
DROP POLICY IF EXISTS year_end_adjustments_write ON public.year_end_adjustments;
CREATE POLICY year_end_adjustments_write ON public.year_end_adjustments FOR ALL TO public
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));

DROP POLICY IF EXISTS year_end_checks_write ON public.year_end_checks;
CREATE POLICY year_end_checks_write ON public.year_end_checks FOR ALL TO public
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));

DROP POLICY IF EXISTS year_end_deliverables_write ON public.year_end_deliverables;
CREATE POLICY year_end_deliverables_write ON public.year_end_deliverables FOR ALL TO public
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));

DROP POLICY IF EXISTS year_end_projects_write ON public.year_end_projects;
CREATE POLICY year_end_projects_write ON public.year_end_projects FOR ALL TO public
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));

-- ---------------------------------------------------------------------------
-- The same shape, written as `membership OR is_platform_admin()`.
--
-- These five read as though the platform-admin clause were the permissive part,
-- but it is the membership half that grants the write: a viewer satisfies
-- user_can_access_company_v2() and never reaches the OR. The platform branch is
-- kept verbatim so platform access is unchanged — it is redundant, because
-- user_can_write_company() already resolves platform_admin to can_write, but
-- dropping it would quietly change what the policy says it does.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS api_clients_write ON public.api_clients;
CREATE POLICY api_clients_write ON public.api_clients FOR ALL TO public
  USING ((user_can_write_company(company_id) OR is_platform_admin()))
  WITH CHECK ((user_can_write_company(company_id) OR is_platform_admin()));

DROP POLICY IF EXISTS skatteverket_deadlines_write ON public.skatteverket_deadlines;
CREATE POLICY skatteverket_deadlines_write ON public.skatteverket_deadlines FOR ALL TO public
  USING ((user_can_write_company(company_id) OR is_platform_admin()))
  WITH CHECK ((user_can_write_company(company_id) OR is_platform_admin()));

DROP POLICY IF EXISTS tax_codes_write ON public.tax_codes;
CREATE POLICY tax_codes_write ON public.tax_codes FOR ALL TO public
  USING (((company_id IS NOT NULL) AND (user_can_write_company(company_id) OR is_platform_admin())))
  WITH CHECK (((company_id IS NOT NULL) AND (user_can_write_company(company_id) OR is_platform_admin())));

DROP POLICY IF EXISTS tax_submissions_write ON public.tax_submissions;
CREATE POLICY tax_submissions_write ON public.tax_submissions FOR ALL TO public
  USING ((user_can_write_company(company_id) OR is_platform_admin()))
  WITH CHECK ((user_can_write_company(company_id) OR is_platform_admin()));

DROP POLICY IF EXISTS tax_submission_events_write ON public.tax_submission_events;
CREATE POLICY tax_submission_events_write ON public.tax_submission_events FOR ALL TO public
  USING ((user_can_write_company(company_id) OR is_platform_admin()))
  WITH CHECK ((user_can_write_company(company_id) OR is_platform_admin()));

-- ---------------------------------------------------------------------------
-- Onboarding rows reached through their session.
--
-- These two policies carry both shapes at once. A signup session that has no
-- company yet belongs to one person, and the policy correctly says so with
-- `os.user_id = auth.uid()`. Once the session has a company, the second branch
-- falls back to membership — so after the company exists, a viewer could write
-- its onboarding rows.
--
-- Only the company branch changes. The pre-company branch is left exactly as it
-- is: at that point there is no company to have write capability for, and the
-- person creating the workspace must be able to proceed.
--
-- This shape is also why the guard's owner-scoped exemption is not a blanket
-- one. It matches `user_id = auth.uid()` anywhere in the policy, so a policy
-- that is owner-scoped in one branch and membership-scoped in another looked
-- exempt while still granting the write.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS onboarding_choices_session_access ON public.onboarding_choices;
CREATE POLICY onboarding_choices_session_access ON public.onboarding_choices FOR ALL TO public
  USING (EXISTS (
    SELECT 1 FROM public.onboarding_sessions os
    WHERE os.id = onboarding_choices.session_id
      AND (((os.company_id IS NULL) AND (os.user_id = auth.uid()))
        OR ((os.company_id IS NOT NULL) AND public.user_can_write_company(os.company_id)))))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.onboarding_sessions os
    WHERE os.id = onboarding_choices.session_id
      AND (((os.company_id IS NULL) AND (os.user_id = auth.uid()))
        OR ((os.company_id IS NOT NULL) AND public.user_can_write_company(os.company_id)))));

DROP POLICY IF EXISTS onboarding_steps_session_access ON public.onboarding_steps;
CREATE POLICY onboarding_steps_session_access ON public.onboarding_steps FOR ALL TO public
  USING (EXISTS (
    SELECT 1 FROM public.onboarding_sessions os
    WHERE os.id = onboarding_steps.session_id
      AND (((os.company_id IS NULL) AND (os.user_id = auth.uid()))
        OR ((os.company_id IS NOT NULL) AND public.user_can_write_company(os.company_id)))))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.onboarding_sessions os
    WHERE os.id = onboarding_steps.session_id
      AND (((os.company_id IS NULL) AND (os.user_id = auth.uid()))
        OR ((os.company_id IS NOT NULL) AND public.user_can_write_company(os.company_id)))));

COMMIT;

NOTIFY pgrst, 'reload schema';
