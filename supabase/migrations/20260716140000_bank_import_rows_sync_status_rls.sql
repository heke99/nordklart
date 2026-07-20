-- Bank file import row-level status, sync status vocabulary, and viewer
-- write-hardening on bank/bookkeeping tables (revision items K01–K08, K10–K14).
--
--   * bank_file_imports: strict status CHECK incl. 'partial', persisted
--     import options (auto_categorize / skip_duplicates are now contract,
--     K01/K02), original-file archive path (K03) and row counters (K04).
--   * bank_file_import_rows: per-row status with a stable row key so a
--     partially failed file can be retried idempotently (K04).
--   * bank_sync_runs: extended status vocabulary (K12).
--   * RLS: viewers become read-only on bank data at the database level (K08)
--     — transactions, bank_connections, bank_file_imports, cash_accounts.
--
-- pg-test: covered-by tests/pg/bank-import-rows-rls.pg.test.ts

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. bank_file_imports hardening
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Normalize legacy free-text statuses before adding the CHECK.
  UPDATE public.bank_file_imports
     SET status = 'failed'
   WHERE status NOT IN ('pending', 'processing', 'partial', 'completed', 'failed');
END
$$;

ALTER TABLE public.bank_file_imports
  DROP CONSTRAINT IF EXISTS bank_file_imports_status_check;
ALTER TABLE public.bank_file_imports
  ADD CONSTRAINT bank_file_imports_status_check
  CHECK (status IN ('pending', 'processing', 'partial', 'completed', 'failed'));

ALTER TABLE public.bank_file_imports
  ADD COLUMN IF NOT EXISTS file_storage_path text,
  ADD COLUMN IF NOT EXISTS options jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS total_rows integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS imported_rows integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS duplicate_rows integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed_rows integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS settlement_account text;

COMMENT ON COLUMN public.bank_file_imports.options IS
  'Persisted import options (skip_duplicates, auto_categorize, …). The backend honors these; they are part of the import contract (K01/K02).';
COMMENT ON COLUMN public.bank_file_imports.file_storage_path IS
  'Storage path of the archived original file — execute works from this, never from a client-parsed list (K03).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Row-level status for idempotent retry (K04)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bank_file_import_rows (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id      uuid NOT NULL REFERENCES public.bank_file_imports(id) ON DELETE CASCADE,
  company_id     uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  row_index      integer NOT NULL,
  -- Stable canonical row key (the generated external_id): retrying the same
  -- file touches exactly the rows that are not yet imported.
  row_key        text NOT NULL,
  status         text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'imported', 'duplicate', 'failed')),
  error_message  text,
  transaction_id uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (import_id, row_key)
);

CREATE INDEX IF NOT EXISTS idx_bank_file_import_rows_import
  ON public.bank_file_import_rows (import_id, status);
CREATE INDEX IF NOT EXISTS idx_bank_file_import_rows_company
  ON public.bank_file_import_rows (company_id);

ALTER TABLE public.bank_file_import_rows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bank_file_import_rows_select ON public.bank_file_import_rows;
CREATE POLICY bank_file_import_rows_select ON public.bank_file_import_rows
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
DROP POLICY IF EXISTS bank_file_import_rows_insert ON public.bank_file_import_rows;
CREATE POLICY bank_file_import_rows_insert ON public.bank_file_import_rows
  FOR INSERT WITH CHECK (public.user_can_write_company(company_id));
DROP POLICY IF EXISTS bank_file_import_rows_update ON public.bank_file_import_rows;
CREATE POLICY bank_file_import_rows_update ON public.bank_file_import_rows
  FOR UPDATE USING (public.user_can_write_company(company_id))
  WITH CHECK (public.user_can_write_company(company_id));
DROP POLICY IF EXISTS bank_file_import_rows_delete ON public.bank_file_import_rows;
CREATE POLICY bank_file_import_rows_delete ON public.bank_file_import_rows
  FOR DELETE USING (public.user_can_write_company(company_id));

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. bank_sync_runs status vocabulary (K12)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.bank_sync_runs
  DROP CONSTRAINT IF EXISTS bank_sync_runs_status_check;
ALTER TABLE public.bank_sync_runs
  ADD CONSTRAINT bank_sync_runs_status_check
  CHECK (status IN ('running', 'success', 'partial', 'failed', 'auth_required', 'rate_limited'));

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Viewer write-hardening at the RLS layer (K08). One policy: viewers are
--    read-only. Same pattern as 20260715170000 for journal/invoice tables.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['transactions', 'bank_connections', 'bank_file_imports', 'cash_accounts'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_insert', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (public.user_can_write_company(company_id))',
      t || '_insert', t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_update', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE USING (public.user_can_write_company(company_id)) WITH CHECK (public.user_can_write_company(company_id))',
      t || '_update', t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_delete', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE USING (public.user_can_write_company(company_id))',
      t || '_delete', t);
  END LOOP;
END
$$;

NOTIFY pgrst, 'reload schema';
