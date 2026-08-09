-- Allow commit_method = 'system', which __year_end_prior_result_transfer writes.
--
-- Third occurrence of the same defect class. A migration added a function that
-- commits a voucher with a commit_method value the CHECK constraint on
-- journal_entries does not permit, so the call fails with 23514 the moment it
-- runs. The two earlier ones were fixed in 20260807180000
-- (atomic_customer_settlement / atomic_supplier_settlement) and
-- 20260807130000 (sie_import_reversal).
--
--     PERFORM public.commit_journal_entry(
--       p_company_id, v_entry_id, 'system', 'prior-year-result-transfer',
--       'system', 'execute_year_end_closing');
--
-- Blast radius is narrow but not rare: __year_end_prior_result_transfer runs
-- only when the company is an aktiebolag, no transfer event exists yet for the
-- next period, AND the opening balance carries a non-zero balance on 2099. That
-- is exactly the SECOND consecutive year-end close of an AB — the ordinary
-- omföring of the previous year's result from 2099 to 2098 (balanserat
-- resultat). The first close of any company has no prior 2099 balance, which is
-- why every existing year-end test passed: the same success-path blind spot
-- that hid the two settlement incidents.
--
-- The constraint is widened rather than the writer changed. 'system' is a
-- truthful description of how that voucher was committed, and it is consistent
-- with the actor provenance the same call already records
-- (committed_actor_type = 'system', committed_actor_label =
-- 'execute_year_end_closing'). Redefining a large year-end function to relabel
-- one argument would restate a body this migration has no reason to touch, and
-- restating bodies is precisely how this class of regression keeps appearing.
--
-- The full value list is restated because a CHECK constraint cannot be extended
-- in place; every previously allowed value is carried forward unchanged.
--
-- pg-test: covered-by tests/pg/commit-method-provenance.pg.test.ts

BEGIN;

ALTER TABLE public.journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_commit_method_check;

ALTER TABLE public.journal_entries
  ADD CONSTRAINT journal_entries_commit_method_check
  CHECK (
    commit_method IS NULL
    OR commit_method = ANY (ARRAY[
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
      'atomic_supplier_settlement',
      'system'
    ])
  );

COMMIT;

NOTIFY pgrst, 'reload schema';
