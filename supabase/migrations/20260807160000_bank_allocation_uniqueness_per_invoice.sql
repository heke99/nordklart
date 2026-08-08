-- Correct the bank-allocation uniqueness key so one bank payment can settle
-- several invoices.
--
-- 20260801140000_production_financial_atomicity_and_billing_lifecycle.sql
-- hardened bank allocation with:
--   * UNIQUE (company_id, transaction_id) WHERE transaction_id IS NOT NULL
--     on invoice_payments and supplier_invoice_payments, and
--   * enforce_single_bank_payment_allocation(), which additionally rejects a
--     transaction that already has ANY payment row in EITHER table.
--
-- That key is wrong. public.match_batch_allocate() inserts one payment row per
-- invoice, all carrying the same transaction_id, because a single bankgiro
-- payment settling several supplier invoices is ordinary Swedish AP practice
-- and is precisely what batch allocation exists to do. Under the old key the
-- second row always failed with BANK_TRANSACTION_ALREADY_ALLOCATED, so batch
-- allocation of one transaction across multiple invoices was impossible.
-- Confirmed broken in production 2026-08-07 (same indexes, same trigger).
--
-- The intent of H-04 — a bank transaction must never be booked twice — is
-- preserved and made precise: uniqueness is per (transaction, invoice), which
-- is the pair that would constitute a genuine double-booking.
--
-- The economic invariant that the transaction is neither over- nor
-- under-allocated is NOT weakened: match_batch_allocate() already requires
-- v_total_allocated to equal ABS(transaction.amount) within 0.005 and aborts
-- with BATCH_OVER_ALLOCATED / BATCH_UNDER_ALLOCATED otherwise.
--
-- Both payment tables are empty in production, so the stricter per-pair indexes
-- cannot fail on existing data. The build is unconditional by design: an
-- invariant that silently downgrades itself when data is dirty is the H-04
-- failure mode this repository already rejected.
--
-- pg-test: covered-by tests/pg/match-batch-allocate.pg.test.ts

BEGIN;

DROP INDEX IF EXISTS public.invoice_payments_bank_tx_unique;
DROP INDEX IF EXISTS public.supplier_invoice_payments_bank_tx_unique;

CREATE UNIQUE INDEX IF NOT EXISTS invoice_payments_bank_tx_invoice_unique
  ON public.invoice_payments (company_id, transaction_id, invoice_id)
  WHERE transaction_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS supplier_invoice_payments_bank_tx_invoice_unique
  ON public.supplier_invoice_payments (company_id, transaction_id, supplier_invoice_id)
  WHERE transaction_id IS NOT NULL;

-- The trigger keeps its serialization role: locking the parent transactions row
-- still orders concurrent allocations that two independent partial indexes
-- cannot see between them. What changes is the predicate — it now rejects only
-- a second payment row for the SAME invoice on the same transaction, instead of
-- any second row anywhere.
CREATE OR REPLACE FUNCTION public.enforce_single_bank_payment_allocation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NEW.transaction_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Serialize every allocation touching this bank transaction, including races
  -- between the customer and supplier tables.
  PERFORM 1
  FROM public.transactions t
  WHERE t.id = NEW.transaction_id AND t.company_id = NEW.company_id
  FOR UPDATE;

  IF TG_TABLE_NAME = 'invoice_payments' THEN
    IF EXISTS (
      SELECT 1 FROM public.invoice_payments ip
      WHERE ip.company_id = NEW.company_id
        AND ip.transaction_id = NEW.transaction_id
        AND ip.invoice_id = NEW.invoice_id
        AND ip.id IS DISTINCT FROM NEW.id
    ) THEN
      RAISE EXCEPTION 'Bank transaction is already allocated to this invoice.'
        USING ERRCODE = '23505', DETAIL = '{"code":"BANK_TRANSACTION_ALREADY_ALLOCATED"}';
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1 FROM public.supplier_invoice_payments sip
      WHERE sip.company_id = NEW.company_id
        AND sip.transaction_id = NEW.transaction_id
        AND sip.supplier_invoice_id = NEW.supplier_invoice_id
        AND sip.id IS DISTINCT FROM NEW.id
    ) THEN
      RAISE EXCEPTION 'Bank transaction is already allocated to this supplier invoice.'
        USING ERRCODE = '23505', DETAIL = '{"code":"BANK_TRANSACTION_ALREADY_ALLOCATED"}';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

COMMIT;

NOTIFY pgrst, 'reload schema';
