-- The second membership-only write surface: user_can_access_company_v2.
--
-- 20260808170000 swapped 147 write policies from membership to write
-- capability, and 20260809100000 finished the child-row tables it missed. Both
-- sweeps were built by searching for one predicate:
--
--   company_id IN (SELECT user_company_ids())
--
-- There is a second helper with the same meaning and a different name.
-- public.user_can_access_company_v2(company_id) answers "may this user SEE this
-- company" — direct membership, agency access, or platform admin — and it
-- accepts `active_limited` through company_member_is_active(). It is the read
-- gate. Used on an INSERT/UPDATE/DELETE policy it authorizes a viewer to write,
-- exactly as the user_company_ids form did, and it was invisible to both
-- sweeps because neither searched for it.
--
-- 29 write policies across 15 tables were on this form in production, including
-- the ones where it matters most:
--
--   payment_initiations         — initiates real outbound payments
--   invoice_financing_*         — sells or borrows against a receivable
--   accrual_schedules(+ installments) — periodisering that becomes vouchers
--   arsredovisning_submissions  — the annual report filed with Bolagsverket
--   e_invoice_deliveries, bank_sync_runs, bolagsverket_subscriptions,
--   articles, tax_declaration_audit_events
--
-- The rewrite is mechanical and preserves everything else about each policy —
-- name, command, roles, permissiveness, and every additional condition. Only
-- the company predicate changes:
--
--   user_can_access_company_v2(company_id)  ->  user_can_write_company(company_id)
--
-- so accrual_installments_delete keeps `journal_entry_id IS NULL` and
-- accrual_schedules_delete keeps its booked-installment guard. SELECT policies
-- are untouched: viewers must keep reading, and `... OR is_platform_admin()` on
-- the read side stays exactly as it is.
--
-- Two policies are deliberately NOT changed. signed_consents_insert and
-- bolagsverket_avtal_acceptances_insert already pin `user_id = auth.uid()`:
-- they record that a specific person signed something with BankID, which is a
-- personal act attributed to the signer, not a write to the company's books.
-- 20260808180000 established that shape for the assistant tables after
-- requiring write capability there locked auditors out of a feature they need.
-- The same reasoning applies here, and membership + ownership is already
-- tighter than membership alone. If signing should additionally require write
-- capability, that is a product decision about who may bind the company, and it
-- belongs in the route layer where the consent is requested — not in a
-- mechanical sweep.
--
-- pg-test: covered-by tests/pg/tenant-isolation-matrix.pg.test.ts

BEGIN;

-- accrual_schedule_installments -----------------------------------------------
DROP POLICY IF EXISTS accrual_installments_insert ON public.accrual_schedule_installments;
CREATE POLICY accrual_installments_insert ON public.accrual_schedule_installments FOR INSERT TO public
  WITH CHECK (user_can_write_company(company_id));

DROP POLICY IF EXISTS accrual_installments_update ON public.accrual_schedule_installments;
CREATE POLICY accrual_installments_update ON public.accrual_schedule_installments FOR UPDATE TO public
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));

DROP POLICY IF EXISTS accrual_installments_delete ON public.accrual_schedule_installments;
CREATE POLICY accrual_installments_delete ON public.accrual_schedule_installments FOR DELETE TO public
  USING ((user_can_write_company(company_id) AND (journal_entry_id IS NULL)));

-- accrual_schedules -----------------------------------------------------------
DROP POLICY IF EXISTS accrual_schedules_insert ON public.accrual_schedules;
CREATE POLICY accrual_schedules_insert ON public.accrual_schedules FOR INSERT TO public
  WITH CHECK (user_can_write_company(company_id));

DROP POLICY IF EXISTS accrual_schedules_update ON public.accrual_schedules;
CREATE POLICY accrual_schedules_update ON public.accrual_schedules FOR UPDATE TO public
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));

DROP POLICY IF EXISTS accrual_schedules_delete ON public.accrual_schedules;
CREATE POLICY accrual_schedules_delete ON public.accrual_schedules FOR DELETE TO public
  USING ((user_can_write_company(company_id) AND (NOT (EXISTS ( SELECT 1
     FROM accrual_schedule_installments i
    WHERE ((i.schedule_id = accrual_schedules.id) AND (i.journal_entry_id IS NOT NULL)))))));

-- arsredovisning_submissions --------------------------------------------------
DROP POLICY IF EXISTS arsredovisning_submissions_insert ON public.arsredovisning_submissions;
CREATE POLICY arsredovisning_submissions_insert ON public.arsredovisning_submissions FOR INSERT TO public
  WITH CHECK (user_can_write_company(company_id));

DROP POLICY IF EXISTS arsredovisning_submissions_update ON public.arsredovisning_submissions;
CREATE POLICY arsredovisning_submissions_update ON public.arsredovisning_submissions FOR UPDATE TO public
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));

-- articles --------------------------------------------------------------------
DROP POLICY IF EXISTS articles_insert ON public.articles;
CREATE POLICY articles_insert ON public.articles FOR INSERT TO public
  WITH CHECK (user_can_write_company(company_id));

DROP POLICY IF EXISTS articles_update ON public.articles;
CREATE POLICY articles_update ON public.articles FOR UPDATE TO public
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));

DROP POLICY IF EXISTS articles_delete ON public.articles;
CREATE POLICY articles_delete ON public.articles FOR DELETE TO public
  USING (user_can_write_company(company_id));

-- bank_sync_runs --------------------------------------------------------------
DROP POLICY IF EXISTS bank_sync_runs_insert ON public.bank_sync_runs;
CREATE POLICY bank_sync_runs_insert ON public.bank_sync_runs FOR INSERT TO public
  WITH CHECK (user_can_write_company(company_id));

DROP POLICY IF EXISTS bank_sync_runs_update ON public.bank_sync_runs;
CREATE POLICY bank_sync_runs_update ON public.bank_sync_runs FOR UPDATE TO public
  USING (user_can_write_company(company_id));

-- bolagsverket_subscriptions --------------------------------------------------
DROP POLICY IF EXISTS bolagsverket_subscriptions_insert ON public.bolagsverket_subscriptions;
CREATE POLICY bolagsverket_subscriptions_insert ON public.bolagsverket_subscriptions FOR INSERT TO public
  WITH CHECK (user_can_write_company(company_id));

DROP POLICY IF EXISTS bolagsverket_subscriptions_update ON public.bolagsverket_subscriptions;
CREATE POLICY bolagsverket_subscriptions_update ON public.bolagsverket_subscriptions FOR UPDATE TO public
  USING (user_can_write_company(company_id))
  WITH CHECK (user_can_write_company(company_id));

DROP POLICY IF EXISTS bolagsverket_subscriptions_delete ON public.bolagsverket_subscriptions;
CREATE POLICY bolagsverket_subscriptions_delete ON public.bolagsverket_subscriptions FOR DELETE TO public
  USING (user_can_write_company(company_id));

-- e_invoice_deliveries --------------------------------------------------------
DROP POLICY IF EXISTS e_invoice_deliveries_insert ON public.e_invoice_deliveries;
CREATE POLICY e_invoice_deliveries_insert ON public.e_invoice_deliveries FOR INSERT TO public
  WITH CHECK (user_can_write_company(company_id));

DROP POLICY IF EXISTS e_invoice_deliveries_update ON public.e_invoice_deliveries;
CREATE POLICY e_invoice_deliveries_update ON public.e_invoice_deliveries FOR UPDATE TO public
  USING (user_can_write_company(company_id));

-- invoice_financing_applications ----------------------------------------------
DROP POLICY IF EXISTS invoice_financing_applications_insert ON public.invoice_financing_applications;
CREATE POLICY invoice_financing_applications_insert ON public.invoice_financing_applications FOR INSERT TO public
  WITH CHECK (user_can_write_company(company_id));

DROP POLICY IF EXISTS invoice_financing_applications_update ON public.invoice_financing_applications;
CREATE POLICY invoice_financing_applications_update ON public.invoice_financing_applications FOR UPDATE TO public
  USING (user_can_write_company(company_id));

-- invoice_financing_offers ----------------------------------------------------
DROP POLICY IF EXISTS invoice_financing_offers_insert ON public.invoice_financing_offers;
CREATE POLICY invoice_financing_offers_insert ON public.invoice_financing_offers FOR INSERT TO public
  WITH CHECK (user_can_write_company(company_id));

DROP POLICY IF EXISTS invoice_financing_offers_update ON public.invoice_financing_offers;
CREATE POLICY invoice_financing_offers_update ON public.invoice_financing_offers FOR UPDATE TO public
  USING (user_can_write_company(company_id));

-- invoice_financing_events ----------------------------------------------------
DROP POLICY IF EXISTS invoice_financing_events_insert ON public.invoice_financing_events;
CREATE POLICY invoice_financing_events_insert ON public.invoice_financing_events FOR INSERT TO public
  WITH CHECK (user_can_write_company(company_id));

-- invoice_financing_settlements -----------------------------------------------
DROP POLICY IF EXISTS invoice_financing_settlements_insert ON public.invoice_financing_settlements;
CREATE POLICY invoice_financing_settlements_insert ON public.invoice_financing_settlements FOR INSERT TO public
  WITH CHECK (user_can_write_company(company_id));

-- payment_initiations ---------------------------------------------------------
DROP POLICY IF EXISTS payment_initiations_insert ON public.payment_initiations;
CREATE POLICY payment_initiations_insert ON public.payment_initiations FOR INSERT TO public
  WITH CHECK (user_can_write_company(company_id));

DROP POLICY IF EXISTS payment_initiations_update ON public.payment_initiations;
CREATE POLICY payment_initiations_update ON public.payment_initiations FOR UPDATE TO public
  USING (user_can_write_company(company_id));

-- tax_declaration_audit_events ------------------------------------------------
DROP POLICY IF EXISTS tax_declaration_audit_events_insert ON public.tax_declaration_audit_events;
CREATE POLICY tax_declaration_audit_events_insert ON public.tax_declaration_audit_events FOR INSERT TO public
  WITH CHECK (user_can_write_company(company_id));

COMMIT;

NOTIFY pgrst, 'reload schema';
