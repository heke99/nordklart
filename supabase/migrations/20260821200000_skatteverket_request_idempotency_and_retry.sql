-- =============================================================================
-- Make a retried Skatteverket call traceable as one operation
--
-- `skatteverket_api_requests` records one row per HTTP attempt, keyed by a
-- per-attempt `correlation_id` (unique, and what `writeApiRequestEnd` matches
-- on to close the row). That is the right shape for an attempt log, and it is
-- all the table could express: there was no way to say "these three rows are
-- three tries at the same filing", and no field to hold when the next try is
-- due. So a retry — once retries exist at all, which they did not — would have
-- looked like three unrelated calls, and a half-finished filing would have been
-- indistinguishable from three separate ones.
--
-- Three columns fix that without disturbing the attempt-per-row model:
--
--   idempotency_key  groups the attempts of one logical operation
--   attempt_count    which attempt this row is, 1-based
--   next_retry_at    when the next attempt becomes due, NULL when the operation
--                    is finished or the failure is not retryable
--
-- The key is deliberately NOT unique. Skatteverket has no idempotency header,
-- so the key cannot be used to deduplicate at the provider — it exists so an
-- operator (and the retry policy) can see the chain. Uniqueness would also make
-- the second attempt fail to insert, which is exactly backwards.
--
-- pg-test: covered-by tests/pg/skatteverket-request-retry.pg.test.ts
-- =============================================================================

BEGIN;

ALTER TABLE public.skatteverket_api_requests
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz;

ALTER TABLE public.skatteverket_api_requests
  DROP CONSTRAINT IF EXISTS skatteverket_api_requests_attempt_count_check;
ALTER TABLE public.skatteverket_api_requests
  ADD CONSTRAINT skatteverket_api_requests_attempt_count_check
  CHECK (attempt_count >= 1);

-- A pending retry only makes sense for an attempt that failed.
ALTER TABLE public.skatteverket_api_requests
  DROP CONSTRAINT IF EXISTS skatteverket_api_requests_retry_requires_failure;
ALTER TABLE public.skatteverket_api_requests
  ADD CONSTRAINT skatteverket_api_requests_retry_requires_failure
  CHECK (next_retry_at IS NULL OR status = 'failed');

-- Reading a chain back: all attempts of one operation, in order.
CREATE INDEX IF NOT EXISTS skatteverket_api_requests_idempotency_idx
  ON public.skatteverket_api_requests (idempotency_key, attempt_count)
  WHERE idempotency_key IS NOT NULL;

-- Finding work that is due, without scanning the whole log.
CREATE INDEX IF NOT EXISTS skatteverket_api_requests_next_retry_idx
  ON public.skatteverket_api_requests (next_retry_at)
  WHERE next_retry_at IS NOT NULL;

COMMENT ON COLUMN public.skatteverket_api_requests.idempotency_key IS
  'Groups the attempts of one logical operation. Not unique: Skatteverket has '
  'no idempotency header, so this identifies the chain for operators and for '
  'the retry policy, it does not deduplicate at the provider.';
COMMENT ON COLUMN public.skatteverket_api_requests.attempt_count IS
  'Which attempt this row is, 1-based.';
COMMENT ON COLUMN public.skatteverket_api_requests.next_retry_at IS
  'When the next attempt becomes due. NULL once the operation is finished or '
  'the failure was judged not retryable.';

COMMIT;

NOTIFY pgrst, 'reload schema';
