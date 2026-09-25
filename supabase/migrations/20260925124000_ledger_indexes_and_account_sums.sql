-- Ledger performance: composite indexes for the per-company queries every
-- report and list runs, and an aggregate for account sums.
--
-- Reports (råbalans, balans- och resultaträkning, INK2, NE) fetched every
-- voucher line of a period to the application — 1 000 rows per round trip —
-- and summed per account in JavaScript. account_period_sums() returns one
-- row per account instead, computed in Postgres over the covering index below.
--
-- The function is SECURITY INVOKER: RLS on journal_entries and
-- journal_entry_lines applies to the caller exactly as for the row queries it
-- replaces, and it additionally requires membership in the company.
--
-- pg-test: tests/pg/account-period-sums.pg.test.ts

BEGIN;

CREATE INDEX IF NOT EXISTS idx_journal_entries_company_date
  ON public.journal_entries (company_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_journal_entries_company_period_status
  ON public.journal_entries (company_id, fiscal_period_id, status);
CREATE INDEX IF NOT EXISTS idx_journal_entries_company_source
  ON public.journal_entries (company_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_journal_entry_lines_entry_account_amounts
  ON public.journal_entry_lines (journal_entry_id, account_number) INCLUDE (debit_amount, credit_amount);
CREATE INDEX IF NOT EXISTS idx_transactions_company_date_all
  ON public.transactions (company_id, date);
CREATE INDEX IF NOT EXISTS idx_invoices_company_invoice_date
  ON public.invoices (company_id, invoice_date);
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_company_status_due
  ON public.supplier_invoices (company_id, status, due_date);

CREATE OR REPLACE FUNCTION public.account_period_sums(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_from_date date DEFAULT NULL,
  p_to_date date DEFAULT NULL,
  p_exclude_entry_id uuid DEFAULT NULL,
  p_exclude_source_types text[] DEFAULT NULL
)
RETURNS TABLE (account_number text, debit numeric, credit numeric)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.user_can_access_company_v2(p_company_id) THEN
    RAISE EXCEPTION 'no access to company' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT l.account_number, sum(l.debit_amount)::numeric, sum(l.credit_amount)::numeric
    FROM public.journal_entries je
    JOIN public.journal_entry_lines l ON l.journal_entry_id = je.id
   WHERE je.company_id = p_company_id
     AND je.fiscal_period_id = p_fiscal_period_id
     AND je.status IN ('posted', 'reversed')
     AND (p_from_date IS NULL OR je.entry_date >= p_from_date)
     AND (p_to_date IS NULL OR je.entry_date <= p_to_date)
     AND (p_exclude_entry_id IS NULL OR je.id <> p_exclude_entry_id)
     AND (p_exclude_source_types IS NULL OR je.source_type IS NULL OR je.source_type <> ALL (p_exclude_source_types))
   GROUP BY l.account_number;
END;
$$;

REVOKE ALL ON FUNCTION public.account_period_sums(uuid, uuid, date, date, uuid, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.account_period_sums(uuid, uuid, date, date, uuid, text[]) TO authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
