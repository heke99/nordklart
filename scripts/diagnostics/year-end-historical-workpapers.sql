-- Read-only diagnostics for canonical historical year-end workpapers.
-- Run with psql after migrations:
--   psql "$SUPABASE_DB_URL" -f scripts/diagnostics/year-end-historical-workpapers.sql

\pset pager off

-- Non-zero ledger balances where the historical support register is unknown.
SELECT
  c.name AS company_name,
  fp.name AS fiscal_period,
  wp.category,
  wp.imported_amount,
  wp.status,
  wp.source_sie_import_id,
  wp.account_numbers
FROM public.year_end_historical_workpapers wp
JOIN public.companies c ON c.id = wp.company_id
JOIN public.fiscal_periods fp ON fp.id = wp.fiscal_period_id
WHERE abs(coalesce(wp.imported_amount, 0)) >= 0.01
  AND NOT wp.support_register_available
  AND wp.status = 'imported_from_sie'
ORDER BY c.name, fp.period_start, wp.category;

-- Reimport conflicts that require an explicit keep/replace decision.
SELECT
  c.name AS company_name,
  fp.name AS fiscal_period,
  wp.category,
  wp.current_amount AS previously_approved_amount,
  wp.pending_imported_amount,
  wp.source_sie_import_id AS previous_import_id,
  wp.pending_sie_import_id,
  wp.conflict_detected_at
FROM public.year_end_historical_workpapers wp
JOIN public.companies c ON c.id = wp.company_id
JOIN public.fiscal_periods fp ON fp.id = wp.fiscal_period_id
WHERE wp.pending_sie_import_id IS NOT NULL
ORDER BY wp.conflict_detected_at DESC;

-- Real differences: two explicit values differ. Missing support is never here.
SELECT
  c.name AS company_name,
  fp.name AS fiscal_period,
  wp.category,
  wp.imported_amount AS ledger_amount,
  wp.current_amount AS workpaper_amount,
  wp.actual_difference,
  wp.status,
  wp.comment
FROM public.year_end_historical_workpapers wp
JOIN public.companies c ON c.id = wp.company_id
JOIN public.fiscal_periods fp ON fp.id = wp.fiscal_period_id
WHERE wp.status IN ('actual_difference', 'blocking_accounting_error')
ORDER BY abs(wp.actual_difference) DESC NULLS LAST;

-- Missing import provenance or inconsistent accepted statuses.
SELECT
  c.name AS company_name,
  fp.name AS fiscal_period,
  wp.category,
  wp.status,
  wp.source_type,
  wp.source_sie_import_id,
  wp.imported_amount,
  wp.current_amount,
  wp.actual_difference
FROM public.year_end_historical_workpapers wp
JOIN public.companies c ON c.id = wp.company_id
JOIN public.fiscal_periods fp ON fp.id = wp.fiscal_period_id
WHERE (
    wp.source_type IN ('sie_ledger', 'manual_confirmation')
    AND wp.source_sie_import_id IS NULL
  )
  OR (
    wp.status IN ('automatically_reconciled', 'sie_balance_accepted')
    AND abs(coalesce(wp.actual_difference, 0)) >= 0.01
  )
ORDER BY c.name, fp.period_start, wp.category;

-- Defensive duplicate check (the unique constraint should keep this empty).
SELECT
  company_id,
  fiscal_period_id,
  category,
  count(*) AS duplicate_count
FROM public.year_end_historical_workpapers
GROUP BY company_id, fiscal_period_id, category
HAVING count(*) > 1;

-- Current canonical controls and their route-relevant workpaper metadata.
SELECT
  fp.company_id,
  fp.id AS fiscal_period_id,
  status.control_code,
  status.control_category,
  status.status,
  status.ledger_amount,
  status.supporting_register_amount,
  status.difference,
  status.is_blocking,
  status.metadata->>'workpaper_id' AS workpaper_id,
  status.metadata->>'requires_confirmation' AS requires_confirmation,
  status.metadata->>'requires_accounting_correction' AS requires_accounting_correction
FROM public.fiscal_periods fp
CROSS JOIN LATERAL public.year_end_control_status(fp.company_id, fp.id) status
WHERE NOT fp.is_closed
ORDER BY fp.company_id, fp.period_start, status.control_category;
