-- Rättelse av fel från ett stängt räkenskapsår.
--
-- When an error in a closed year is found after its annual report was
-- adopted or filed, the closed year can no longer be reopened (the reopen
-- flow blocks with FILED_CORRECTION_FLOW_REQUIRED). The correction is then
-- booked as a new verifikation in the current open year (BFL 5 kap. 5 §:
-- corrections by a new entry showing when and by whom; posted entries stay
-- untouched). Under K2 and K1 the correction goes through the current
-- year's result; under K3 kap. 10 a material error may instead be corrected
-- against opening equity (fritt eget kapital, 209x).
--
-- The new source type marks those vouchers, with source_id = the closed
-- fiscal period the error belongs to, so the next annual report can
-- disclose them (K3 note "Rättelse av fel"). Validation of the lines lives
-- in lib/core/bookkeeping/prior-period-correction.ts.
--
-- pg-test: tests/pg/prior-period-correction-source.pg.test.ts

BEGIN;

ALTER TABLE public.journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_source_type_check;

ALTER TABLE public.journal_entries
  ADD CONSTRAINT journal_entries_source_type_check
  CHECK (source_type IN (
    'manual', 'bank_transaction', 'invoice_created',
    'invoice_paid', 'invoice_cash_payment', 'credit_note', 'salary_payment',
    'opening_balance', 'year_end', 'year_end_accrual', 'year_end_depreciation',
    'year_end_fx_revaluation', 'year_end_tax_adjustment', 'year_end_disposition',
    'year_end_deferred_tax', 'year_end_closing',
    'storno', 'correction', 'import', 'system',
    'inbox_item',
    'supplier_invoice_registered', 'supplier_invoice_paid',
    'supplier_invoice_cash_payment', 'supplier_credit_note',
    'currency_revaluation', 'currency_revaluation_reversal',
    'supplier_invoice_privately_paid',
    'reminder_fee',
    'accrual',
    'result_appropriation',
    'dividend_decision',
    'dividend_payment',
    'year_end_inventory',
    'prior_period_correction'
  )) NOT VALID;

ALTER TABLE public.journal_entries
  VALIDATE CONSTRAINT journal_entries_source_type_check;

CREATE INDEX IF NOT EXISTS idx_journal_entries_prior_period_correction
  ON public.journal_entries (company_id, source_id)
  WHERE source_type = 'prior_period_correction';

COMMIT;

NOTIFY pgrst, 'reload schema';
