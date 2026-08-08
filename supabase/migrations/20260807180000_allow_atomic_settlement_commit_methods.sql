-- Unbreak customer and supplier invoice settlement.
--
-- 20260801140000_production_financial_atomicity_and_billing_lifecycle.sql
-- introduced settle_customer_invoice() and settle_supplier_invoice(), which
-- commit the settlement voucher with:
--
--   commit_journal_entry(p_company_id, v_draft.id, 'atomic_customer_settlement', ...)
--   commit_journal_entry(p_company_id, v_draft.id, 'atomic_supplier_settlement', ...)
--
-- Neither value was added to journal_entries_commit_method_check. Every
-- successful settlement therefore aborts with
--   new row for relation "journal_entries" violates check constraint
--   "journal_entries_commit_method_check"
-- and the whole transaction rolls back, so no customer or supplier invoice can
-- be marked paid at all. Confirmed against the live database 2026-08-07: the
-- production constraint permits neither value while both functions pass them.
--
-- This was invisible to the test suite because the only pg-real coverage of the
-- settlement contract exercised the ROLLBACK path (an invalid settlement leaves
-- no idempotency residue). No test ever drove a settlement to success, so the
-- constraint violation on the happy path was never reached. That gap is closed
-- by lib/core/bookkeeping/__tests__/settlement-atomicity.pg.test.ts.
--
-- Same shape as the SIE reversal defect fixed in 20260807130000: a function and
-- the constraint governing its writes were introduced in the same migration and
-- still disagreed.
--
-- commit_method records HOW an entry was committed. An atomic settlement is its
-- own provenance class, distinct from a user acceptance or a migration, so the
-- values are added to the vocabulary rather than the call sites rewritten. This
-- widens a metadata CHECK only: balance, immutability, period locks and voucher
-- numbering are untouched.
--
-- pg-test: covered-by lib/core/bookkeeping/__tests__/settlement-atomicity.pg.test.ts

BEGIN;

ALTER TABLE public.journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_commit_method_check;

ALTER TABLE public.journal_entries
  ADD CONSTRAINT journal_entries_commit_method_check
  CHECK (
    commit_method IS NULL
    OR commit_method IN (
      'user_accept',
      'bulk_accept',
      'timing_ceiling',
      'migration',
      'legacy',
      'agent',
      'api_key',
      'automation',
      'sie_import_reversal',
      'atomic_customer_settlement',
      'atomic_supplier_settlement'
    )
  );

COMMIT;

NOTIFY pgrst, 'reload schema';
