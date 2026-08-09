-- Stop read-level membership from authorizing writes.
--
-- Two patterns exist side by side in the policy set:
--
--   invoices_update   USING (user_can_write_company(company_id))
--   supplier_invoices_update  USING (company_id IN (SELECT user_company_ids()))
--
-- The first asks "may this user WRITE this company". The second asks only "is
-- this user a MEMBER of this company", which is true for a viewer. So on every
-- table using the second form, a read-only user can INSERT, UPDATE and DELETE.
--
-- 57 tables were on the read-level form, covering most of the economic surface:
-- supplier_invoices, suppliers, customers, invoice_payments,
-- supplier_invoice_payments, chart_of_accounts, fiscal_periods, employees,
-- salary_runs, salary_line_items, assets, receipts, document_attachments,
-- sie_imports, voucher_gap_explanations, voucher_sequences and more.
--
-- This is reachable without the application. Supabase publishes PostgREST with
-- the user's own JWT, so a viewer does not need a route that forgot
-- requireWrite — they can PATCH /rest/v1/supplier_invoices?id=eq.<id> directly
-- and RLS is the only thing standing there. Demonstrated on a replayed
-- database: a viewer of a company successfully updated that company's supplier
-- invoice.
--
-- invoices, journal_entries and journal_entry_lines were moved to
-- user_can_write_company earlier; the change was never propagated to the rest.
-- This migration finishes it for the 147 INSERT/UPDATE/DELETE policies that
-- still carried the read-level predicate.
--
-- The transformation is mechanical and preserves everything else about each
-- policy — name, command, roles, permissiveness, and any additional conditions.
-- Only the membership predicate itself is swapped:
--
--   company_id IN (SELECT user_company_ids())  ->  user_can_write_company(company_id)
--
-- so a policy like voucher_gap_explanations_update keeps its team-admin
-- requirement and merely gains the write check. SELECT policies are deliberately
-- untouched: viewers must keep reading.
--
-- user_can_write_company resolves through resolve_company_access, which already
-- handles direct membership, agency access and platform admin, so no role logic
-- is duplicated here.
--
-- pg-test: covered-by tests/pg/tenant-isolation-matrix.pg.test.ts

BEGIN;

DROP POLICY IF EXISTS accounting_manual_overrides_insert ON public.accounting_manual_overrides;
CREATE POLICY accounting_manual_overrides_insert ON public.accounting_manual_overrides FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS accounting_review_queue_insert ON public.accounting_review_queue;
CREATE POLICY accounting_review_queue_insert ON public.accounting_review_queue FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS accounting_review_queue_update ON public.accounting_review_queue;
CREATE POLICY accounting_review_queue_update ON public.accounting_review_queue FOR UPDATE TO public
  USING ((user_can_write_company(company_id)))
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS accounting_rule_decisions_insert ON public.accounting_rule_decisions;
CREATE POLICY accounting_rule_decisions_insert ON public.accounting_rule_decisions FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS agent_conversations_delete ON public.agent_conversations;
CREATE POLICY agent_conversations_delete ON public.agent_conversations FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS agent_conversations_insert ON public.agent_conversations;
CREATE POLICY agent_conversations_insert ON public.agent_conversations FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS agent_conversations_update ON public.agent_conversations;
CREATE POLICY agent_conversations_update ON public.agent_conversations FOR UPDATE TO public
  USING ((user_can_write_company(company_id)))
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS agent_memory_insert ON public.agent_memory;
CREATE POLICY agent_memory_insert ON public.agent_memory FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS agent_memory_update ON public.agent_memory;
CREATE POLICY agent_memory_update ON public.agent_memory FOR UPDATE TO public
  USING ((user_can_write_company(company_id)))
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS agent_profiles_insert ON public.agent_profiles;
CREATE POLICY agent_profiles_insert ON public.agent_profiles FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS agent_profiles_update ON public.agent_profiles;
CREATE POLICY agent_profiles_update ON public.agent_profiles FOR UPDATE TO public
  USING ((user_can_write_company(company_id)))
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS agi_insert ON public.agi_declarations;
CREATE POLICY agi_insert ON public.agi_declarations FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS agi_update ON public.agi_declarations;
CREATE POLICY agi_update ON public.agi_declarations FOR UPDATE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS arsredovisning_narratives_delete ON public.arsredovisning_narratives;
CREATE POLICY arsredovisning_narratives_delete ON public.arsredovisning_narratives FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS arsredovisning_narratives_insert ON public.arsredovisning_narratives;
CREATE POLICY arsredovisning_narratives_insert ON public.arsredovisning_narratives FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS arsredovisning_narratives_update ON public.arsredovisning_narratives;
CREATE POLICY arsredovisning_narratives_update ON public.arsredovisning_narratives FOR UPDATE TO public
  USING ((user_can_write_company(company_id)))
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS arsredovisning_sigreq_delete ON public.arsredovisning_signature_requests;
CREATE POLICY arsredovisning_sigreq_delete ON public.arsredovisning_signature_requests FOR DELETE TO public
  USING (((user_can_write_company(company_id)) AND (status <> ALL (ARRAY['signed'::text, 'declined'::text]))));
DROP POLICY IF EXISTS arsredovisning_sigreq_insert ON public.arsredovisning_signature_requests;
CREATE POLICY arsredovisning_sigreq_insert ON public.arsredovisning_signature_requests FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS arsredovisning_sigreq_update ON public.arsredovisning_signature_requests;
CREATE POLICY arsredovisning_sigreq_update ON public.arsredovisning_signature_requests FOR UPDATE TO public
  USING ((user_can_write_company(company_id)))
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS assets_delete ON public.assets;
CREATE POLICY assets_delete ON public.assets FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS assets_insert ON public.assets;
CREATE POLICY assets_insert ON public.assets FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS assets_update ON public.assets;
CREATE POLICY assets_update ON public.assets FOR UPDATE TO public
  USING ((user_can_write_company(company_id)))
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS btl_delete ON public.booking_template_library;
CREATE POLICY btl_delete ON public.booking_template_library FOR DELETE TO public
  USING (((NOT is_system) AND ((user_can_write_company(company_id)) OR ((company_id IS NULL) AND (team_id IN ( SELECT user_team_ids() AS user_team_ids))))));
DROP POLICY IF EXISTS btl_insert ON public.booking_template_library;
CREATE POLICY btl_insert ON public.booking_template_library FOR INSERT TO public
  WITH CHECK (((NOT is_system) AND ((user_can_write_company(company_id)) OR ((company_id IS NULL) AND (team_id IN ( SELECT user_team_ids() AS user_team_ids))))));
DROP POLICY IF EXISTS btl_update ON public.booking_template_library;
CREATE POLICY btl_update ON public.booking_template_library FOR UPDATE TO public
  USING (((NOT is_system) AND ((user_can_write_company(company_id)) OR ((company_id IS NULL) AND (team_id IN ( SELECT user_team_ids() AS user_team_ids))))));
DROP POLICY IF EXISTS btu_delete ON public.booking_template_usage;
CREATE POLICY btu_delete ON public.booking_template_usage FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS btu_insert ON public.booking_template_usage;
CREATE POLICY btu_insert ON public.booking_template_usage FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS btu_update ON public.booking_template_usage;
CREATE POLICY btu_update ON public.booking_template_usage FOR UPDATE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS calendar_feeds_delete ON public.calendar_feeds;
CREATE POLICY calendar_feeds_delete ON public.calendar_feeds FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS calendar_feeds_insert ON public.calendar_feeds;
CREATE POLICY calendar_feeds_insert ON public.calendar_feeds FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS calendar_feeds_update ON public.calendar_feeds;
CREATE POLICY calendar_feeds_update ON public.calendar_feeds FOR UPDATE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS categorization_templates_delete ON public.categorization_templates;
CREATE POLICY categorization_templates_delete ON public.categorization_templates FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS categorization_templates_insert ON public.categorization_templates;
CREATE POLICY categorization_templates_insert ON public.categorization_templates FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS categorization_templates_update ON public.categorization_templates;
CREATE POLICY categorization_templates_update ON public.categorization_templates FOR UPDATE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS chart_of_accounts_delete ON public.chart_of_accounts;
CREATE POLICY chart_of_accounts_delete ON public.chart_of_accounts FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS chart_of_accounts_insert ON public.chart_of_accounts;
CREATE POLICY chart_of_accounts_insert ON public.chart_of_accounts FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS chart_of_accounts_update ON public.chart_of_accounts;
CREATE POLICY chart_of_accounts_update ON public.chart_of_accounts FOR UPDATE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS chat_messages_delete ON public.chat_messages;
CREATE POLICY chat_messages_delete ON public.chat_messages FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS chat_messages_insert ON public.chat_messages;
CREATE POLICY chat_messages_insert ON public.chat_messages FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS chat_messages_update ON public.chat_messages;
CREATE POLICY chat_messages_update ON public.chat_messages FOR UPDATE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS chat_sessions_delete ON public.chat_sessions;
CREATE POLICY chat_sessions_delete ON public.chat_sessions FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS chat_sessions_insert ON public.chat_sessions;
CREATE POLICY chat_sessions_insert ON public.chat_sessions FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS chat_sessions_update ON public.chat_sessions;
CREATE POLICY chat_sessions_update ON public.chat_sessions FOR UPDATE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS company_settings_delete ON public.company_settings;
CREATE POLICY company_settings_delete ON public.company_settings FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS cost_centers_delete ON public.cost_centers;
CREATE POLICY cost_centers_delete ON public.cost_centers FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS cost_centers_insert ON public.cost_centers;
CREATE POLICY cost_centers_insert ON public.cost_centers FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS cost_centers_update ON public.cost_centers;
CREATE POLICY cost_centers_update ON public.cost_centers FOR UPDATE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS customers_delete ON public.customers;
CREATE POLICY customers_delete ON public.customers FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS customers_insert ON public.customers;
CREATE POLICY customers_insert ON public.customers FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS customers_update ON public.customers;
CREATE POLICY customers_update ON public.customers FOR UPDATE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS deadlines_delete ON public.deadlines;
CREATE POLICY deadlines_delete ON public.deadlines FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS deadlines_insert ON public.deadlines;
CREATE POLICY deadlines_insert ON public.deadlines FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS deadlines_update ON public.deadlines;
CREATE POLICY deadlines_update ON public.deadlines FOR UPDATE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS depreciation_schedules_delete ON public.depreciation_schedules;
CREATE POLICY depreciation_schedules_delete ON public.depreciation_schedules FOR DELETE TO public
  USING (((user_can_write_company(company_id)) AND (journal_entry_id IS NULL)));
DROP POLICY IF EXISTS depreciation_schedules_insert ON public.depreciation_schedules;
CREATE POLICY depreciation_schedules_insert ON public.depreciation_schedules FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS depreciation_schedules_update ON public.depreciation_schedules;
CREATE POLICY depreciation_schedules_update ON public.depreciation_schedules FOR UPDATE TO public
  USING ((user_can_write_company(company_id)))
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS document_attachments_delete ON public.document_attachments;
CREATE POLICY document_attachments_delete ON public.document_attachments FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS document_attachments_insert ON public.document_attachments;
CREATE POLICY document_attachments_insert ON public.document_attachments FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS document_attachments_update ON public.document_attachments;
CREATE POLICY document_attachments_update ON public.document_attachments FOR UPDATE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS employee_benefits_delete ON public.employee_benefits;
CREATE POLICY employee_benefits_delete ON public.employee_benefits FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS employee_benefits_insert ON public.employee_benefits;
CREATE POLICY employee_benefits_insert ON public.employee_benefits FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS employee_benefits_update ON public.employee_benefits;
CREATE POLICY employee_benefits_update ON public.employee_benefits FOR UPDATE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS employees_delete ON public.employees;
CREATE POLICY employees_delete ON public.employees FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS employees_insert ON public.employees;
CREATE POLICY employees_insert ON public.employees FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS employees_update ON public.employees;
CREATE POLICY employees_update ON public.employees FOR UPDATE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS extension_data_delete ON public.extension_data;
CREATE POLICY extension_data_delete ON public.extension_data FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS extension_data_insert ON public.extension_data;
CREATE POLICY extension_data_insert ON public.extension_data FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS extension_data_update ON public.extension_data;
CREATE POLICY extension_data_update ON public.extension_data FOR UPDATE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS fiscal_periods_delete ON public.fiscal_periods;
CREATE POLICY fiscal_periods_delete ON public.fiscal_periods FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS fiscal_periods_insert ON public.fiscal_periods;
CREATE POLICY fiscal_periods_insert ON public.fiscal_periods FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS fiscal_periods_update ON public.fiscal_periods;
CREATE POLICY fiscal_periods_update ON public.fiscal_periods FOR UPDATE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS invoice_inbox_items_delete ON public.invoice_inbox_items;
CREATE POLICY invoice_inbox_items_delete ON public.invoice_inbox_items FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS invoice_inbox_items_insert ON public.invoice_inbox_items;
CREATE POLICY invoice_inbox_items_insert ON public.invoice_inbox_items FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS invoice_inbox_items_update ON public.invoice_inbox_items;
CREATE POLICY invoice_inbox_items_update ON public.invoice_inbox_items FOR UPDATE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS invoice_payments_delete ON public.invoice_payments;
CREATE POLICY invoice_payments_delete ON public.invoice_payments FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS invoice_payments_insert ON public.invoice_payments;
CREATE POLICY invoice_payments_insert ON public.invoice_payments FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS invoice_payments_update ON public.invoice_payments;
CREATE POLICY invoice_payments_update ON public.invoice_payments FOR UPDATE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS invoice_reminders_delete ON public.invoice_reminders;
CREATE POLICY invoice_reminders_delete ON public.invoice_reminders FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS invoice_reminders_insert ON public.invoice_reminders;
CREATE POLICY invoice_reminders_insert ON public.invoice_reminders FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS invoice_reminders_update ON public.invoice_reminders;
CREATE POLICY invoice_reminders_update ON public.invoice_reminders FOR UPDATE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS jenodoc_delete ON public.journal_entry_no_doc_required;
CREATE POLICY jenodoc_delete ON public.journal_entry_no_doc_required FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS jenodoc_insert ON public.journal_entry_no_doc_required;
CREATE POLICY jenodoc_insert ON public.journal_entry_no_doc_required FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS jenodoc_update ON public.journal_entry_no_doc_required;
CREATE POLICY jenodoc_update ON public.journal_entry_no_doc_required FOR UPDATE TO public
  USING ((user_can_write_company(company_id)))
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS mapping_rules_delete ON public.mapping_rules;
CREATE POLICY mapping_rules_delete ON public.mapping_rules FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS mapping_rules_insert ON public.mapping_rules;
CREATE POLICY mapping_rules_insert ON public.mapping_rules FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS mapping_rules_update ON public.mapping_rules;
CREATE POLICY mapping_rules_update ON public.mapping_rules FOR UPDATE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS payment_match_log_insert ON public.payment_match_log;
CREATE POLICY payment_match_log_insert ON public.payment_match_log FOR INSERT TO public
  WITH CHECK (((user_can_write_company(company_id)) OR (company_id IS NULL)));
DROP POLICY IF EXISTS pending_operations_automation_insert ON public.pending_operations;
CREATE POLICY pending_operations_automation_insert ON public.pending_operations FOR INSERT TO public
  WITH CHECK (((actor_type = 'automation'::text) AND (auth.uid() = user_id) AND (user_can_write_company(company_id))));
DROP POLICY IF EXISTS pending_operations_chat_insert ON public.pending_operations;
CREATE POLICY pending_operations_chat_insert ON public.pending_operations FOR INSERT TO public
  WITH CHECK (((actor_type = 'agent_chat'::text) AND (auth.uid() = user_id) AND (user_can_write_company(company_id))));
DROP POLICY IF EXISTS pending_operations_update ON public.pending_operations;
CREATE POLICY pending_operations_update ON public.pending_operations FOR UPDATE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS projects_delete ON public.projects;
CREATE POLICY projects_delete ON public.projects FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS projects_insert ON public.projects;
CREATE POLICY projects_insert ON public.projects FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS projects_update ON public.projects;
CREATE POLICY projects_update ON public.projects FOR UPDATE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS provider_consents_delete ON public.provider_consents;
CREATE POLICY provider_consents_delete ON public.provider_consents FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS provider_consents_insert ON public.provider_consents;
CREATE POLICY provider_consents_insert ON public.provider_consents FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS provider_consents_update ON public.provider_consents;
CREATE POLICY provider_consents_update ON public.provider_consents FOR UPDATE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS receipts_delete ON public.receipts;
CREATE POLICY receipts_delete ON public.receipts FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS receipts_insert ON public.receipts;
CREATE POLICY receipts_insert ON public.receipts FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS receipts_update ON public.receipts;
CREATE POLICY receipts_update ON public.receipts FOR UPDATE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS salary_absence_days_delete ON public.salary_absence_days;
CREATE POLICY salary_absence_days_delete ON public.salary_absence_days FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS salary_absence_days_insert ON public.salary_absence_days;
CREATE POLICY salary_absence_days_insert ON public.salary_absence_days FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS salary_absence_days_update ON public.salary_absence_days;
CREATE POLICY salary_absence_days_update ON public.salary_absence_days FOR UPDATE TO public
  USING ((user_can_write_company(company_id)))
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS sli_delete ON public.salary_line_items;
CREATE POLICY sli_delete ON public.salary_line_items FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS sli_insert ON public.salary_line_items;
CREATE POLICY sli_insert ON public.salary_line_items FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS sli_update ON public.salary_line_items;
CREATE POLICY sli_update ON public.salary_line_items FOR UPDATE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS salary_payslip_deliveries_insert ON public.salary_payslip_deliveries;
CREATE POLICY salary_payslip_deliveries_insert ON public.salary_payslip_deliveries FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS salary_payslip_deliveries_update ON public.salary_payslip_deliveries;
CREATE POLICY salary_payslip_deliveries_update ON public.salary_payslip_deliveries FOR UPDATE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS sre_delete ON public.salary_run_employees;
CREATE POLICY sre_delete ON public.salary_run_employees FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS sre_insert ON public.salary_run_employees;
CREATE POLICY sre_insert ON public.salary_run_employees FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS sre_update ON public.salary_run_employees;
CREATE POLICY sre_update ON public.salary_run_employees FOR UPDATE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS salary_runs_delete ON public.salary_runs;
CREATE POLICY salary_runs_delete ON public.salary_runs FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS salary_runs_insert ON public.salary_runs;
CREATE POLICY salary_runs_insert ON public.salary_runs FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS salary_runs_update ON public.salary_runs;
CREATE POLICY salary_runs_update ON public.salary_runs FOR UPDATE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS salary_worked_days_delete ON public.salary_worked_days;
CREATE POLICY salary_worked_days_delete ON public.salary_worked_days FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS salary_worked_days_insert ON public.salary_worked_days;
CREATE POLICY salary_worked_days_insert ON public.salary_worked_days FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS salary_worked_days_update ON public.salary_worked_days;
CREATE POLICY salary_worked_days_update ON public.salary_worked_days FOR UPDATE TO public
  USING ((user_can_write_company(company_id)))
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS shift_premium_rules_delete ON public.shift_premium_rules;
CREATE POLICY shift_premium_rules_delete ON public.shift_premium_rules FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS shift_premium_rules_insert ON public.shift_premium_rules;
CREATE POLICY shift_premium_rules_insert ON public.shift_premium_rules FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS shift_premium_rules_update ON public.shift_premium_rules;
CREATE POLICY shift_premium_rules_update ON public.shift_premium_rules FOR UPDATE TO public
  USING ((user_can_write_company(company_id)))
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS sie_account_mappings_delete ON public.sie_account_mappings;
CREATE POLICY sie_account_mappings_delete ON public.sie_account_mappings FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS sie_account_mappings_insert ON public.sie_account_mappings;
CREATE POLICY sie_account_mappings_insert ON public.sie_account_mappings FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS sie_account_mappings_update ON public.sie_account_mappings;
CREATE POLICY sie_account_mappings_update ON public.sie_account_mappings FOR UPDATE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS sie_imports_delete ON public.sie_imports;
CREATE POLICY sie_imports_delete ON public.sie_imports FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS sie_imports_insert ON public.sie_imports;
CREATE POLICY sie_imports_insert ON public.sie_imports FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS sie_imports_update ON public.sie_imports;
CREATE POLICY sie_imports_update ON public.sie_imports FOR UPDATE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS skattekonto_rules_delete ON public.skattekonto_rules;
CREATE POLICY skattekonto_rules_delete ON public.skattekonto_rules FOR DELETE TO public
  USING (((company_id IS NOT NULL) AND (user_can_write_company(company_id))));
DROP POLICY IF EXISTS skattekonto_rules_insert ON public.skattekonto_rules;
CREATE POLICY skattekonto_rules_insert ON public.skattekonto_rules FOR INSERT TO public
  WITH CHECK (((company_id IS NOT NULL) AND (user_can_write_company(company_id))));
DROP POLICY IF EXISTS skattekonto_rules_update ON public.skattekonto_rules;
CREATE POLICY skattekonto_rules_update ON public.skattekonto_rules FOR UPDATE TO public
  USING (((company_id IS NOT NULL) AND (user_can_write_company(company_id))))
  WITH CHECK (((company_id IS NOT NULL) AND (user_can_write_company(company_id))));
DROP POLICY IF EXISTS "Users delete skattekonto transactions for their companies" ON public.skattekonto_transactions;
CREATE POLICY "Users delete skattekonto transactions for their companies" ON public.skattekonto_transactions FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS "Users insert skattekonto transactions for their companies" ON public.skattekonto_transactions;
CREATE POLICY "Users insert skattekonto transactions for their companies" ON public.skattekonto_transactions FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS "Users update skattekonto transactions for their companies" ON public.skattekonto_transactions;
CREATE POLICY "Users update skattekonto transactions for their companies" ON public.skattekonto_transactions FOR UPDATE TO public
  USING ((user_can_write_company(company_id)))
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS supplier_invoice_payments_delete ON public.supplier_invoice_payments;
CREATE POLICY supplier_invoice_payments_delete ON public.supplier_invoice_payments FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS supplier_invoice_payments_insert ON public.supplier_invoice_payments;
CREATE POLICY supplier_invoice_payments_insert ON public.supplier_invoice_payments FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS supplier_invoice_payments_update ON public.supplier_invoice_payments;
CREATE POLICY supplier_invoice_payments_update ON public.supplier_invoice_payments FOR UPDATE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS supplier_invoices_delete ON public.supplier_invoices;
CREATE POLICY supplier_invoices_delete ON public.supplier_invoices FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS supplier_invoices_insert ON public.supplier_invoices;
CREATE POLICY supplier_invoices_insert ON public.supplier_invoices FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS supplier_invoices_update ON public.supplier_invoices;
CREATE POLICY supplier_invoices_update ON public.supplier_invoices FOR UPDATE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS suppliers_delete ON public.suppliers;
CREATE POLICY suppliers_delete ON public.suppliers FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS suppliers_insert ON public.suppliers;
CREATE POLICY suppliers_insert ON public.suppliers FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS suppliers_update ON public.suppliers;
CREATE POLICY suppliers_update ON public.suppliers FOR UPDATE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS transaction_voucher_links_delete ON public.transaction_voucher_links;
CREATE POLICY transaction_voucher_links_delete ON public.transaction_voucher_links FOR DELETE TO public
  USING ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS transaction_voucher_links_insert ON public.transaction_voucher_links;
CREATE POLICY transaction_voucher_links_insert ON public.transaction_voucher_links FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS transaction_voucher_links_update ON public.transaction_voucher_links;
CREATE POLICY transaction_voucher_links_update ON public.transaction_voucher_links FOR UPDATE TO public
  USING ((user_can_write_company(company_id)))
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS voucher_gap_explanations_insert ON public.voucher_gap_explanations;
CREATE POLICY voucher_gap_explanations_insert ON public.voucher_gap_explanations FOR INSERT TO public
  WITH CHECK (((user_can_write_company(company_id)) AND (EXISTS ( SELECT 1
   FROM (team_members tm
     JOIN companies c ON ((c.team_id = tm.team_id)))
  WHERE ((c.id = voucher_gap_explanations.company_id) AND (tm.user_id = auth.uid()) AND (tm.role = ANY (ARRAY['owner'::text, 'admin'::text])))))));
DROP POLICY IF EXISTS voucher_gap_explanations_update ON public.voucher_gap_explanations;
CREATE POLICY voucher_gap_explanations_update ON public.voucher_gap_explanations FOR UPDATE TO public
  USING (((user_can_write_company(company_id)) AND (EXISTS ( SELECT 1
   FROM (team_members tm
     JOIN companies c ON ((c.team_id = tm.team_id)))
  WHERE ((c.id = voucher_gap_explanations.company_id) AND (tm.user_id = auth.uid()) AND (tm.role = ANY (ARRAY['owner'::text, 'admin'::text])))))));
DROP POLICY IF EXISTS voucher_sequences_insert ON public.voucher_sequences;
CREATE POLICY voucher_sequences_insert ON public.voucher_sequences FOR INSERT TO public
  WITH CHECK ((user_can_write_company(company_id)));
DROP POLICY IF EXISTS voucher_sequences_update ON public.voucher_sequences;
CREATE POLICY voucher_sequences_update ON public.voucher_sequences FOR UPDATE TO public
  USING ((user_can_write_company(company_id)));

COMMIT;

NOTIFY pgrst, 'reload schema';
