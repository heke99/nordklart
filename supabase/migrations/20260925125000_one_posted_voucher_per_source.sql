-- At most one posted voucher per business document.
--
-- An invoice, a credit note, a supplier invoice, a supplier credit note and a
-- bank transaction are each booked by exactly one voucher (source_type +
-- source_id). Several routes posted that voucher and then updated the
-- document in a separate request; a double-click, a lost response or a
-- concurrent send could post it twice (audit 2026-09-25). A storno'd voucher
-- has status 'reversed', so re-booking after a storno stays possible.
--
-- A trigger rather than a unique index: an index would fail to build on any
-- database that already holds such a duplicate, and those must be resolved by
-- storno, not by the migration. The trigger stops every NEW duplicate — on
-- commit (draft → posted) and on direct posted inserts — under an advisory
-- lock per document, so two concurrent commits cannot both pass the check.
--
-- pg-test: tests/pg/one-posted-voucher-per-source.pg.test.ts

BEGIN;

CREATE OR REPLACE FUNCTION public.enforce_one_posted_voucher_per_source()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status <> 'posted'
     OR NEW.source_id IS NULL
     OR NEW.source_type NOT IN ('invoice_created', 'credit_note', 'supplier_invoice_registered', 'supplier_credit_note', 'bank_transaction') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'posted' THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.company_id::text || ':source_voucher:' || NEW.source_type || ':' || NEW.source_id::text, 0));

  IF EXISTS (
    SELECT 1 FROM public.journal_entries je
     WHERE je.company_id = NEW.company_id
       AND je.source_type = NEW.source_type
       AND je.source_id = NEW.source_id
       AND je.status = 'posted'
       AND je.id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'Dokumentet är redan bokfört (%).', NEW.source_type
      USING ERRCODE = '23505', DETAIL = '{"code":"SOURCE_ALREADY_BOOKED"}';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_one_posted_voucher_per_source ON public.journal_entries;
CREATE TRIGGER enforce_one_posted_voucher_per_source
  BEFORE INSERT OR UPDATE OF status ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.enforce_one_posted_voucher_per_source();

CREATE INDEX IF NOT EXISTS idx_journal_entries_posted_source
  ON public.journal_entries (company_id, source_type, source_id)
  WHERE status = 'posted' AND source_id IS NOT NULL;

COMMIT;
