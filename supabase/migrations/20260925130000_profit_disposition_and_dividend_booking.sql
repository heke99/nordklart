-- Vinstdisposition and utdelning (aktiebolag), end to end.
--
-- 1. year_end_profit_disposition_proposal() computed the wrong numbers:
--    - "årets resultat" summed classes 3–8 over the company's whole history
--      up to the balance date instead of the fiscal year;
--    - it included the year-end closing voucher, so once the year was closed
--      (Dr 8999 / Cr 2099) the result came out as 0;
--    - fritt eget kapital only counted 2091 and 2098, missing 2090, 2093
--      (erhållna aktieägartillskott), 2095, 2096, 2097 (fri överkursfond) and
--      a prior-year result still on 2099; and it double counted history when
--      the year has an opening-balance voucher.
--    It now returns, from the ledger, årets resultat for the fiscal year
--    (closing vouchers excluded — source 'year_end'/'year_end_closing', or any
--    voucher touching 8999 "Årets resultat" such as an imported closing) and
--    the balanserade medel 2090–2099 at the balance date (IB + the year's
--    movements, closing excluded). "Till årsstämmans förfogande" is their sum
--    and may be negative (ansamlad förlust). Only aktiebolag have a
--    vinstdisposition; other legal forms get applicable = false.
--
-- 2. record_year_end_profit_disposition() trusted the amounts in the payload,
--    refused a negative fritt eget kapital, so a loss-making company could
--    not record "balanseras i ny räkning", and refused a closed period — but
--    the year-end run books tax and bokslutsdispositioner and closes the
--    period in one step, so the board's proposal could only ever be recorded
--    on pre-tax figures. It may now be recorded (it books nothing) until the
--    stämma has adopted the accounts. It now takes årets resultat and
--    fritt eget kapital from (1), and enforces the beloppsspärr (ABL 17 kap.
--    3 § första stycket): a proposed dividend may not exceed the fritt eget
--    kapital of the balance sheet the stämma will adopt. The planned payment
--    date must be after the balance date (ABL 18 kap. 3 §).
--
-- 3. book_dividend_decision() — the stämma's decision. It was recorded
--    nowhere; dividend_decisions existed but nothing wrote it and no
--    utdelningsskuld was ever booked. Under a lock on the proposal it
--    requires:
--      - the proposal approved for the annual report and not yet decided;
--      - the annual report adopted (fastställd) at an årsstämma on or before
--        the decision date (arsredovisning_narratives.agm_accounts_adopted);
--      - at most the board's proposal (ABL 18 kap. 1 §), unless a deviation
--        reason is given (bolagsordningen or a minority request, 18:11);
--      - at most what 17 kap. 3 § first paragraph allows: fritt eget kapital
--        of the adopted balance sheet (never more than the ledger shows now),
--        less value transfers decided after the balance date and less amounts
--        moved from free to restricted equity after the balance date (e.g.
--        fondemission, avsättning till reservfond);
--      - last year's result moved off 2099 in the decision's fiscal year;
--      - the draft voucher to be exactly: Cr 2898 Outtagen vinstutdelning =
--        the decided amount, 2098 cleared to zero, the difference on 2091
--        (the Bokio / Fortnox / Björn Lundén pattern "Dr 2098/2091, Cr 2898"
--        plus "2098 → 2091 balanseras i ny räkning" in one voucher).
--    It commits the voucher, records the decision, the 'dividend_decision'
--    equity event (read by the annual report's eget-kapital note) and locks
--    the disposition — all or nothing.
--
-- 4. book_dividend_payment() — utbetalning, Dr 2898 / Cr 19xx, possibly in
--    several instalments, never more than the decided amount, into the new
--    dividend_payments table (append-only, like dividend_decisions).
--
-- All three writers are SECURITY DEFINER and service_role only, like
-- record_year_end_profit_disposition: the API route authorizes with
-- requireYearEndAccess(requireWrite) before calling them.
--
-- pg-test: tests/pg/profit-disposition-and-dividend.pg.test.ts

BEGIN;

-- ---------------------------------------------------------------------------
-- Source types: the two dividend vouchers, and the year-end lagerförändring
-- (lib/bokslut/inventory/inventory-valuation.ts), which had no voucher type of
-- its own.
-- ---------------------------------------------------------------------------
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
    'year_end_inventory'
  )) NOT VALID;

ALTER TABLE public.journal_entries
  VALIDATE CONSTRAINT journal_entries_source_type_check;

-- ---------------------------------------------------------------------------
-- dividend_payments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.dividend_payments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  dividend_decision_id  uuid NOT NULL REFERENCES public.dividend_decisions(id) ON DELETE RESTRICT,
  journal_entry_id      uuid NOT NULL UNIQUE REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  amount                numeric(18,2) NOT NULL CHECK (amount > 0),
  paid_on               date NOT NULL,
  created_by            uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dividend_payments_decision
  ON public.dividend_payments (dividend_decision_id);
CREATE INDEX IF NOT EXISTS idx_dividend_payments_company
  ON public.dividend_payments (company_id);

ALTER TABLE public.dividend_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dividend_payments_select ON public.dividend_payments;
CREATE POLICY dividend_payments_select ON public.dividend_payments
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.resolve_company_access(company_id) access WHERE access.can_read)
  );
REVOKE ALL ON public.dividend_payments FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.dividend_payments TO authenticated;
GRANT ALL ON public.dividend_payments TO service_role;

DROP TRIGGER IF EXISTS dividend_payments_immutable ON public.dividend_payments;
CREATE TRIGGER dividend_payments_immutable
  BEFORE UPDATE OR DELETE ON public.dividend_payments
  FOR EACH ROW EXECUTE FUNCTION public.historical_support_immutable();

-- ---------------------------------------------------------------------------
-- Internal: credit-positive balance of an account range at the end of a day.
-- IB of the fiscal year containing p_date (its opening-balance voucher, or
-- the prior-ledger aggregate when the year has none) plus the year's posted
-- movements up to and including p_date.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.__ledger_balance_at(
  p_company_id uuid,
  p_account_from text,
  p_account_to text,
  p_date date
)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period public.fiscal_periods%ROWTYPE;
  v_ib numeric := 0;
  v_movement numeric := 0;
BEGIN
  SELECT * INTO v_period
    FROM public.fiscal_periods fp
   WHERE fp.company_id = p_company_id
     AND p_date BETWEEN fp.period_start AND fp.period_end
   ORDER BY fp.period_start DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LEDGER_BALANCE_NO_FISCAL_PERIOD' USING ERRCODE = 'P0002';
  END IF;

  IF v_period.opening_balance_entry_id IS NOT NULL THEN
    SELECT coalesce(sum(l.credit_amount - l.debit_amount), 0) INTO v_ib
      FROM public.journal_entry_lines l
      JOIN public.journal_entries je ON je.id = l.journal_entry_id
     WHERE je.id = v_period.opening_balance_entry_id
       AND je.company_id = p_company_id
       AND l.account_number BETWEEN p_account_from AND p_account_to;
  ELSE
    SELECT coalesce(sum(c.credit - c.debit), 0) INTO v_ib
      FROM public.compute_prior_opening_balances(p_company_id, v_period.period_start) c
     WHERE c.account_number BETWEEN p_account_from AND p_account_to;
  END IF;

  SELECT coalesce(sum(l.credit_amount - l.debit_amount), 0) INTO v_movement
    FROM public.journal_entries je
    JOIN public.journal_entry_lines l ON l.journal_entry_id = je.id
   WHERE je.company_id = p_company_id
     AND je.fiscal_period_id = v_period.id
     AND je.status IN ('posted', 'reversed')
     AND je.id IS DISTINCT FROM v_period.opening_balance_entry_id
     AND je.entry_date <= p_date
     AND l.account_number BETWEEN p_account_from AND p_account_to;

  RETURN round(v_ib + v_movement, 2);
END;
$$;

REVOKE ALL ON FUNCTION public.__ledger_balance_at(uuid, text, text, date) FROM PUBLIC, anon, authenticated;
-- lib/core/bookkeeping/dividend-service.ts reads 2098 through it to build the
-- decision voucher the RPC below then re-checks.
GRANT EXECUTE ON FUNCTION public.__ledger_balance_at(uuid, text, text, date) TO service_role;

-- ---------------------------------------------------------------------------
-- 1. Proposal from the ledger.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.year_end_profit_disposition_proposal(
  p_company_id uuid,
  p_fiscal_period_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period public.fiscal_periods%ROWTYPE;
  v_entity_type text;
  v_ib_retained numeric := 0;
  v_current_result numeric := 0;
  v_retained_movement numeric := 0;
  v_retained numeric;
  v_available numeric;
  v_fmt text := 'FM999G999G999G990D00';
BEGIN
  -- Tenant guard (20260924100000): anon/authenticated callers must have
  -- access to p_company_id; service_role / no-claims callers bypass by design.
  PERFORM public.assert_company_member_claims(p_company_id);

  SELECT fp.* INTO v_period
    FROM public.fiscal_periods fp
   WHERE fp.id = p_fiscal_period_id
     AND fp.company_id = p_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'YEAR_END_PROFIT_PROPOSAL_PERIOD_NOT_FOUND'
      USING ERRCODE = '22023';
  END IF;

  SELECT c.entity_type INTO v_entity_type FROM public.companies c WHERE c.id = p_company_id;
  IF v_entity_type IS DISTINCT FROM 'aktiebolag' THEN
    RETURN jsonb_build_object(
      'applicable', false,
      'current_year_result', 0,
      'retained_earnings', 0,
      'free_equity', 0,
      'available_for_distribution', 0,
      'proposed_dividend', 0,
      'carried_forward', 0,
      'proposal_text', 'Vinstdisposition upprättas endast för aktiebolag.'
    );
  END IF;

  IF v_period.opening_balance_entry_id IS NOT NULL THEN
    SELECT coalesce(sum(l.credit_amount - l.debit_amount), 0) INTO v_ib_retained
      FROM public.journal_entry_lines l
      JOIN public.journal_entries je ON je.id = l.journal_entry_id
     WHERE je.id = v_period.opening_balance_entry_id
       AND je.company_id = p_company_id
       AND l.account_number BETWEEN '2090' AND '2099';
  ELSE
    SELECT coalesce(sum(c.credit - c.debit), 0) INTO v_ib_retained
      FROM public.compute_prior_opening_balances(p_company_id, v_period.period_start) c
     WHERE c.account_number BETWEEN '2090' AND '2099';
  END IF;

  WITH year_vouchers AS (
    SELECT je.id
      FROM public.journal_entries je
     WHERE je.company_id = p_company_id
       AND je.fiscal_period_id = p_fiscal_period_id
       AND je.status IN ('posted', 'reversed')
       AND je.id IS DISTINCT FROM v_period.opening_balance_entry_id
       AND coalesce(je.source_type, '') NOT IN ('year_end', 'year_end_closing')
       AND NOT EXISTS (
         SELECT 1 FROM public.journal_entry_lines c8
          WHERE c8.journal_entry_id = je.id AND c8.account_number = '8999'
       )
  )
  SELECT
    coalesce(sum(l.credit_amount - l.debit_amount)
      FILTER (WHERE l.account_number BETWEEN '3000' AND '8999'), 0),
    coalesce(sum(l.credit_amount - l.debit_amount)
      FILTER (WHERE l.account_number BETWEEN '2090' AND '2099'), 0)
    INTO v_current_result, v_retained_movement
    FROM year_vouchers y
    JOIN public.journal_entry_lines l ON l.journal_entry_id = y.id;

  v_current_result := round(v_current_result, 2);
  v_retained := round(v_ib_retained + v_retained_movement, 2);
  v_available := round(v_retained + v_current_result, 2);

  RETURN jsonb_build_object(
    'applicable', true,
    'current_year_result', v_current_result,
    'retained_earnings', v_retained,
    -- Till årsstämmans förfogande: may be negative (ansamlad förlust).
    'free_equity', v_available,
    'available_for_distribution', greatest(v_available, 0),
    'proposed_dividend', 0,
    'carried_forward', v_available,
    'proposal_text', format(
      'Till årsstämmans förfogande står balanserat resultat %s kr och årets resultat %s kr, totalt %s kr. Styrelsen föreslår att %s kr balanseras i ny räkning.',
      to_char(v_retained, v_fmt),
      to_char(v_current_result, v_fmt),
      to_char(v_available, v_fmt),
      to_char(v_available, v_fmt)
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.year_end_profit_disposition_proposal(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.year_end_profit_disposition_proposal(uuid, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Record the board's proposal (amounts from the ledger, beloppsspärr).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_year_end_profit_disposition(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_user_id uuid,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text := coalesce(auth.role(), current_user::text);
  v_period public.fiscal_periods%ROWTYPE;
  v_proposal jsonb;
  v_current_result numeric;
  v_free_equity numeric;
  v_dividend numeric;
  v_carried numeric;
  v_payment_date date;
  v_id uuid;
BEGIN
  IF v_role NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'YEAR_END_PROFIT_DISPOSITION_SERVICE_ONLY'
      USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat_ws(':', 'profit-disposition', p_company_id, p_fiscal_period_id),
    0
  ));
  SELECT fp.* INTO v_period
    FROM public.fiscal_periods fp
   WHERE fp.id = p_fiscal_period_id
     AND fp.company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'YEAR_END_PROFIT_DISPOSITION_PERIOD_NOT_OPEN'
      USING ERRCODE = '55000';
  END IF;
  -- The board proposes the disposition on the final accounts, i.e. after the
  -- year-end run has booked tax and bokslutsdispositioner and closed the
  -- period; recording it writes no voucher, so a closed period is no reason
  -- to refuse. Once the stämma has adopted the accounts the proposal is
  -- history and may no longer change.
  IF EXISTS (
    SELECT 1 FROM public.arsredovisning_narratives n
     WHERE n.company_id = p_company_id
       AND n.fiscal_period_id = p_fiscal_period_id
       AND n.agm_accounts_adopted IS TRUE
  ) THEN
    RAISE EXCEPTION 'YEAR_END_PROFIT_DISPOSITION_LOCKED'
      USING ERRCODE = '55000';
  END IF;

  v_proposal := public.year_end_profit_disposition_proposal(p_company_id, p_fiscal_period_id);
  IF NOT (v_proposal->>'applicable')::boolean THEN
    RAISE EXCEPTION 'YEAR_END_PROFIT_DISPOSITION_AB_ONLY'
      USING ERRCODE = '22023';
  END IF;

  v_current_result := (v_proposal->>'current_year_result')::numeric;
  v_free_equity := (v_proposal->>'free_equity')::numeric;
  v_dividend := round(coalesce(nullif(p_payload->>'proposed_dividend', '')::numeric, 0), 2);
  IF v_dividend < 0 THEN
    RAISE EXCEPTION 'YEAR_END_PROFIT_DISPOSITION_INVALID_AMOUNTS'
      USING ERRCODE = '23514';
  END IF;
  -- ABL 17 kap. 3 § första stycket: full täckning för det bundna egna
  -- kapitalet efter utdelningen, i.e. no more than fritt eget kapital.
  IF v_dividend > 0 AND v_dividend > v_free_equity THEN
    RAISE EXCEPTION 'YEAR_END_DIVIDEND_EXCEEDS_FREE_EQUITY'
      USING ERRCODE = '23514',
            DETAIL = format('free_equity=%s proposed_dividend=%s', v_free_equity, v_dividend);
  END IF;
  v_carried := round(v_free_equity - v_dividend, 2);

  INSERT INTO public.year_end_profit_dispositions (
    company_id, fiscal_period_id, current_year_result, free_equity,
    proposed_dividend, carried_forward, status, narrative_override,
    approved_by, approved_at, created_by
  ) VALUES (
    p_company_id, p_fiscal_period_id, v_current_result, v_free_equity,
    v_dividend, v_carried, 'approved', nullif(btrim(coalesce(p_payload->>'narrative_override', '')), ''),
    p_user_id, now(), p_user_id
  )
  ON CONFLICT (company_id, fiscal_period_id) DO UPDATE SET
    current_year_result = EXCLUDED.current_year_result,
    free_equity = EXCLUDED.free_equity,
    proposed_dividend = EXCLUDED.proposed_dividend,
    carried_forward = EXCLUDED.carried_forward,
    status = 'approved',
    narrative_override = EXCLUDED.narrative_override,
    approved_by = p_user_id,
    approved_at = now()
  WHERE year_end_profit_dispositions.locked_at IS NULL
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'YEAR_END_PROFIT_DISPOSITION_LOCKED'
      USING ERRCODE = '55000';
  END IF;

  IF v_dividend > 0 THEN
    v_payment_date := nullif(p_payload->>'planned_payment_date', '')::date;
    IF length(btrim(coalesce(p_payload->>'board_reasoning', ''))) < 3
       OR length(btrim(coalesce(p_payload->>'prudence_assessment', ''))) < 3
       OR nullif(p_payload->>'share_count', '') IS NULL
       OR nullif(p_payload->>'share_count', '')::bigint <= 0
       OR nullif(p_payload->>'amount_per_share', '') IS NULL
       OR nullif(p_payload->>'amount_per_share', '')::numeric < 0
       OR v_payment_date IS NULL
       OR abs(
         nullif(p_payload->>'amount_per_share', '')::numeric
         * nullif(p_payload->>'share_count', '')::bigint
         - v_dividend
       ) >= 0.01 THEN
      RAISE EXCEPTION 'YEAR_END_DIVIDEND_JUSTIFICATION_REQUIRED'
        USING ERRCODE = '23514';
    END IF;
    -- The dividend is decided by the stämma after the balance date and is
    -- paid on or after that decision (ABL 18 kap. 3 och 13 §§).
    IF v_payment_date <= v_period.period_end THEN
      RAISE EXCEPTION 'YEAR_END_DIVIDEND_PAYMENT_DATE_INVALID'
        USING ERRCODE = '23514';
    END IF;
    INSERT INTO public.dividend_proposals (
      company_id, fiscal_period_id, profit_disposition_id,
      total_amount, amount_per_share, share_count, free_equity,
      carried_forward, planned_payment_date, board_reasoning,
      prudence_assessment, status, created_by
    ) VALUES (
      p_company_id, p_fiscal_period_id, v_id, v_dividend,
      nullif(p_payload->>'amount_per_share', '')::numeric,
      nullif(p_payload->>'share_count', '')::bigint,
      v_free_equity, v_carried,
      v_payment_date,
      p_payload->>'board_reasoning',
      p_payload->>'prudence_assessment',
      'approved_for_annual_report', p_user_id
    )
    ON CONFLICT (profit_disposition_id) DO UPDATE SET
      total_amount = EXCLUDED.total_amount,
      amount_per_share = EXCLUDED.amount_per_share,
      share_count = EXCLUDED.share_count,
      free_equity = EXCLUDED.free_equity,
      carried_forward = EXCLUDED.carried_forward,
      planned_payment_date = EXCLUDED.planned_payment_date,
      board_reasoning = EXCLUDED.board_reasoning,
      prudence_assessment = EXCLUDED.prudence_assessment,
      status = EXCLUDED.status;
  ELSE
    UPDATE public.dividend_proposals
       SET status = 'withdrawn'
     WHERE profit_disposition_id = v_id
       AND status <> 'withdrawn';
  END IF;

  INSERT INTO public.audit_log (
    user_id, company_id, action, table_name, record_id, actor_id,
    new_state, description
  ) VALUES (
    p_user_id, p_company_id, 'SECURITY_EVENT',
    'year_end_profit_dispositions', v_id, p_user_id,
    jsonb_build_object(
      'fiscal_period_id', p_fiscal_period_id,
      'current_year_result', v_current_result,
      'free_equity', v_free_equity,
      'proposed_dividend', v_dividend,
      'carried_forward', v_carried
    ),
    'Strukturerad resultatdisposition godkänd utan bokföring av utdelningsskuld.'
  );
  RETURN jsonb_build_object(
    'id', v_id,
    'current_year_result', v_current_result,
    'free_equity', v_free_equity,
    'proposed_dividend', v_dividend,
    'carried_forward', v_carried,
    'journal_entry_created', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_year_end_profit_disposition(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_year_end_profit_disposition(uuid, uuid, uuid, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- Distributable amount (ABL 17 kap. 3 § första stycket) for a proposal at a
-- decision date. Read-only; service_role only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dividend_distributable_amount(
  p_company_id uuid,
  p_dividend_proposal_id uuid,
  p_as_of date
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text := coalesce(auth.role(), current_user::text);
  v_proposal public.dividend_proposals%ROWTYPE;
  v_disposition public.year_end_profit_dispositions%ROWTYPE;
  v_period public.fiscal_periods%ROWTYPE;
  v_ledger_free numeric;
  v_base numeric;
  v_later_transfers numeric;
  v_to_restricted numeric;
BEGIN
  IF v_role NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'DIVIDEND_SERVICE_ONLY' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_proposal FROM public.dividend_proposals
   WHERE id = p_dividend_proposal_id AND company_id = p_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DIVIDEND_PROPOSAL_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_disposition FROM public.year_end_profit_dispositions
   WHERE id = v_proposal.profit_disposition_id;
  SELECT * INTO v_period FROM public.fiscal_periods WHERE id = v_proposal.fiscal_period_id;

  -- The adopted balance sheet is the ledger at the balance date. If the
  -- ledger now shows less fritt eget kapital than when the proposal was made
  -- (a correction after approval), the lower figure governs.
  v_ledger_free := (public.year_end_profit_disposition_proposal(p_company_id, v_period.id)->>'free_equity')::numeric;
  v_base := least(v_disposition.free_equity, v_ledger_free);

  -- Value transfers decided after the balance date (other dividends).
  SELECT coalesce(sum(d.decided_amount), 0) INTO v_later_transfers
    FROM public.dividend_decisions d
   WHERE d.company_id = p_company_id
     AND d.decision_date > v_period.period_end
     AND d.dividend_proposal_id <> p_dividend_proposal_id;

  -- Free equity moved to restricted equity after the balance date: vouchers
  -- after the balance date that credit 2080–2089 and debit 2090–2099
  -- (fondemission, avsättning till reservfond/fond för utvecklingsutgifter).
  SELECT coalesce(sum(greatest(x.restricted_net, 0)), 0) INTO v_to_restricted
    FROM (
      SELECT sum(l.credit_amount - l.debit_amount)
               FILTER (WHERE l.account_number BETWEEN '2080' AND '2089') AS restricted_net
        FROM public.journal_entries je
        JOIN public.journal_entry_lines l ON l.journal_entry_id = je.id
       WHERE je.company_id = p_company_id
         AND je.status = 'posted'
         AND je.entry_date > v_period.period_end
         AND je.entry_date <= p_as_of
         AND coalesce(je.source_type, '') NOT IN ('opening_balance', 'year_end', 'year_end_closing', 'storno')
       GROUP BY je.id
      HAVING bool_or(l.account_number BETWEEN '2090' AND '2099' AND l.debit_amount > 0)
    ) x;

  RETURN jsonb_build_object(
    'balance_date', v_period.period_end,
    'free_equity_adopted', v_disposition.free_equity,
    'free_equity_ledger', v_ledger_free,
    'later_value_transfers', round(v_later_transfers, 2),
    'moved_to_restricted_equity', round(v_to_restricted, 2),
    'distributable', round(greatest(v_base - v_later_transfers - v_to_restricted, 0), 2),
    'board_proposal', v_proposal.total_amount
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dividend_distributable_amount(uuid, uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dividend_distributable_amount(uuid, uuid, date) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. The stämma's decision: commit Dr 2098/2091, Cr 2898.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.book_dividend_decision(
  p_company_id uuid,
  p_dividend_proposal_id uuid,
  p_decision_date date,
  p_decided_amount numeric,
  p_payment_date date,
  p_deviation_reason text,
  p_draft_entry_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text := coalesce(auth.role(), current_user::text);
  v_proposal public.dividend_proposals%ROWTYPE;
  v_period public.fiscal_periods%ROWTYPE;
  v_draft public.journal_entries%ROWTYPE;
  v_narrative record;
  v_amount numeric := round(coalesce(p_decided_amount, 0), 2);
  v_limits jsonb;
  v_2098 numeric;
  v_prior_2099 numeric;
  v_draft_2898 numeric;
  v_draft_2098 numeric;
  v_draft_2091 numeric;
  v_payment_date date;
  v_decision_id uuid;
  v_draft_period public.fiscal_periods%ROWTYPE;
BEGIN
  IF v_role NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'DIVIDEND_SERVICE_ONLY' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_proposal FROM public.dividend_proposals
   WHERE id = p_dividend_proposal_id AND company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DIVIDEND_PROPOSAL_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_proposal.status <> 'approved_for_annual_report' THEN
    RAISE EXCEPTION 'DIVIDEND_PROPOSAL_NOT_APPROVED' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.dividend_decisions WHERE dividend_proposal_id = v_proposal.id) THEN
    RAISE EXCEPTION 'DIVIDEND_ALREADY_DECIDED' USING ERRCODE = '23505';
  END IF;

  SELECT * INTO v_period FROM public.fiscal_periods WHERE id = v_proposal.fiscal_period_id;
  IF p_decision_date IS NULL OR p_decision_date <= v_period.period_end THEN
    RAISE EXCEPTION 'DIVIDEND_DECISION_BEFORE_BALANCE_DATE' USING ERRCODE = '22023';
  END IF;

  -- The balance sheet the dividend rests on must be adopted by the stämma.
  SELECT n.agm_date, n.agm_accounts_adopted INTO v_narrative
    FROM public.arsredovisning_narratives n
   WHERE n.company_id = p_company_id
     AND n.fiscal_period_id = v_period.id;
  IF NOT FOUND
     OR v_narrative.agm_accounts_adopted IS NOT TRUE
     OR v_narrative.agm_date IS NULL
     OR v_narrative.agm_date > p_decision_date THEN
    RAISE EXCEPTION 'DIVIDEND_ANNUAL_REPORT_NOT_ADOPTED' USING ERRCODE = '55000';
  END IF;

  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'DIVIDEND_AMOUNT_INVALID' USING ERRCODE = '23514';
  END IF;
  -- ABL 18 kap. 1 §: never more than the board proposed, unless the
  -- bolagsordning requires it or a minority demanded it (18:11).
  IF v_amount > v_proposal.total_amount
     AND length(btrim(coalesce(p_deviation_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'DIVIDEND_EXCEEDS_BOARD_PROPOSAL' USING ERRCODE = '23514';
  END IF;

  v_limits := public.dividend_distributable_amount(p_company_id, v_proposal.id, p_decision_date);
  IF v_amount > (v_limits->>'distributable')::numeric THEN
    RAISE EXCEPTION 'DIVIDEND_EXCEEDS_DISTRIBUTABLE'
      USING ERRCODE = '23514', DETAIL = v_limits::text;
  END IF;

  v_payment_date := coalesce(p_payment_date, v_proposal.planned_payment_date);
  IF v_payment_date IS NULL OR v_payment_date < p_decision_date THEN
    RAISE EXCEPTION 'DIVIDEND_PAYMENT_DATE_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_draft FROM public.journal_entries
   WHERE id = p_draft_entry_id AND company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_draft.status <> 'draft'
     OR v_draft.source_type <> 'dividend_decision'
     OR v_draft.entry_date <> p_decision_date THEN
    RAISE EXCEPTION 'DIVIDEND_DRAFT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.journal_entry_lines l
     WHERE l.journal_entry_id = v_draft.id
       AND l.account_number NOT IN ('2091', '2098', '2898')
  ) THEN
    RAISE EXCEPTION 'DIVIDEND_DRAFT_INVALID' USING ERRCODE = '22023',
      DETAIL = 'only 2091, 2098 and 2898 may be used';
  END IF;

  -- Last year's result must already be on 2098, not left on 2099.
  SELECT * INTO v_draft_period FROM public.fiscal_periods WHERE id = v_draft.fiscal_period_id;
  IF v_draft_period.opening_balance_entry_id IS NOT NULL THEN
    SELECT coalesce(sum(l.credit_amount - l.debit_amount), 0) INTO v_prior_2099
      FROM public.journal_entry_lines l
     WHERE l.journal_entry_id = v_draft_period.opening_balance_entry_id
       AND l.account_number = '2099';
  ELSE
    SELECT coalesce(sum(c.credit - c.debit), 0) INTO v_prior_2099
      FROM public.compute_prior_opening_balances(p_company_id, v_draft_period.period_start) c
     WHERE c.account_number = '2099';
  END IF;
  SELECT v_prior_2099 + coalesce(sum(l.credit_amount - l.debit_amount), 0) INTO v_prior_2099
    FROM public.journal_entries je
    JOIN public.journal_entry_lines l ON l.journal_entry_id = je.id
   WHERE je.company_id = p_company_id
     AND je.fiscal_period_id = v_draft_period.id
     AND je.status IN ('posted', 'reversed')
     AND je.id IS DISTINCT FROM v_draft_period.opening_balance_entry_id
     AND l.account_number = '2099'
     AND EXISTS (
       SELECT 1 FROM public.journal_entry_lines o
        WHERE o.journal_entry_id = je.id AND o.account_number = '2098'
     );
  IF abs(v_prior_2099) >= 0.01 THEN
    RAISE EXCEPTION 'DIVIDEND_PRIOR_RESULT_NOT_TRANSFERRED' USING ERRCODE = '55000';
  END IF;

  v_2098 := public.__ledger_balance_at(p_company_id, '2098', '2098', p_decision_date);
  SELECT
    coalesce(sum(l.credit_amount - l.debit_amount) FILTER (WHERE l.account_number = '2898'), 0),
    coalesce(sum(l.credit_amount - l.debit_amount) FILTER (WHERE l.account_number = '2098'), 0),
    coalesce(sum(l.credit_amount - l.debit_amount) FILTER (WHERE l.account_number = '2091'), 0)
    INTO v_draft_2898, v_draft_2098, v_draft_2091
    FROM public.journal_entry_lines l
   WHERE l.journal_entry_id = v_draft.id;
  IF abs(v_draft_2898 - v_amount) >= 0.01
     OR abs(v_draft_2098 + v_2098) >= 0.01
     OR abs(v_draft_2091 - (v_2098 - v_amount)) >= 0.01 THEN
    RAISE EXCEPTION 'DIVIDEND_DRAFT_INVALID' USING ERRCODE = '22023',
      DETAIL = format('expected 2898=%s 2098=%s 2091=%s', v_amount, -v_2098, v_2098 - v_amount);
  END IF;

  PERFORM public.commit_journal_entry(p_company_id, v_draft.id, NULL, NULL, NULL, NULL);

  INSERT INTO public.dividend_decisions (
    company_id, dividend_proposal_id, decision_date, decided_amount,
    deviation_reason, payment_date, journal_entry_id, decided_by
  ) VALUES (
    p_company_id, v_proposal.id, p_decision_date, v_amount,
    nullif(btrim(coalesce(p_deviation_reason, '')), ''), v_payment_date, v_draft.id, p_user_id
  ) RETURNING id INTO v_decision_id;

  INSERT INTO public.year_end_equity_events (
    company_id, fiscal_period_id, event_type, amount, journal_entry_id,
    historical_link_only, metadata, created_by
  ) VALUES (
    p_company_id, v_draft.fiscal_period_id, 'dividend_decision', v_amount, v_draft.id,
    false,
    jsonb_build_object(
      'dividend_decision_id', v_decision_id,
      'balance_date_fiscal_period_id', v_period.id,
      'carried_to_2091', v_2098 - v_amount
    ),
    p_user_id
  );

  UPDATE public.year_end_profit_dispositions
     SET status = 'locked', locked_at = coalesce(locked_at, now())
   WHERE id = v_proposal.profit_disposition_id;

  INSERT INTO public.audit_log (
    user_id, company_id, action, table_name, record_id, actor_id,
    new_state, description
  ) VALUES (
    p_user_id, p_company_id, 'SECURITY_EVENT',
    'dividend_decisions', v_decision_id, p_user_id,
    jsonb_build_object(
      'decision_date', p_decision_date,
      'decided_amount', v_amount,
      'journal_entry_id', v_draft.id,
      'limits', v_limits
    ),
    'Årsstämmans beslut om vinstutdelning bokfört (Dr 2098/2091, Cr 2898).'
  );

  RETURN jsonb_build_object(
    'dividend_decision_id', v_decision_id,
    'journal_entry_id', v_draft.id,
    'decided_amount', v_amount,
    'payment_date', v_payment_date,
    'limits', v_limits
  );
END;
$$;

REVOKE ALL ON FUNCTION public.book_dividend_decision(uuid, uuid, date, numeric, date, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.book_dividend_decision(uuid, uuid, date, numeric, date, text, uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. Payment: commit Dr 2898 / Cr 19xx.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.book_dividend_payment(
  p_company_id uuid,
  p_dividend_decision_id uuid,
  p_draft_entry_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text := coalesce(auth.role(), current_user::text);
  v_decision public.dividend_decisions%ROWTYPE;
  v_draft public.journal_entries%ROWTYPE;
  v_paid numeric;
  v_amount numeric;
  v_credit_cash numeric;
  v_payment_id uuid;
BEGIN
  IF v_role NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'DIVIDEND_SERVICE_ONLY' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_decision FROM public.dividend_decisions
   WHERE id = p_dividend_decision_id AND company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND OR v_decision.journal_entry_id IS NULL THEN
    RAISE EXCEPTION 'DIVIDEND_DECISION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_draft FROM public.journal_entries
   WHERE id = p_draft_entry_id AND company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_draft.status <> 'draft'
     OR v_draft.source_type <> 'dividend_payment'
     OR v_draft.entry_date < v_decision.decision_date THEN
    RAISE EXCEPTION 'DIVIDEND_DRAFT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.journal_entry_lines l
     WHERE l.journal_entry_id = v_draft.id
       AND NOT (
         (l.account_number = '2898' AND l.credit_amount = 0)
         OR (l.account_number BETWEEN '1900' AND '1999' AND l.debit_amount = 0)
       )
  ) THEN
    RAISE EXCEPTION 'DIVIDEND_DRAFT_INVALID' USING ERRCODE = '22023',
      DETAIL = 'payment is Dr 2898 / Cr 19xx';
  END IF;

  SELECT coalesce(sum(l.debit_amount) FILTER (WHERE l.account_number = '2898'), 0),
         coalesce(sum(l.credit_amount) FILTER (WHERE l.account_number BETWEEN '1900' AND '1999'), 0)
    INTO v_amount, v_credit_cash
    FROM public.journal_entry_lines l
   WHERE l.journal_entry_id = v_draft.id;
  v_amount := round(v_amount, 2);
  IF v_amount <= 0 OR abs(v_amount - v_credit_cash) >= 0.01 THEN
    RAISE EXCEPTION 'DIVIDEND_DRAFT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(sum(p.amount), 0) INTO v_paid
    FROM public.dividend_payments p
   WHERE p.dividend_decision_id = v_decision.id;
  IF v_paid + v_amount > v_decision.decided_amount THEN
    RAISE EXCEPTION 'DIVIDEND_OVERPAID' USING ERRCODE = '23514',
      DETAIL = format('decided=%s paid=%s payment=%s', v_decision.decided_amount, v_paid, v_amount);
  END IF;

  PERFORM public.commit_journal_entry(p_company_id, v_draft.id, NULL, NULL, NULL, NULL);

  INSERT INTO public.dividend_payments (
    company_id, dividend_decision_id, journal_entry_id, amount, paid_on, created_by
  ) VALUES (
    p_company_id, v_decision.id, v_draft.id, v_amount, v_draft.entry_date, p_user_id
  ) RETURNING id INTO v_payment_id;

  RETURN jsonb_build_object(
    'dividend_payment_id', v_payment_id,
    'journal_entry_id', v_draft.id,
    'amount', v_amount,
    'paid_total', v_paid + v_amount,
    'remaining', v_decision.decided_amount - v_paid - v_amount
  );
END;
$$;

REVOKE ALL ON FUNCTION public.book_dividend_payment(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.book_dividend_payment(uuid, uuid, uuid, uuid) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
