-- =============================================================================
-- A rate limit that survives the process
--
-- `POST /api/extensions/ext/tic/bankid/start` guarded itself with a
-- module-level `Map<string, number>` of last-start timestamps per IP. That is
-- a per-instance counter: on Vercel every concurrent lambda gets its own empty
-- Map, and a cold start throws the whole thing away. An attacker fanning out
-- across instances sees no limit at all — and each start is a billable TIC
-- Identity session, so the failure mode is "someone else's invoice", not just
-- noise.
--
-- `lib/auth/rate-limit-http.ts` already provides a real sliding window on
-- Upstash, but it no-ops when UPSTASH_REDIS_REST_URL/TOKEN are absent, which is
-- the normal state for the Docker deployment. Removing the Map in favour of it
-- would have made the unlimited case the default rather than the exception.
--
-- Postgres is the one dependency every deployment has. This gives the app a
-- fixed-window counter there, so the durable limiter can fall back to the
-- database instead of to nothing.
--
-- Fixed window, not sliding: a sliding window needs one row per request, and
-- the point of this table is to be cheap enough to sit in front of an
-- unauthenticated endpoint. A fixed window admits at most 2x the configured
-- rate across a window boundary; for a 5-second BankID start cooldown that is
-- an acceptable trade, and the caller sees the exact window reset time so it
-- can report a truthful Retry-After.
--
-- The table holds no personal data: `identifier` is already truncated to a
-- /24 or /48 by `truncateIp()` before it reaches here, and rows are disposable.
--
-- pg-test: covered-by tests/pg/rate-limit-counters.pg.test.ts
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.rate_limit_counters (
  bucket          text        NOT NULL,
  identifier      text        NOT NULL,
  window_start    timestamptz NOT NULL,
  window_end      timestamptz NOT NULL,
  request_count   integer     NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket, identifier)
);

COMMENT ON TABLE public.rate_limit_counters IS
  'Fixed-window request counters for endpoints that must be limited even when '
  'Upstash is not configured. Not tenant data: no company_id, no personal data, '
  'rows are disposable. Written only by consume_rate_limit().';

-- Sweep index for the housekeeping delete below.
CREATE INDEX IF NOT EXISTS idx_rate_limit_counters_window_end
  ON public.rate_limit_counters (window_end);

ALTER TABLE public.rate_limit_counters ENABLE ROW LEVEL SECURITY;

-- No policies on purpose: RLS with zero policies denies every non-superuser
-- role. The only writer is the SECURITY DEFINER function below, and the only
-- reader is the same. anon/authenticated must never see another caller's
-- counter, and no application code has a reason to read this table directly.
REVOKE ALL ON TABLE public.rate_limit_counters FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- consume_rate_limit(bucket, identifier, max_requests, window_seconds)
--
-- Atomically counts one request against a fixed window and reports whether it
-- is allowed. Returns:
--
--   { "allowed": bool, "limit": int, "remaining": int, "reset_at": timestamptz }
--
-- `remaining` is what is left AFTER this request when allowed, and 0 when not.
-- A rejected request does NOT increment the counter, so a client hammering a
-- closed window cannot extend it.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consume_rate_limit(
  p_bucket          text,
  p_identifier      text,
  p_max_requests    integer,
  p_window_seconds  integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now          timestamptz := now();
  v_window_end   timestamptz;
  v_count        integer;
BEGIN
  IF p_bucket IS NULL OR btrim(p_bucket) = '' THEN
    RAISE EXCEPTION 'bucket is required' USING ERRCODE = '22023';
  END IF;
  IF p_identifier IS NULL OR btrim(p_identifier) = '' THEN
    RAISE EXCEPTION 'identifier is required' USING ERRCODE = '22023';
  END IF;
  IF p_max_requests IS NULL OR p_max_requests < 1 THEN
    RAISE EXCEPTION 'max_requests must be >= 1' USING ERRCODE = '22023';
  END IF;
  IF p_window_seconds IS NULL OR p_window_seconds < 1 THEN
    RAISE EXCEPTION 'window_seconds must be >= 1' USING ERRCODE = '22023';
  END IF;

  -- One statement so concurrent callers serialise on the primary key rather
  -- than racing between a SELECT and an UPDATE. Restarting an expired window
  -- and incrementing a live one are the same write.
  INSERT INTO public.rate_limit_counters AS c
    (bucket, identifier, window_start, window_end, request_count, updated_at)
  VALUES
    (p_bucket, p_identifier, v_now,
     v_now + make_interval(secs => p_window_seconds), 1, v_now)
  ON CONFLICT (bucket, identifier) DO UPDATE
    SET window_start  = CASE WHEN c.window_end <= v_now THEN v_now ELSE c.window_start END,
        window_end    = CASE WHEN c.window_end <= v_now
                             THEN v_now + make_interval(secs => p_window_seconds)
                             ELSE c.window_end END,
        -- Saturate one past the limit rather than counting freely: the row must
        -- not grow without bound while a client retries, but it still has to
        -- read as "over" — capping AT the limit would make the refusing case
        -- indistinguishable from the last allowed one.
        request_count = CASE WHEN c.window_end <= v_now THEN 1
                             WHEN c.request_count >= p_max_requests THEN p_max_requests + 1
                             ELSE c.request_count + 1 END,
        updated_at    = v_now
  RETURNING c.request_count, c.window_end INTO v_count, v_window_end;

  -- Opportunistic housekeeping: ~1 sweep per 1000 calls, bounded, so the table
  -- does not need a cron job to stay small.
  IF random() < 0.001 THEN
    DELETE FROM public.rate_limit_counters
     WHERE ctid IN (
       SELECT ctid FROM public.rate_limit_counters
        WHERE window_end < v_now - interval '1 hour'
        LIMIT 1000
     );
  END IF;

  RETURN jsonb_build_object(
    'allowed',   v_count <= p_max_requests,
    'limit',     p_max_requests,
    'remaining', greatest(0, p_max_requests - v_count),
    'reset_at',  v_window_end
  );
END;
$$;

REVOKE ALL ON FUNCTION public.consume_rate_limit(text,text,integer,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_rate_limit(text,text,integer,integer)
  TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
