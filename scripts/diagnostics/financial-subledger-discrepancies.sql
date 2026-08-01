-- Read-only. Run with service-role/database credentials after the migration.
-- No rows are changed.
SELECT *
FROM public.customer_subledger_discrepancies_v1
WHERE classification <> 'ok'
ORDER BY company_id, classification, invoice_id;

SELECT *
FROM public.supplier_subledger_discrepancies_v1
WHERE classification <> 'ok'
ORDER BY company_id, classification, supplier_invoice_id;

SELECT *
FROM public.cancelled_committed_journal_entry_inventory
ORDER BY company_id, fiscal_period_id, entry_date, voucher_series, voucher_number;
