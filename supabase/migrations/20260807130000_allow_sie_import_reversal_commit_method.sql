-- Unbreak SIE undo/replace.
--
-- public.__sie_reverse_import_entries() commits every reversal voucher with
--   commit_journal_entry(..., p_commit_method => 'sie_import_reversal', ...)
-- but journal_entries_commit_method_check never allowed that value. Every SIE
-- undo and every SIE replace therefore aborts with
--   new row for relation "journal_entries" violates check constraint
--   "journal_entries_commit_method_check"
-- and the whole transaction rolls back, so the import can be neither undone nor
-- replaced. Verified present in production on 2026-08-07 (the constraint and
-- the function disagree there exactly as they do in the repository).
--
-- The vocabulary describes HOW an entry was committed. A SIE undo/replace
-- reversal is its own provenance class and the calling code already treats it
-- as one, so the value is added rather than the call rewritten — that keeps the
-- distinction between an imported voucher ('migration') and the system-issued
-- storno that reverses it, and does not reinterpret any existing row.
--
-- This widens a metadata CHECK only. It touches no accounting invariant:
-- balance, immutability, period locks and voucher numbering are unchanged.
--
-- pg-test: covered-by lib/import/__tests__/sie-import-engine.pg.test.ts

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
      'sie_import_reversal'
    )
  );

COMMIT;

NOTIFY pgrst, 'reload schema';
