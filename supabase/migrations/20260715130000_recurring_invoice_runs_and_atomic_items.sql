-- Recurring invoice hardening: DB-level run idempotency + atomic item replace.
--
-- 1. recurring_invoice_runs — one row per (schedule, run_date) attempt. The
--    daily cron INSERTs a claim row before spawning the invoice; the UNIQUE
--    index makes duplicate spawns for the same intended run date impossible
--    at the database level (the previous protection was an application-level
--    last_run_at CAS only). The table doubles as the audit/run-history the
--    schedule detail UI shows (latest run, invoice, warnings, errors).
--
--    Claim semantics:
--      - INSERT (schedule_id, run_date) → claim acquired, status 'running'.
--      - 23505 unique violation → another runner holds/held the claim:
--          status 'running'  → concurrent run in flight → skip
--          status 'succeeded'→ already ran → skip
--          status 'failed'   → previous attempt failed → retry may take over
--            via UPDATE ... WHERE status = 'failed' (CAS — exactly one
--            retryer wins).
--
-- 2. replace_recurring_schedule_items — atomic delete+insert of schedule
--    items. The previous PATCH implementation deleted and re-inserted in two
--    separate statements with a best-effort compensation insert; a failure
--    (or a concurrent cron read) could observe a schedule with zero items.
--
-- pg-test: covered-by tests/pg/recurring-invoice-runs.pg.test.ts

-- ============================================================
-- recurring_invoice_runs
-- ============================================================

CREATE TABLE public.recurring_invoice_runs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  schedule_id   UUID NOT NULL REFERENCES public.recurring_invoice_schedules(id) ON DELETE CASCADE,
  company_id    UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- The intended run date (the next_run_date the cron acted on), not the
  -- wall-clock time. Uniqueness on (schedule_id, run_date) is the duplicate
  -- guard.
  run_date      DATE NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
  invoice_id    UUID REFERENCES public.invoices(id) ON DELETE SET NULL,
  auto_sent     BOOLEAN NOT NULL DEFAULT false,
  -- Swedish warning when the run partially failed (e.g. invoice created but
  -- email/journal/archive failed). Mirrors schedules.last_run_warning but is
  -- kept per-run for history.
  warning       TEXT,
  error         TEXT,
  -- Cron item request id for log correlation.
  request_id    TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX recurring_invoice_runs_schedule_run_date_key
  ON public.recurring_invoice_runs (schedule_id, run_date);
CREATE INDEX idx_rir_company ON public.recurring_invoice_runs (company_id, started_at DESC);
CREATE INDEX idx_rir_schedule ON public.recurring_invoice_runs (schedule_id, started_at DESC);

ALTER TABLE public.recurring_invoice_runs ENABLE ROW LEVEL SECURITY;

-- Company members can read run history; only the service-role cron writes.
CREATE POLICY "recurring_invoice_runs_select" ON public.recurring_invoice_runs
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
-- No INSERT/UPDATE/DELETE policies: writes are service-role only (cron).

-- ============================================================
-- replace_recurring_schedule_items — atomic item replacement
-- ============================================================

CREATE OR REPLACE FUNCTION public.replace_recurring_schedule_items(
  p_schedule_id uuid,
  p_company_id uuid,
  p_items jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_can_write boolean := false;
BEGIN
  -- Tenant guard: the schedule must belong to the claimed company.
  IF NOT EXISTS (
    SELECT 1 FROM public.recurring_invoice_schedules s
    WHERE s.id = p_schedule_id AND s.company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'Schemat hittades inte.' USING ERRCODE = 'P0002';
  END IF;

  -- Write guard: service role, or a caller with write access to the company
  -- (viewer/read-only roles are rejected — same rule as the API layer).
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    SELECT ra.can_write INTO v_can_write
    FROM public.resolve_company_access(p_company_id) ra;
    IF NOT coalesce(v_can_write, false) THEN
      RAISE EXCEPTION 'Du har endast läsbehörighet i detta företag.' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Minst en fakturarad krävs.' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.recurring_invoice_schedule_items WHERE schedule_id = p_schedule_id;

  INSERT INTO public.recurring_invoice_schedule_items
    (schedule_id, sort_order, description, quantity, unit, unit_price, vat_rate)
  SELECT
    p_schedule_id,
    (ordinality - 1)::int,
    item->>'description',
    (item->>'quantity')::numeric,
    coalesce(nullif(item->>'unit', ''), 'st'),
    (item->>'unit_price')::numeric,
    nullif(item->>'vat_rate', '')::numeric
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(item, ordinality);
END;
$$;

REVOKE ALL ON FUNCTION public.replace_recurring_schedule_items(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.replace_recurring_schedule_items(uuid, uuid, jsonb) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
