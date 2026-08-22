WITH staged AS (
  INSERT INTO public.nordklart_deploy_staging (file, idx, body, expected_sha)
  VALUES ('20260821130000_customer_personal_number_encrypted_at_rest.sql', 1, $nk_stage_0$-- =============================================================================
-- customers.personal_number: encrypted at rest, and actually saved
--
-- Two defects, one column.
--
-- 1. NOTHING EVER WROTE IT. CustomerForm collects a personnummer for private
--    customers (ROT/RUT), CreateCustomerSchema validates it — and both
--    POST /api/customers and PATCH /api/customers/[id] build their payload
--    field by field and simply never include it. The user types the number,
--    saves, gets no error, and the value is gone. The column has been NULL for
--    every row since 20260522130000 added it.
--
-- 2. Had it been wired up, it would have stored a personnummer in PLAINTEXT
--    with only a format CHECK — while the same data class is AES-256-GCM
--    encrypted for employees (lib/salary/personnummer.ts). A registry of
--    identified natural persons in clear text is exactly what GDPR art. 32
--    asks you not to keep.
--
-- So it is wired up encrypted from the start:
--   personal_number_enc   — AES-256-GCM ciphertext (PERSONNUMMER_ENCRYPTION_KEY)
--   personal_number_last4 — the last four digits, so lists, search and CSV can
--                           identify a customer without any surface holding the
--                           full number.
--
-- The plaintext column is dropped, but only after proving it is empty. If a
-- deployment DOES have values, this migration refuses rather than destroying
-- them: encryption needs the application key, which PostgreSQL does not have,
-- so a backfill cannot happen inside a migration.
--
-- pg-test: covered-by tests/pg/customer-personal-number.pg.test.ts
-- =============================================================================

BEGIN;

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS personal_number_enc TEXT,
  ADD COLUMN IF NOT EXISTS personal_number_last4 TEXT;

ALTER TABLE public.customers
  DROP CONSTRAINT IF EXISTS customers_personal_number_last4_check;
ALTER TABLE public.customers
  ADD CONSTRAINT customers_personal_number_last4_check
  CHECK (personal_number_last4 IS NULL OR personal_number_last4 ~ '^\d{4}$');

-- Ciphertext and mask travel together — a row with one and not the other means
-- a half-applied write, and there is no correct way to render it.
ALTER TABLE public.customers
  DROP CONSTRAINT IF EXISTS customers_personal_number_pair_check;
ALTER TABLE public.customers
  ADD CONSTRAINT customers_personal_number_pair_check
  CHECK ((personal_number_enc IS NULL) = (personal_number_last4 IS NULL));

DO $$
DECLARE
  v_plaintext_rows bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'customers'
      AND column_name = 'personal_number'
  ) THEN
    RETURN; -- already migrated
  END IF;

  EXECUTE 'SELECT count(*) FROM public.customers WHERE personal_number IS NOT NULL'
    INTO v_plaintext_rows;

  IF v_plaintext_rows > 0 THEN
    RAISE EXCEPTION
      'customers.personal_number holds % plaintext row(s). Run scripts/backfill-customer-personal-number.ts (it has the encryption key; PostgreSQL does not) and re-run this migration.',
      v_plaintext_rows
      USING ERRCODE = 'P0001';
  END IF;

  ALTER TABLE public.customers DROP CONSTRAINT IF EXISTS customers_personal_number_check;
  ALTER TABLE public.customers DROP COLUMN personal_number;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
$nk_stage_0$, 'a05e2225eaeb190fb79f2e37972b4f9c144faa42449e73681e72aea720897102')
  ON CONFLICT (file, idx) DO UPDATE
    SET body = EXCLUDED.body, expected_sha = EXCLUDED.expected_sha, staged_at = now()
  RETURNING idx, body, expected_sha
)
SELECT idx,
       encode(sha256(convert_to(body, 'UTF8')), 'hex') = expected_sha AS ok,
       octet_length(body) AS bytes
FROM staged;
