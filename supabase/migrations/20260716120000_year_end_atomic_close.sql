-- Atomic year-end closing (revision items B01, B02, B03, B04, B05, B08, B09, B10).
--
-- Replaces the multi-step client-orchestrated year-end flow (readiness check →
-- currency revaluation → closing entry → lock → close → next period → IB →
-- continuity, each committed separately with "best effort" storno rollback)
-- with a single SECURITY DEFINER RPC that performs the whole close inside one
-- database transaction protected by an advisory lock. A close now ends in
-- exactly one of two states: fully open (transaction rolled back) or fully
-- closed (closing entry + lock + close + next period + IB + continuity all
-- committed together).
--
-- New objects:
--   * year_end_runs                — bokslut state machine (B09/B10)
--   * currency_revaluation_runs    — idempotent FX revaluation snapshot (B05)
--   * currency_revaluation_items   — per-invoice FX snapshot (B06/B07/A08)
--   * unique partial indexes       — DB guard against double closing entry,
--                                    double IB and double posted revaluation
--   * year_end_db_blockers()       — readiness re-checked INSIDE the locked
--                                    transaction (B03), failing closed (B04)
--   * post_currency_revaluation()  — shared idempotent FX posting (B05/B08)
--   * execute_year_end_closing()   — the atomic close RPC (B01/B02/B09)
--
-- pg-test: covered-by lib/core/bookkeeping/__tests__/year-end-atomic-close.pg.test.ts

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. source_type for deterministic FX reversal entries (B08). The reversal in
--    period N+1 must not collide with period N+1's own future revaluation
--    (unique index below), so it gets its own source_type.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_source_type_check;
ALTER TABLE public.journal_entries
  ADD CONSTRAINT journal_entries_source_type_check CHECK (source_type = ANY (ARRAY[
    'manual'::text, 'bank_transaction'::text, 'invoice_created'::text,
    'invoice_paid'::text, 'invoice_cash_payment'::text, 'credit_note'::text,
    'salary_payment'::text, 'opening_balance'::text, 'year_end'::text,
    'storno'::text, 'correction'::text, 'import'::text, 'system'::text,
    'inbox_item'::text, 'supplier_invoice_registered'::text,
    'supplier_invoice_paid'::text, 'supplier_invoice_cash_payment'::text,
    'supplier_credit_note'::text, 'currency_revaluation'::text,
    'currency_revaluation_reversal'::text,
    'supplier_invoice_privately_paid'::text, 'reminder_fee'::text,
    'accrual'::text, 'result_appropriation'::text
  ]));

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. year_end_runs — the bokslut state machine (B09, B10).
--
-- The atomic RPC only ever COMMITS a run in status 'closed' (anything else is
-- rolled back with the whole close). The API layer records 'failed' runs after
-- catching an RPC error so the UI can show and recover from failed attempts.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.year_end_runs (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id          uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE CASCADE,
  status                    text NOT NULL DEFAULT 'closing'
    CHECK (status IN ('validating', 'closing', 'closed', 'failed', 'superseded')),
  idempotency_key           text NOT NULL,
  error_message             text,
  closing_entry_id          uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  opening_balance_entry_id  uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  revaluation_entry_id      uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  revaluation_reversal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  next_period_id            uuid REFERENCES public.fiscal_periods(id) ON DELETE SET NULL,
  created_by                uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  started_at                timestamptz NOT NULL DEFAULT now(),
  finished_at               timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now()
);

-- Exactly one successful close per period, ever.
CREATE UNIQUE INDEX IF NOT EXISTS year_end_runs_one_closed_per_period
  ON public.year_end_runs (company_id, fiscal_period_id)
  WHERE status = 'closed';

-- Idempotency: the same (period, key) resolves to the same run.
CREATE UNIQUE INDEX IF NOT EXISTS year_end_runs_idempotency
  ON public.year_end_runs (company_id, fiscal_period_id, idempotency_key)
  WHERE status IN ('closing', 'closed');

CREATE INDEX IF NOT EXISTS idx_year_end_runs_period
  ON public.year_end_runs (company_id, fiscal_period_id, created_at DESC);

ALTER TABLE public.year_end_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS year_end_runs_select ON public.year_end_runs;
CREATE POLICY year_end_runs_select ON public.year_end_runs
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

-- Writes only through the RPC / API layer (write capability enforced there);
-- direct PostgREST writes require write capability.
DROP POLICY IF EXISTS year_end_runs_insert ON public.year_end_runs;
CREATE POLICY year_end_runs_insert ON public.year_end_runs
  FOR INSERT WITH CHECK (public.user_can_write_company(company_id));
DROP POLICY IF EXISTS year_end_runs_update ON public.year_end_runs;
CREATE POLICY year_end_runs_update ON public.year_end_runs
  FOR UPDATE USING (public.user_can_write_company(company_id))
  WITH CHECK (public.user_can_write_company(company_id));

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Currency revaluation snapshot (B05, B06, B07, B08, A08).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.currency_revaluation_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id    uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE CASCADE,
  balance_date        date NOT NULL,
  -- Deterministic hash over (company, period, balance date, currency rates,
  -- open item snapshot). Same inputs ⇒ same key ⇒ idempotent re-run (B05).
  snapshot_key        text NOT NULL,
  status              text NOT NULL DEFAULT 'posted'
    CHECK (status IN ('posted', 'replaced', 'reversed')),
  entry_id            uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  reversal_entry_id   uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  created_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- At most one ACTIVE revaluation per period (replace = mark old 'replaced').
CREATE UNIQUE INDEX IF NOT EXISTS currency_revaluation_runs_one_posted
  ON public.currency_revaluation_runs (company_id, fiscal_period_id)
  WHERE status = 'posted';

CREATE INDEX IF NOT EXISTS idx_currency_revaluation_runs_period
  ON public.currency_revaluation_runs (company_id, fiscal_period_id);

CREATE TABLE IF NOT EXISTS public.currency_revaluation_items (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                   uuid NOT NULL REFERENCES public.currency_revaluation_runs(id) ON DELETE CASCADE,
  company_id               uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  invoice_id               uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  supplier_invoice_id      uuid REFERENCES public.supplier_invoices(id) ON DELETE SET NULL,
  currency                 text NOT NULL,
  -- Open amount AT THE BALANCE DATE (historical reconstruction, B06/B07),
  -- not the invoice total and not the amount open "now".
  open_amount_currency     numeric(14,2) NOT NULL,
  open_amount_sek_original numeric(14,2) NOT NULL,
  rate_original            numeric(14,6) NOT NULL,
  rate_closing             numeric(14,6) NOT NULL,
  unrealized_diff_sek      numeric(14,2) NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (invoice_id IS NOT NULL OR supplier_invoice_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_currency_revaluation_items_run
  ON public.currency_revaluation_items (run_id);
CREATE INDEX IF NOT EXISTS idx_currency_revaluation_items_invoice
  ON public.currency_revaluation_items (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_currency_revaluation_items_supplier_invoice
  ON public.currency_revaluation_items (supplier_invoice_id) WHERE supplier_invoice_id IS NOT NULL;

ALTER TABLE public.currency_revaluation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.currency_revaluation_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS currency_revaluation_runs_select ON public.currency_revaluation_runs;
CREATE POLICY currency_revaluation_runs_select ON public.currency_revaluation_runs
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
DROP POLICY IF EXISTS currency_revaluation_items_select ON public.currency_revaluation_items;
CREATE POLICY currency_revaluation_items_select ON public.currency_revaluation_items
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
-- No INSERT/UPDATE/DELETE policies: rows are written exclusively by the
-- SECURITY DEFINER RPCs below.

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. DB-level uniqueness guards (B09): double closing entries, double IB and
--    double posted revaluations become impossible even if the API layer is
--    bypassed. Pre-check with a targeted error so incompatible legacy data
--    fails loudly and precisely rather than with a generic index error.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_dup record;
BEGIN
  FOR v_dup IN
    SELECT company_id, fiscal_period_id, source_type, count(*) AS n
    FROM public.journal_entries
    WHERE status = 'posted'
      AND source_type IN ('year_end', 'opening_balance', 'currency_revaluation')
    GROUP BY 1, 2, 3
    HAVING count(*) > 1
  LOOP
    RAISE EXCEPTION
      'Migration blocked: company % period % has % posted % entries. '
      'Reverse the duplicates before applying this migration.',
      v_dup.company_id, v_dup.fiscal_period_id, v_dup.n, v_dup.source_type;
  END LOOP;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_one_year_end_per_period
  ON public.journal_entries (company_id, fiscal_period_id)
  WHERE source_type = 'year_end' AND status = 'posted';

CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_one_opening_balance_per_period
  ON public.journal_entries (company_id, fiscal_period_id)
  WHERE source_type = 'opening_balance' AND status = 'posted';

CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_one_currency_revaluation_per_period
  ON public.journal_entries (company_id, fiscal_period_id)
  WHERE source_type = 'currency_revaluation' AND status = 'posted';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Internal helper: post a balanced journal entry (draft → posted) with the
--    exact same voucher-sequence semantics as commit_journal_entry. Internal
--    only — EXECUTE is revoked from every client role; SECURITY DEFINER
--    callers (owned by the migration role) invoke it directly.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.__ye_post_entry(
  p_company_id uuid,
  p_user_id uuid,
  p_fiscal_period_id uuid,
  p_entry_date date,
  p_description text,
  p_source_type text,
  p_series text,
  p_lines jsonb,
  p_reverses_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_entry_id uuid;
  v_line jsonb;
  v_total_debit numeric := 0;
  v_total_credit numeric := 0;
  v_next integer;
BEGIN
  IF p_lines IS NULL OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'YE_EMPTY_ENTRY: refusing to post entry "%" without lines', p_description;
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    IF (v_line->>'account_number') IS NULL THEN
      RAISE EXCEPTION 'YE_INVALID_LINE: line without account_number in "%"', p_description;
    END IF;
    IF COALESCE((v_line->>'debit_amount')::numeric, 0) < 0
       OR COALESCE((v_line->>'credit_amount')::numeric, 0) < 0 THEN
      RAISE EXCEPTION 'YE_INVALID_LINE: negative amount on account % in "%"',
        v_line->>'account_number', p_description;
    END IF;
    v_total_debit  := v_total_debit  + COALESCE((v_line->>'debit_amount')::numeric, 0);
    v_total_credit := v_total_credit + COALESCE((v_line->>'credit_amount')::numeric, 0);
  END LOOP;

  IF round(v_total_debit, 2) <> round(v_total_credit, 2) OR round(v_total_debit, 2) = 0 THEN
    RAISE EXCEPTION 'YE_UNBALANCED: entry "%" does not balance (debit=%, credit=%)',
      p_description, v_total_debit, v_total_credit;
  END IF;

  INSERT INTO public.journal_entries
    (company_id, user_id, fiscal_period_id, voucher_number, voucher_series,
     entry_date, description, source_type, status, created_via, reverses_id)
  VALUES
    (p_company_id, p_user_id, p_fiscal_period_id, 0, p_series,
     p_entry_date, p_description, p_source_type, 'draft', 'system', p_reverses_id)
  RETURNING id INTO v_entry_id;

  INSERT INTO public.journal_entry_lines
    (journal_entry_id, account_number, debit_amount, credit_amount, line_description)
  SELECT
    v_entry_id,
    l->>'account_number',
    round(COALESCE((l->>'debit_amount')::numeric, 0), 2),
    round(COALESCE((l->>'credit_amount')::numeric, 0), 2),
    l->>'line_description'
  FROM jsonb_array_elements(p_lines) l;

  -- Same voucher numbering as commit_journal_entry.
  INSERT INTO public.voucher_sequences (company_id, user_id, fiscal_period_id, voucher_series, last_number)
  VALUES (p_company_id, p_user_id, p_fiscal_period_id, p_series, 1)
  ON CONFLICT (company_id, fiscal_period_id, voucher_series)
  DO UPDATE SET
    last_number = public.voucher_sequences.last_number + 1,
    updated_at = now()
  RETURNING last_number INTO v_next;

  UPDATE public.journal_entries
  SET voucher_number = v_next, status = 'posted'
  WHERE id = v_entry_id AND company_id = p_company_id;

  RETURN v_entry_id;
END;
$$;

REVOKE ALL ON FUNCTION public.__ye_post_entry(uuid, uuid, uuid, date, text, text, text, jsonb, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.__ye_post_entry(uuid, uuid, uuid, date, text, text, text, jsonb, uuid) FROM anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. year_end_db_blockers — readiness computed IN the database so the atomic
--    close can re-verify inside its locked transaction (B03). Every check that
--    cannot complete raises (fail closed, B04) rather than returning an empty
--    result. Scoped to the fiscal period (B11): counts are exact, not capped.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.year_end_db_blockers(
  p_company_id uuid,
  p_fiscal_period_id uuid
) RETURNS TABLE (code text, message text, detail_count integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_period record;
  v_today date := (now() AT TIME ZONE 'Europe/Stockholm')::date;
  v_count integer;
  v_series record;
  v_gap record;
  v_seq record;
  v_imbalance numeric;
  v_next_period record;
  v_asset record;
  v_is_k3 boolean;
BEGIN
  SELECT * INTO v_period
  FROM public.fiscal_periods
  WHERE id = p_fiscal_period_id AND company_id = p_company_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'period_not_found'::text, 'Räkenskapsperioden hittades inte.'::text, 0;
    RETURN;
  END IF;

  IF v_period.period_end > v_today THEN
    RETURN QUERY SELECT 'period_not_ended'::text,
      'Räkenskapsperioden har inte avslutats ännu (ÅRL 2:1).'::text, 0;
  END IF;

  IF v_period.is_closed THEN
    RETURN QUERY SELECT 'period_already_closed'::text, 'Perioden är redan stängd.'::text, 0;
  END IF;

  IF v_period.closing_entry_id IS NOT NULL THEN
    RETURN QUERY SELECT 'closing_entry_exists'::text,
      'Bokslutsverifikation finns redan för perioden.'::text, 0;
  END IF;

  -- Draft entries in the period.
  SELECT count(*)::integer INTO v_count
  FROM public.journal_entries
  WHERE company_id = p_company_id
    AND fiscal_period_id = p_fiscal_period_id
    AND status = 'draft';
  IF v_count > 0 THEN
    RETURN QUERY SELECT 'draft_entries'::text,
      format('%s utkast till verifikationer måste bokföras eller tas bort.', v_count), v_count;
  END IF;

  -- Unexplained voucher gaps per series (BFNAR 2013:2).
  FOR v_series IN
    SELECT DISTINCT voucher_series
    FROM public.voucher_sequences
    WHERE company_id = p_company_id AND fiscal_period_id = p_fiscal_period_id
  LOOP
    FOR v_gap IN
      SELECT g.gap_start, g.gap_end
      FROM public.detect_voucher_gaps(p_company_id, p_fiscal_period_id, v_series.voucher_series) g
      WHERE NOT EXISTS (
        SELECT 1 FROM public.voucher_gap_explanations e
        WHERE e.company_id = p_company_id
          AND e.fiscal_period_id = p_fiscal_period_id
          AND e.voucher_series = v_series.voucher_series
          AND e.gap_start = g.gap_start
          AND e.gap_end = g.gap_end
      )
    LOOP
      RETURN QUERY SELECT 'unexplained_voucher_gap'::text,
        format('Odokumenterat verifikationsnummergap i serie %s: %s–%s.',
               v_series.voucher_series, v_gap.gap_start, v_gap.gap_end), 1;
    END LOOP;
  END LOOP;

  -- Sequence counter integrity.
  FOR v_seq IN
    SELECT vs.voucher_series, vs.last_number,
           COALESCE((SELECT max(je.voucher_number) FROM public.journal_entries je
                     WHERE je.company_id = p_company_id
                       AND je.fiscal_period_id = p_fiscal_period_id
                       AND je.voucher_series = vs.voucher_series
                       AND je.status <> 'draft'), 0) AS actual_max
    FROM public.voucher_sequences vs
    WHERE vs.company_id = p_company_id AND vs.fiscal_period_id = p_fiscal_period_id
  LOOP
    IF v_seq.last_number < v_seq.actual_max THEN
      RETURN QUERY SELECT 'sequence_integrity'::text,
        format('Verifikationsräknaren i serie %s (%s) ligger efter högsta verifikation (%s).',
               v_seq.voucher_series, v_seq.last_number, v_seq.actual_max), 1;
    END IF;
  END LOOP;

  -- Trial balance imbalance across the period.
  SELECT COALESCE(round(sum(l.debit_amount - l.credit_amount), 2), 0) INTO v_imbalance
  FROM public.journal_entry_lines l
  JOIN public.journal_entries e ON e.id = l.journal_entry_id
  WHERE e.company_id = p_company_id
    AND e.fiscal_period_id = p_fiscal_period_id
    AND e.status IN ('posted', 'reversed');
  IF abs(v_imbalance) > 0.005 THEN
    RETURN QUERY SELECT 'trial_balance_imbalance'::text,
      format('Råbalansen balanserar inte: differens %s kr.', v_imbalance), 0;
  END IF;

  -- Pending operations (staged bookings) for the company.
  SELECT count(*)::integer INTO v_count
  FROM public.pending_operations
  WHERE company_id = p_company_id AND status IN ('pending', 'committing');
  IF v_count > 0 THEN
    RETURN QUERY SELECT 'pending_operations'::text,
      format('%s väntande åtgärder måste godkännas eller avvisas innan bokslut.', v_count), v_count;
  END IF;

  -- Unfinished SIE imports overlapping the period.
  SELECT count(*)::integer INTO v_count
  FROM public.sie_imports si
  WHERE si.company_id = p_company_id
    AND si.status IN ('pending', 'mapped', 'validating', 'importing', 'partial', 'failed')
    AND (si.fiscal_year_end IS NULL OR si.fiscal_year_end >= v_period.period_start)
    AND (si.fiscal_year_start IS NULL OR si.fiscal_year_start <= v_period.period_end);
  IF v_count > 0 THEN
    RETURN QUERY SELECT 'unfinished_sie_imports'::text,
      format('%s SIE-import(er) för perioden är inte slutförda. Slutför eller ångra dem innan bokslut.', v_count), v_count;
  END IF;

  -- Unbooked bank transactions in the period (BFL 5 kap).
  SELECT count(*)::integer INTO v_count
  FROM public.transactions t
  WHERE t.company_id = p_company_id
    AND t.date >= v_period.period_start
    AND t.date <= v_period.period_end
    AND t.journal_entry_id IS NULL
    AND t.invoice_id IS NULL
    AND t.supplier_invoice_id IS NULL
    AND COALESCE(t.is_ignored, false) = false;
  IF v_count > 0 THEN
    RETURN QUERY SELECT 'unbooked_bank_transactions'::text,
      format('%s banktransaktioner i perioden är varken bokförda, matchade eller ignorerade.', v_count), v_count;
  END IF;

  -- Prior-period continuity failure recorded on this period.
  IF v_period.continuity_verified = false THEN
    RETURN QUERY SELECT 'continuity_failed'::text,
      'IB/UB-kontinuitetskontrollen för perioden har misslyckats — åtgärda differenserna innan bokslut.'::text, 0;
  END IF;

  -- Next period already has opening balances posted.
  SELECT fp.* INTO v_next_period
  FROM public.fiscal_periods fp
  WHERE fp.company_id = p_company_id
    AND fp.period_start > v_period.period_end
  ORDER BY fp.period_start ASC
  LIMIT 1;
  IF FOUND AND v_next_period.opening_balance_entry_id IS NOT NULL THEN
    RETURN QUERY SELECT 'next_period_has_ob'::text,
      'Nästa räkenskapsperiod har redan ingående balanser bokförda.'::text, 0;
  END IF;

  -- Asset readiness: buildings without mark/byggnad split, K3 buildings
  -- without component analysis, active assets without a depreciation
  -- schedule/booking for the period.
  SELECT (c.accounting_framework = 'k3') INTO v_is_k3
  FROM public.companies c WHERE c.id = p_company_id;

  FOR v_asset IN
    SELECT a.id, a.name, a.category, a.land_value, a.building_value, a.k3_components
    FROM public.assets a
    WHERE a.company_id = p_company_id
      AND (a.acquisition_date IS NULL OR a.acquisition_date <= v_period.period_end)
      AND (a.disposed_at IS NULL OR a.disposed_at >= v_period.period_end)
  LOOP
    IF v_asset.category = 'building'
       AND COALESCE(v_asset.land_value, 0) <= 0
       AND COALESCE(v_asset.building_value, 0) <= 0 THEN
      RETURN QUERY SELECT 'asset_building_split_missing'::text,
        format('Tillgången "%s" är byggnad/fastighet men saknar fördelning mellan mark och byggnad.', v_asset.name), 1;
    END IF;
    IF v_asset.category = 'building' AND COALESCE(v_is_k3, false)
       AND (v_asset.k3_components IS NULL OR jsonb_typeof(v_asset.k3_components) <> 'array'
            OR jsonb_array_length(v_asset.k3_components) = 0) THEN
      RETURN QUERY SELECT 'asset_k3_components_missing'::text,
        format('Tillgången "%s" är K3-byggnad men saknar komponentanalys.', v_asset.name), 1;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.depreciation_schedules ds
      WHERE ds.company_id = p_company_id
        AND ds.fiscal_period_id = p_fiscal_period_id
        AND ds.asset_id = v_asset.id
    ) THEN
      RETURN QUERY SELECT 'asset_depreciation_missing'::text,
        format('Tillgången "%s" saknar avskrivningsförslag/bokning för perioden.', v_asset.name), 1;
    END IF;
  END LOOP;

  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.year_end_db_blockers(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.year_end_db_blockers(uuid, uuid) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. post_currency_revaluation — idempotent FX revaluation posting (B05).
--
-- The TS layer computes the historical open-item snapshot (B06/B07) and the
-- deterministic snapshot key; this RPC owns persistence:
--   * same snapshot key ⇒ reuse the already-posted run (idempotent),
--   * different snapshot key before close ⇒ controlled replace (reverse old
--     entry, mark run 'replaced', post new),
--   * closed/locked period ⇒ refuse.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.post_currency_revaluation(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_user_id uuid,
  p_balance_date date,
  p_snapshot_key text,
  p_lines jsonb,
  p_items jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text := COALESCE(auth.role(), current_user::text);
  v_period record;
  v_existing record;
  v_entry_id uuid;
  v_run_id uuid;
  v_item jsonb;
BEGIN
  -- Authorization: authenticated callers need write capability; service_role
  -- callers (server-side API) pass p_user_id for attribution.
  IF v_uid IS NOT NULL THEN
    IF NOT public.user_can_write_company(p_company_id) THEN
      RAISE EXCEPTION 'FORBIDDEN: no write access to company' USING ERRCODE = '42501';
    END IF;
    p_user_id := v_uid;
  ELSIF v_role NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'FORBIDDEN: unauthenticated caller' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_company_id::text || ':fx:' || p_fiscal_period_id::text));

  SELECT * INTO v_period FROM public.fiscal_periods
  WHERE id = p_fiscal_period_id AND company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FX_PERIOD_NOT_FOUND: fiscal period not found';
  END IF;
  IF v_period.is_closed OR v_period.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'FX_PERIOD_CLOSED: cannot revalue a closed/locked period';
  END IF;

  SELECT * INTO v_existing FROM public.currency_revaluation_runs
  WHERE company_id = p_company_id
    AND fiscal_period_id = p_fiscal_period_id
    AND status = 'posted'
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.snapshot_key = p_snapshot_key THEN
      -- Idempotent: identical underlag ⇒ reuse.
      RETURN jsonb_build_object(
        'run_id', v_existing.id,
        'entry_id', v_existing.entry_id,
        'reused', true
      );
    END IF;
    -- Controlled replace: reverse the old entry, mark the run replaced.
    IF v_existing.entry_id IS NOT NULL THEN
      DECLARE
        v_storno_id uuid;
      BEGIN
        v_storno_id := public.__ye_post_entry(
          p_company_id, p_user_id, p_fiscal_period_id, p_balance_date,
          'Återföring: ersatt valutaomvärdering',
          'storno', 'A',
          (SELECT jsonb_agg(jsonb_build_object(
              'account_number', l.account_number,
              'debit_amount', l.credit_amount,
              'credit_amount', l.debit_amount,
              'line_description', 'Återföring: ' || COALESCE(l.line_description, '')))
           FROM public.journal_entry_lines l
           WHERE l.journal_entry_id = v_existing.entry_id),
          v_existing.entry_id
        );
        UPDATE public.journal_entries
        SET status = 'reversed', reversed_by_id = v_storno_id
        WHERE id = v_existing.entry_id AND company_id = p_company_id;
      END;
    END IF;
    UPDATE public.currency_revaluation_runs
    SET status = 'replaced', updated_at = now()
    WHERE id = v_existing.id;
  END IF;

  IF p_lines IS NULL OR jsonb_array_length(p_lines) = 0 THEN
    -- Nothing to revalue: record a zero run so readiness knows FX was checked.
    INSERT INTO public.currency_revaluation_runs
      (company_id, fiscal_period_id, balance_date, snapshot_key, status, entry_id, created_by)
    VALUES (p_company_id, p_fiscal_period_id, p_balance_date, p_snapshot_key, 'posted', NULL, p_user_id)
    RETURNING id INTO v_run_id;
    RETURN jsonb_build_object('run_id', v_run_id, 'entry_id', NULL, 'reused', false);
  END IF;

  v_entry_id := public.__ye_post_entry(
    p_company_id, p_user_id, p_fiscal_period_id, p_balance_date,
    'Valutaomvärdering per ' || p_balance_date::text,
    'currency_revaluation', 'A', p_lines
  );

  INSERT INTO public.currency_revaluation_runs
    (company_id, fiscal_period_id, balance_date, snapshot_key, status, entry_id, created_by)
  VALUES (p_company_id, p_fiscal_period_id, p_balance_date, p_snapshot_key, 'posted', v_entry_id, p_user_id)
  RETURNING id INTO v_run_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) LOOP
    INSERT INTO public.currency_revaluation_items
      (run_id, company_id, invoice_id, supplier_invoice_id, currency,
       open_amount_currency, open_amount_sek_original, rate_original,
       rate_closing, unrealized_diff_sek)
    VALUES
      (v_run_id, p_company_id,
       NULLIF(v_item->>'invoice_id', '')::uuid,
       NULLIF(v_item->>'supplier_invoice_id', '')::uuid,
       v_item->>'currency',
       (v_item->>'open_amount_currency')::numeric,
       (v_item->>'open_amount_sek_original')::numeric,
       (v_item->>'rate_original')::numeric,
       (v_item->>'rate_closing')::numeric,
       (v_item->>'unrealized_diff_sek')::numeric);
  END LOOP;

  RETURN jsonb_build_object('run_id', v_run_id, 'entry_id', v_entry_id, 'reused', false);
END;
$$;

REVOKE ALL ON FUNCTION public.post_currency_revaluation(uuid, uuid, uuid, date, text, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_currency_revaluation(uuid, uuid, uuid, date, text, jsonb, jsonb) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. execute_year_end_closing — the atomic close (B01, B02, B03, B09).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.execute_year_end_closing(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_user_id uuid,
  p_idempotency_key text,
  p_revaluation jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text := COALESCE(auth.role(), current_user::text);
  v_period record;
  v_blocker record;
  v_blockers text[] := '{}';
  v_entity_type text;
  v_closing_account text;
  v_closing_account_name text;
  v_reval_result jsonb;
  v_reval_run record;
  v_closing_lines jsonb;
  v_closing_entry_id uuid;
  v_next_period record;
  v_next_period_id uuid;
  v_ob_lines jsonb;
  v_ob_entry_id uuid;
  v_reversal_entry_id uuid;
  v_reversal_lines jsonb;
  v_run_id uuid;
  v_existing_run record;
  v_continuity_diff record;
  v_result_net numeric;
  v_fx_exposure integer;
BEGIN
  -- Authorization (never rely on service role alone: authenticated callers
  -- must hold write capability; service_role must supply attribution).
  IF v_uid IS NOT NULL THEN
    IF NOT public.user_can_write_company(p_company_id) THEN
      RAISE EXCEPTION 'FORBIDDEN: no write access to company' USING ERRCODE = '42501';
    END IF;
    p_user_id := v_uid;
  ELSIF v_role NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'FORBIDDEN: unauthenticated caller' USING ERRCODE = '42501';
  ELSIF p_user_id IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: service caller must supply p_user_id' USING ERRCODE = '42501';
  END IF;

  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 THEN
    RAISE EXCEPTION 'YE_MISSING_IDEMPOTENCY_KEY';
  END IF;

  -- Serialize concurrent closes for the same period (B09).
  PERFORM pg_advisory_xact_lock(hashtext(p_company_id::text || ':year_end:' || p_fiscal_period_id::text));

  SELECT * INTO v_period FROM public.fiscal_periods
  WHERE id = p_fiscal_period_id AND company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'YE_PERIOD_NOT_FOUND';
  END IF;

  -- Idempotent replay: a completed run with the same key returns its result.
  SELECT * INTO v_existing_run FROM public.year_end_runs
  WHERE company_id = p_company_id
    AND fiscal_period_id = p_fiscal_period_id
    AND status = 'closed';
  IF FOUND THEN
    IF v_existing_run.idempotency_key = p_idempotency_key THEN
      RETURN jsonb_build_object(
        'run_id', v_existing_run.id,
        'closing_entry_id', v_existing_run.closing_entry_id,
        'opening_balance_entry_id', v_existing_run.opening_balance_entry_id,
        'next_period_id', v_existing_run.next_period_id,
        'revaluation_entry_id', v_existing_run.revaluation_entry_id,
        'revaluation_reversal_entry_id', v_existing_run.revaluation_reversal_entry_id,
        'idempotent', true
      );
    END IF;
    RAISE EXCEPTION 'YE_ALREADY_CLOSED: period already closed by run %', v_existing_run.id;
  END IF;

  -- FULL readiness inside the locked transaction (B03), failing closed (B04):
  -- any exception in the blocker function aborts the close.
  FOR v_blocker IN SELECT * FROM public.year_end_db_blockers(p_company_id, p_fiscal_period_id) LOOP
    v_blockers := array_append(v_blockers, v_blocker.message);
  END LOOP;
  IF array_length(v_blockers, 1) > 0 THEN
    RAISE EXCEPTION 'YE_NOT_READY: %', array_to_string(v_blockers, ' | ');
  END IF;

  -- Canonical legal form (B13): companies.entity_type, no silent AB fallback.
  SELECT entity_type INTO v_entity_type FROM public.companies WHERE id = p_company_id;
  IF v_entity_type IS NULL THEN
    RAISE EXCEPTION 'YE_ENTITY_TYPE_MISSING: company legal form is not set';
  END IF;
  IF v_entity_type = 'enskild_firma' THEN
    v_closing_account := '2010'; v_closing_account_name := 'Eget kapital';
  ELSE
    v_closing_account := '2099'; v_closing_account_name := 'Årets resultat';
  END IF;

  -- Currency revaluation inside the same critical section (B01). If the
  -- caller did not supply a snapshot, verify no obvious FX exposure remains
  -- (fail closed rather than silently closing with unrevalued balances).
  IF p_revaluation IS NOT NULL THEN
    v_reval_result := public.post_currency_revaluation(
      p_company_id, p_fiscal_period_id, p_user_id,
      COALESCE((p_revaluation->>'balance_date')::date, v_period.period_end),
      p_revaluation->>'snapshot_key',
      COALESCE(p_revaluation->'lines', '[]'::jsonb),
      COALESCE(p_revaluation->'items', '[]'::jsonb)
    );
  ELSE
    SELECT count(*)::integer INTO v_fx_exposure FROM (
      SELECT id FROM public.invoices
      WHERE company_id = p_company_id
        AND currency <> 'SEK'
        AND status IN ('sent', 'partially_paid', 'overdue', 'disputed', 'collection_ready')
      UNION ALL
      SELECT id FROM public.supplier_invoices
      WHERE company_id = p_company_id
        AND currency <> 'SEK'
        AND status IN ('registered', 'approved', 'overdue', 'partially_paid')
    ) fx;
    IF v_fx_exposure > 0
       AND NOT EXISTS (
         SELECT 1 FROM public.currency_revaluation_runs
         WHERE company_id = p_company_id
           AND fiscal_period_id = p_fiscal_period_id
           AND status = 'posted'
       ) THEN
      RAISE EXCEPTION 'YE_FX_EXPOSURE_UNREVALUED: % open foreign currency items require revaluation before closing (ÅRL 4:13)', v_fx_exposure;
    END IF;
  END IF;

  SELECT * INTO v_reval_run FROM public.currency_revaluation_runs
  WHERE company_id = p_company_id
    AND fiscal_period_id = p_fiscal_period_id
    AND status = 'posted';

  -- Closing lines: zero every class 3–8 account (post-revaluation balances).
  SELECT jsonb_agg(jsonb_build_object(
           'account_number', s.account_number,
           'debit_amount',  CASE WHEN s.net < 0 THEN round(-s.net, 2) ELSE 0 END,
           'credit_amount', CASE WHEN s.net > 0 THEN round(s.net, 2) ELSE 0 END,
           'line_description', 'Nollställning resultatkonto'))
  INTO v_closing_lines
  FROM (
    SELECT l.account_number, round(sum(l.debit_amount - l.credit_amount), 2) AS net
    FROM public.journal_entry_lines l
    JOIN public.journal_entries e ON e.id = l.journal_entry_id
    WHERE e.company_id = p_company_id
      AND e.fiscal_period_id = p_fiscal_period_id
      AND e.status IN ('posted', 'reversed')
      AND substring(l.account_number, 1, 1) IN ('3', '4', '5', '6', '7', '8')
    GROUP BY l.account_number
    HAVING abs(round(sum(l.debit_amount - l.credit_amount), 2)) >= 0.005
  ) s;

  IF v_closing_lines IS NULL OR jsonb_array_length(v_closing_lines) = 0 THEN
    RAISE EXCEPTION 'YE_NO_ACTIVITY: no result accounts to close — period has no activity';
  END IF;

  -- Balance the closing entry against the equity account.
  SELECT round(sum((l->>'debit_amount')::numeric) - sum((l->>'credit_amount')::numeric), 2)
  INTO v_result_net
  FROM jsonb_array_elements(v_closing_lines) l;
  IF abs(v_result_net) >= 0.005 THEN
    v_closing_lines := v_closing_lines || jsonb_build_array(jsonb_build_object(
      'account_number', v_closing_account,
      'debit_amount',  CASE WHEN v_result_net < 0 THEN round(-v_result_net, 2) ELSE 0 END,
      'credit_amount', CASE WHEN v_result_net > 0 THEN round(v_result_net, 2) ELSE 0 END,
      'line_description', 'Årets resultat → ' || v_closing_account_name));
  END IF;

  v_closing_entry_id := public.__ye_post_entry(
    p_company_id, p_user_id, p_fiscal_period_id, v_period.period_end,
    'Årsbokslut ' || v_period.name, 'year_end', 'A', v_closing_lines);

  -- INVARIANT: class 3–8 must now net to zero.
  SELECT round(sum(l.debit_amount - l.credit_amount), 2) INTO v_result_net
  FROM public.journal_entry_lines l
  JOIN public.journal_entries e ON e.id = l.journal_entry_id
  WHERE e.company_id = p_company_id
    AND e.fiscal_period_id = p_fiscal_period_id
    AND e.status IN ('posted', 'reversed')
    AND substring(l.account_number, 1, 1) IN ('3', '4', '5', '6', '7', '8');
  IF abs(COALESCE(v_result_net, 0)) > 0.005 THEN
    RAISE EXCEPTION 'YE_CLOSING_INVARIANT: class 3-8 nets to % after closing entry', v_result_net;
  END IF;

  -- Resolve or create the next period.
  SELECT * INTO v_next_period FROM public.fiscal_periods
  WHERE company_id = p_company_id
    AND period_start > v_period.period_end
  ORDER BY period_start ASC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    IF v_next_period.opening_balance_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'YE_NEXT_PERIOD_HAS_OB: next fiscal period already has opening balances posted';
    END IF;
    v_next_period_id := v_next_period.id;
  ELSE
    INSERT INTO public.fiscal_periods
      (company_id, user_id, name,
       period_start, period_end, previous_period_id)
    VALUES
      (p_company_id, p_user_id,
       to_char(v_period.period_end + 1, 'YYYY') ||
         CASE WHEN date_trunc('year', v_period.period_end + 1) = (v_period.period_end + 1)::timestamp
              THEN '' ELSE '/' || to_char(v_period.period_end + interval '1 year', 'YYYY') END,
       v_period.period_end + 1,
       ((v_period.period_end + 1) + interval '1 year' - interval '1 day')::date,
       p_fiscal_period_id)
    RETURNING * INTO v_next_period;
    v_next_period_id := v_next_period.id;
  END IF;

  -- Lock + close the period. Done AFTER the closing entry (the period-lock
  -- trigger blocks writes into locked periods) but INSIDE this transaction,
  -- so a later failure rolls the lock back too (B02).
  UPDATE public.fiscal_periods
  SET closing_entry_id = v_closing_entry_id,
      locked_at = now(),
      is_closed = true,
      closed_at = now()
  WHERE id = p_fiscal_period_id AND company_id = p_company_id;

  -- Opening balances for the next period: class 1–2 closing balances.
  SELECT jsonb_agg(jsonb_build_object(
           'account_number', s.account_number,
           'debit_amount',  CASE WHEN s.net > 0 THEN round(s.net, 2) ELSE 0 END,
           'credit_amount', CASE WHEN s.net < 0 THEN round(-s.net, 2) ELSE 0 END,
           'line_description', 'Ingående balans'))
  INTO v_ob_lines
  FROM (
    SELECT l.account_number, round(sum(l.debit_amount - l.credit_amount), 2) AS net
    FROM public.journal_entry_lines l
    JOIN public.journal_entries e ON e.id = l.journal_entry_id
    WHERE e.company_id = p_company_id
      AND e.fiscal_period_id = p_fiscal_period_id
      AND e.status IN ('posted', 'reversed')
      AND substring(l.account_number, 1, 1) IN ('1', '2')
    GROUP BY l.account_number
    HAVING abs(round(sum(l.debit_amount - l.credit_amount), 2)) >= 0.005
  ) s;

  IF v_ob_lines IS NULL OR jsonb_array_length(v_ob_lines) = 0 THEN
    RAISE EXCEPTION 'YE_NO_BALANCE_SHEET: no balance sheet accounts with non-zero closing balance';
  END IF;

  v_ob_entry_id := public.__ye_post_entry(
    p_company_id, p_user_id, v_next_period_id, v_next_period.period_start,
    'Ingående balans ' || v_next_period.name, 'opening_balance', 'A', v_ob_lines);

  -- Deterministic reversal of the unrealized FX revaluation in the next
  -- period (B08) — exactly once per revaluation run.
  IF v_reval_run.id IS NOT NULL AND v_reval_run.entry_id IS NOT NULL
     AND v_reval_run.reversal_entry_id IS NULL THEN
    SELECT jsonb_agg(jsonb_build_object(
             'account_number', l.account_number,
             'debit_amount', l.credit_amount,
             'credit_amount', l.debit_amount,
             'line_description', 'Återföring orealiserad valutadifferens'))
    INTO v_reversal_lines
    FROM public.journal_entry_lines l
    WHERE l.journal_entry_id = v_reval_run.entry_id;

    v_reversal_entry_id := public.__ye_post_entry(
      p_company_id, p_user_id, v_next_period_id, v_next_period.period_start,
      'Återföring valutaomvärdering per ' || v_reval_run.balance_date::text,
      'currency_revaluation_reversal', 'A', v_reversal_lines);

    UPDATE public.currency_revaluation_runs
    SET reversal_entry_id = v_reversal_entry_id, updated_at = now()
    WHERE id = v_reval_run.id;
  END IF;

  -- Continuity: every class 1–2 UB in period N must equal the IB line in
  -- period N+1 to the öre. Any discrepancy aborts (rolls back) the close.
  FOR v_continuity_diff IN
    WITH ub AS (
      SELECT l.account_number, round(sum(l.debit_amount - l.credit_amount), 2) AS net
      FROM public.journal_entry_lines l
      JOIN public.journal_entries e ON e.id = l.journal_entry_id
      WHERE e.company_id = p_company_id
        AND e.fiscal_period_id = p_fiscal_period_id
        AND e.status IN ('posted', 'reversed')
        AND substring(l.account_number, 1, 1) IN ('1', '2')
      GROUP BY l.account_number
    ),
    ib AS (
      SELECT l.account_number, round(sum(l.debit_amount - l.credit_amount), 2) AS net
      FROM public.journal_entry_lines l
      WHERE l.journal_entry_id = v_ob_entry_id
      GROUP BY l.account_number
    )
    SELECT COALESCE(ub.account_number, ib.account_number) AS account_number,
           COALESCE(ub.net, 0) AS ub_net,
           COALESCE(ib.net, 0) AS ib_net
    FROM ub FULL OUTER JOIN ib ON ib.account_number = ub.account_number
    WHERE abs(COALESCE(ub.net, 0) - COALESCE(ib.net, 0)) > 0.005
  LOOP
    RAISE EXCEPTION 'YE_CONTINUITY: account % UB=% IB=% — aborting close',
      v_continuity_diff.account_number, v_continuity_diff.ub_net, v_continuity_diff.ib_net;
  END LOOP;

  UPDATE public.fiscal_periods
  SET opening_balance_entry_id = v_ob_entry_id,
      opening_balances_set = true,
      previous_period_id = p_fiscal_period_id,
      continuity_verified = true
  WHERE id = v_next_period_id AND company_id = p_company_id;

  INSERT INTO public.year_end_runs
    (company_id, fiscal_period_id, status, idempotency_key,
     closing_entry_id, opening_balance_entry_id,
     revaluation_entry_id, revaluation_reversal_entry_id,
     next_period_id, created_by, finished_at)
  VALUES
    (p_company_id, p_fiscal_period_id, 'closed', p_idempotency_key,
     v_closing_entry_id, v_ob_entry_id,
     v_reval_run.entry_id, v_reversal_entry_id,
     v_next_period_id, p_user_id, now())
  RETURNING id INTO v_run_id;

  RETURN jsonb_build_object(
    'run_id', v_run_id,
    'closing_entry_id', v_closing_entry_id,
    'opening_balance_entry_id', v_ob_entry_id,
    'next_period_id', v_next_period_id,
    'revaluation_entry_id', v_reval_run.entry_id,
    'revaluation_reversal_entry_id', v_reversal_entry_id,
    'idempotent', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.execute_year_end_closing(uuid, uuid, uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.execute_year_end_closing(uuid, uuid, uuid, text, jsonb) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
