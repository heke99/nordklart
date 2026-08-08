-- Restore the source_type re-tag carve-out that mark_entry_as_opening_balance()
-- depends on.
--
-- 20260613120000_mark_entry_as_opening_balance.sql introduced a paired
-- mechanism: the RPC sets a transaction-local
--   nordklart.allow_source_type_retag = 'true'
-- and enforce_journal_entry_immutability() carries a matching carve-out that
-- permits exactly that one re-tag.
--
-- 20260801140000_production_financial_atomicity_and_billing_lifecycle.sql
-- rewrote enforce_journal_entry_immutability() in full and did not carry the
-- carve-out over. The RPC still sets the flag, but nothing reads it, so
-- mark_entry_as_opening_balance() now always fails with
--   Cannot modify a posted journal entry (...). Committed entries are immutable.
-- Verified on the live database 2026-08-07: production's RPC sets the GUC and
-- production's trigger does not honour it, so re-tagging an opening balance is
-- broken there too.
--
-- This restores the ORIGINAL carve-out verbatim in scope. It is deliberately
-- the narrowest possible exception and does not weaken immutability:
--   * status must be unchanged AND already 'posted'
--   * the transaction-local flag must be set by the RPC
--   * source_type may only move 'manual'/'import' -> 'opening_balance'
--   * source_type must be the SOLE changed column, proved by a whole-row
--     to_jsonb diff (updated_at exempted, as elsewhere in this function)
-- Any other field delta, any status change, or a missing flag still falls
-- through to the same RAISE as before.
--
-- Everything else in the function is reproduced unchanged from 20260801140000.
--
-- pg-test: covered-by tests/pg/mark-entry-as-opening-balance.pg.test.ts

BEGIN;

CREATE OR REPLACE FUNCTION public.enforce_journal_entry_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('nordklart.allow_delete', true) = 'true' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Cannot delete journal entries (id: %, status: %).', OLD.id, OLD.status
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'draft' AND NEW.status IN ('draft', 'posted', 'cancelled') THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'posted' AND NEW.status = 'reversed' THEN
    IF NEW.reversed_by_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM public.journal_entries reversal
      WHERE reversal.id = NEW.reversed_by_id
        AND reversal.company_id = OLD.company_id
        AND reversal.reverses_id = OLD.id
        AND reversal.status = 'posted'
    ) THEN
      RAISE EXCEPTION 'A posted entry can only be reversed by a posted, mutually linked correction entry.'
        USING ERRCODE = '55000', DETAIL = '{"code":"REVERSAL_LINK_REQUIRED"}';
    END IF;
    IF NEW.description IS DISTINCT FROM OLD.description
       OR NEW.entry_date IS DISTINCT FROM OLD.entry_date
       OR NEW.fiscal_period_id IS DISTINCT FROM OLD.fiscal_period_id
       OR NEW.voucher_number IS DISTINCT FROM OLD.voucher_number
       OR NEW.voucher_series IS DISTINCT FROM OLD.voucher_series
       OR NEW.commit_method IS DISTINCT FROM OLD.commit_method
       OR NEW.rubric_version IS DISTINCT FROM OLD.rubric_version
       OR NEW.source_voucher_series IS DISTINCT FROM OLD.source_voucher_series
       OR NEW.source_voucher_number IS DISTINCT FROM OLD.source_voucher_number THEN
      RAISE EXCEPTION 'Cannot modify fields of a posted entry during reversal (id: %)', OLD.id
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  -- Controlled un-reversal. delete_last_voucher() restores the original with
  -- `SET status = 'posted', reversed_by_id = NULL` — dropping the pointer to the
  -- storno being deleted is the entire point, and leaving it would dangle at a
  -- row that no longer exists. reversed_by_id is therefore exempt from the diff
  -- alongside status; every other column must still be untouched.
  IF OLD.status = 'reversed' AND NEW.status = 'posted'
     AND current_setting('nordklart.allow_delete', true) = 'true' THEN
    IF (to_jsonb(NEW) - 'status' - 'reversed_by_id' - 'updated_at')
       <> (to_jsonb(OLD) - 'status' - 'reversed_by_id' - 'updated_at') THEN
      RAISE EXCEPTION 'Cannot modify fields during controlled un-reversal (id: %)', OLD.id
        USING ERRCODE = '55000';
    END IF;
    IF NEW.reversed_by_id IS NOT NULL THEN
      RAISE EXCEPTION 'Controlled un-reversal must clear reversed_by_id (id: %)', OLD.id
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = NEW.status
     AND OLD.status IN ('posted', 'reversed', 'cancelled')
     AND (to_jsonb(NEW) - 'notes' - 'updated_at') = (to_jsonb(OLD) - 'notes' - 'updated_at') THEN
    RETURN NEW;
  END IF;

  -- Restored carve-out: controlled source_type re-tag to opening_balance.
  IF OLD.status = NEW.status
     AND OLD.status = 'posted'
     AND current_setting('nordklart.allow_source_type_retag', true) = 'true'
     AND OLD.source_type IN ('manual', 'import')
     AND NEW.source_type = 'opening_balance'
     AND (to_jsonb(NEW) - 'source_type' - 'updated_at')
       = (to_jsonb(OLD) - 'source_type' - 'updated_at') THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'posted' AND NEW.status = 'cancelled' THEN
    RAISE EXCEPTION 'Posted journal entries must be corrected through a linked reversal.'
      USING ERRCODE = '55000', DETAIL = '{"code":"POSTED_ENTRY_REQUIRES_REVERSAL"}';
  END IF;

  RAISE EXCEPTION 'Cannot modify a % journal entry (id: %). Committed entries are immutable.', OLD.status, OLD.id
    USING ERRCODE = '55000';
END;
$function$;

COMMIT;

NOTIFY pgrst, 'reload schema';
