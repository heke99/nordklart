-- Lagerförändring vid bokslut: race-safe commit.
--
-- app/api/bookkeeping/fiscal-periods/[id]/inventory posted the adjustment
-- with createJournalEntry after reading each inventory account's booked
-- balance. Two requests at once (a double click, two tabs) both read the same
-- balance and both booked the difference, so the inventory was adjusted
-- twice.
--
-- The route now creates the voucher as a draft and calls
-- commit_inventory_adjustment() with the balances it computed the draft from.
-- Under an advisory lock per company and fiscal year the RPC re-reads each
-- balance, refuses if any moved (INVENTORY_BALANCE_CHANGED — the loser's draft
-- is cancelled and the user re-counts from the new balance), checks the draft
-- only pairs an inventory account with its BAS change account, and commits it.
--
-- pg-test: tests/pg/commit-inventory-adjustment.pg.test.ts

BEGIN;

CREATE OR REPLACE FUNCTION public.commit_inventory_adjustment(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_draft_entry_id uuid,
  p_expected jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text := coalesce(auth.role(), current_user::text);
  v_period public.fiscal_periods%ROWTYPE;
  v_draft public.journal_entries%ROWTYPE;
  -- lib/bokslut/inventory/inventory-valuation.ts INVENTORY_CHANGE_ACCOUNTS
  v_map jsonb := '{"1410":"4910","1440":"4940","1450":"4950","1460":"4960","1465":"4960","1470":"4970"}'::jsonb;
  v_account text;
  v_expected numeric;
  v_current numeric;
BEGIN
  IF v_role NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'INVENTORY_SERVICE_ONLY' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_expected) <> 'object' OR p_expected = '{}'::jsonb THEN
    RAISE EXCEPTION 'INVENTORY_DRAFT_INVALID' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat_ws(':', 'inventory-adjustment', p_company_id, p_fiscal_period_id), 0
  ));

  SELECT * INTO v_period FROM public.fiscal_periods
   WHERE id = p_fiscal_period_id AND company_id = p_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVENTORY_PERIOD_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_period.is_closed OR v_period.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'INVENTORY_PERIOD_CLOSED' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_draft FROM public.journal_entries
   WHERE id = p_draft_entry_id AND company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_draft.status <> 'draft'
     OR v_draft.source_type <> 'year_end_inventory'
     OR v_draft.fiscal_period_id <> p_fiscal_period_id
     OR v_draft.entry_date <> v_period.period_end THEN
    RAISE EXCEPTION 'INVENTORY_DRAFT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- Every expected account is an inventory account.
  FOR v_account IN SELECT jsonb_object_keys(p_expected) LOOP
    IF NOT v_map ? v_account THEN
      RAISE EXCEPTION 'INVENTORY_DRAFT_INVALID' USING ERRCODE = '22023',
        DETAIL = format('%s is not an inventory account', v_account);
    END IF;
  END LOOP;

  -- Lines touch only the counted inventory accounts and their change accounts.
  IF EXISTS (
    SELECT 1 FROM public.journal_entry_lines l
     WHERE l.journal_entry_id = v_draft.id
       AND NOT (
         p_expected ? l.account_number
         OR l.account_number IN (
           SELECT v_map->>k FROM jsonb_object_keys(p_expected) k
         )
       )
  ) OR NOT EXISTS (
    SELECT 1 FROM public.journal_entry_lines l WHERE l.journal_entry_id = v_draft.id
  ) THEN
    RAISE EXCEPTION 'INVENTORY_DRAFT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- The balances the draft was computed from must still hold.
  FOR v_account, v_expected IN
    SELECT key, value::text::numeric FROM jsonb_each(p_expected)
  LOOP
    -- __ledger_balance_at is credit-positive; inventory is debit-normal.
    v_current := -public.__ledger_balance_at(p_company_id, v_account, v_account, v_period.period_end);
    IF abs(v_current - round(v_expected, 2)) >= 0.005 THEN
      RAISE EXCEPTION 'INVENTORY_BALANCE_CHANGED' USING ERRCODE = '40001',
        DETAIL = format('account=%s expected=%s current=%s', v_account, v_expected, v_current);
    END IF;
  END LOOP;

  PERFORM public.commit_journal_entry(p_company_id, v_draft.id, NULL, NULL, NULL, NULL);

  RETURN jsonb_build_object('journal_entry_id', v_draft.id);
END;
$$;

REVOKE ALL ON FUNCTION public.commit_inventory_adjustment(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_inventory_adjustment(uuid, uuid, uuid, jsonb) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
