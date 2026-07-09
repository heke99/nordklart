-- RLS write-capability hardening.
--
-- Until now most company-scoped WRITE policies only required tenant
-- MEMBERSHIP (user_company_ids / user_can_access_company_v2), so a viewer or
-- read-only member could mutate rows by talking to PostgREST directly even
-- though the API blocked them. Write policies on the sensitive business
-- tables now require write CAPABILITY via user_can_write_company()
-- (resolve_company_access().can_write — direct write-roles and authorized
-- agency staff; viewer/read-only/auditor excluded). SELECT stays
-- membership-scoped.
--
-- Also:
--   - skatteverket_tokens (encrypted OAuth tokens) are no longer readable or
--     writable by company members at all — the token store runs service-role.
--     A safe view (skatteverket_connections_v) exposes connection METADATA
--     (never token material) for dashboard "connected" badges.
--   - skatteverket_api_requests (audit log) becomes read-only for members;
--     rows are written by the server (service role) only.
--   - oauth_used_codes (OAuth replay-protection) gets RLS enabled with no
--     policies: service-role only. It was previously an RLS-less public
--     table readable by any authenticated PostgREST caller.
--
-- pg-test: covered-by tests/pg/rls-write-capability.pg.test.ts

-- ============================================================
-- 1. Invoices
-- ============================================================

DROP POLICY IF EXISTS invoices_insert ON public.invoices;
CREATE POLICY invoices_insert ON public.invoices
  FOR INSERT WITH CHECK (public.user_can_write_company(company_id));

DROP POLICY IF EXISTS invoices_update ON public.invoices;
CREATE POLICY invoices_update ON public.invoices
  FOR UPDATE USING (public.user_can_write_company(company_id))
  WITH CHECK (public.user_can_write_company(company_id));

DROP POLICY IF EXISTS invoices_delete ON public.invoices;
CREATE POLICY invoices_delete ON public.invoices
  FOR DELETE USING (public.user_can_write_company(company_id));

DROP POLICY IF EXISTS invoice_items_insert ON public.invoice_items;
CREATE POLICY invoice_items_insert ON public.invoice_items
  FOR INSERT WITH CHECK (EXISTS (
    SELECT 1 FROM public.invoices i
    WHERE i.id = invoice_id AND public.user_can_write_company(i.company_id)
  ));

DROP POLICY IF EXISTS invoice_items_update ON public.invoice_items;
CREATE POLICY invoice_items_update ON public.invoice_items
  FOR UPDATE USING (EXISTS (
    SELECT 1 FROM public.invoices i
    WHERE i.id = invoice_items.invoice_id AND public.user_can_write_company(i.company_id)
  ));

DROP POLICY IF EXISTS invoice_items_delete ON public.invoice_items;
CREATE POLICY invoice_items_delete ON public.invoice_items
  FOR DELETE USING (EXISTS (
    SELECT 1 FROM public.invoices i
    WHERE i.id = invoice_items.invoice_id AND public.user_can_write_company(i.company_id)
  ));

-- ============================================================
-- 2. Journal entries (drafts — posted rows stay trigger-immutable)
-- ============================================================

DROP POLICY IF EXISTS journal_entries_insert ON public.journal_entries;
CREATE POLICY journal_entries_insert ON public.journal_entries
  FOR INSERT WITH CHECK (public.user_can_write_company(company_id));

DROP POLICY IF EXISTS journal_entries_update ON public.journal_entries;
CREATE POLICY journal_entries_update ON public.journal_entries
  FOR UPDATE USING (public.user_can_write_company(company_id))
  WITH CHECK (public.user_can_write_company(company_id));

DROP POLICY IF EXISTS journal_entries_delete ON public.journal_entries;
CREATE POLICY journal_entries_delete ON public.journal_entries
  FOR DELETE USING (public.user_can_write_company(company_id));

DROP POLICY IF EXISTS journal_entry_lines_insert ON public.journal_entry_lines;
CREATE POLICY journal_entry_lines_insert ON public.journal_entry_lines
  FOR INSERT WITH CHECK (EXISTS (
    SELECT 1 FROM public.journal_entries je
    WHERE je.id = journal_entry_id AND public.user_can_write_company(je.company_id)
  ));

DROP POLICY IF EXISTS journal_entry_lines_update ON public.journal_entry_lines;
CREATE POLICY journal_entry_lines_update ON public.journal_entry_lines
  FOR UPDATE USING (EXISTS (
    SELECT 1 FROM public.journal_entries je
    WHERE je.id = journal_entry_lines.journal_entry_id AND public.user_can_write_company(je.company_id)
  ));

DROP POLICY IF EXISTS journal_entry_lines_delete ON public.journal_entry_lines;
CREATE POLICY journal_entry_lines_delete ON public.journal_entry_lines
  FOR DELETE USING (EXISTS (
    SELECT 1 FROM public.journal_entries je
    WHERE je.id = journal_entry_lines.journal_entry_id AND public.user_can_write_company(je.company_id)
  ));

-- ============================================================
-- 3. Recurring invoice schedules
-- ============================================================

DROP POLICY IF EXISTS "recurring_invoice_schedules_insert" ON public.recurring_invoice_schedules;
CREATE POLICY "recurring_invoice_schedules_insert" ON public.recurring_invoice_schedules
  FOR INSERT WITH CHECK (public.user_can_write_company(company_id));

DROP POLICY IF EXISTS "recurring_invoice_schedules_update" ON public.recurring_invoice_schedules;
CREATE POLICY "recurring_invoice_schedules_update" ON public.recurring_invoice_schedules
  FOR UPDATE USING (public.user_can_write_company(company_id))
  WITH CHECK (public.user_can_write_company(company_id));

DROP POLICY IF EXISTS "recurring_invoice_schedules_delete" ON public.recurring_invoice_schedules;
CREATE POLICY "recurring_invoice_schedules_delete" ON public.recurring_invoice_schedules
  FOR DELETE USING (public.user_can_write_company(company_id));

DROP POLICY IF EXISTS "recurring_invoice_schedule_items_insert" ON public.recurring_invoice_schedule_items;
CREATE POLICY "recurring_invoice_schedule_items_insert" ON public.recurring_invoice_schedule_items
  FOR INSERT WITH CHECK (EXISTS (
    SELECT 1 FROM public.recurring_invoice_schedules s
    WHERE s.id = schedule_id AND public.user_can_write_company(s.company_id)
  ));

DROP POLICY IF EXISTS "recurring_invoice_schedule_items_update" ON public.recurring_invoice_schedule_items;
CREATE POLICY "recurring_invoice_schedule_items_update" ON public.recurring_invoice_schedule_items
  FOR UPDATE USING (EXISTS (
    SELECT 1 FROM public.recurring_invoice_schedules s
    WHERE s.id = recurring_invoice_schedule_items.schedule_id AND public.user_can_write_company(s.company_id)
  ));

DROP POLICY IF EXISTS "recurring_invoice_schedule_items_delete" ON public.recurring_invoice_schedule_items;
CREATE POLICY "recurring_invoice_schedule_items_delete" ON public.recurring_invoice_schedule_items
  FOR DELETE USING (EXISTS (
    SELECT 1 FROM public.recurring_invoice_schedules s
    WHERE s.id = recurring_invoice_schedule_items.schedule_id AND public.user_can_write_company(s.company_id)
  ));

-- ============================================================
-- 4. Skatteverket company settings: reads for members, writes for writers
-- ============================================================

DROP POLICY IF EXISTS skatteverket_company_settings_write ON public.skatteverket_company_settings;
CREATE POLICY skatteverket_company_settings_insert ON public.skatteverket_company_settings
  FOR INSERT WITH CHECK (public.user_can_write_company(company_id) OR public.is_platform_admin());
CREATE POLICY skatteverket_company_settings_update ON public.skatteverket_company_settings
  FOR UPDATE USING (public.user_can_write_company(company_id) OR public.is_platform_admin())
  WITH CHECK (public.user_can_write_company(company_id) OR public.is_platform_admin());
CREATE POLICY skatteverket_company_settings_delete ON public.skatteverket_company_settings
  FOR DELETE USING (public.user_can_write_company(company_id) OR public.is_platform_admin());

-- ============================================================
-- 5. Skatteverket API audit log: server-written, member-readable
-- ============================================================

DROP POLICY IF EXISTS skatteverket_api_requests_write ON public.skatteverket_api_requests;
-- (skatteverket_api_requests_select stays: platform admin or company member.)

-- ============================================================
-- 6. Skatteverket tokens: service-role only + safe metadata view
-- ============================================================

DROP POLICY IF EXISTS skatteverket_tokens_select ON public.skatteverket_tokens;
DROP POLICY IF EXISTS skatteverket_tokens_insert ON public.skatteverket_tokens;
DROP POLICY IF EXISTS skatteverket_tokens_update ON public.skatteverket_tokens;
DROP POLICY IF EXISTS skatteverket_tokens_delete ON public.skatteverket_tokens;
-- RLS remains enabled with zero policies → only the service role touches the
-- table. Encrypted token material must never be selectable by end users.

-- Owner-rights view with an explicit tenant filter: exposes connection
-- METADATA only, never token columns.
CREATE OR REPLACE VIEW public.skatteverket_connections_v AS
SELECT
  t.company_id,
  t.user_id,
  t.scope,
  t.expires_at,
  t.created_at
FROM public.skatteverket_tokens t
WHERE t.company_id IN (SELECT public.user_company_ids());

GRANT SELECT ON public.skatteverket_connections_v TO authenticated, service_role;

-- ============================================================
-- 7. oauth_used_codes: replay table locked to the service role
-- ============================================================

ALTER TABLE public.oauth_used_codes ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
