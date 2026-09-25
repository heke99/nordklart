-- Linking a bank transaction to an existing voucher (and optionally the
-- invoice it pays) is one transaction.
--
-- lib/transactions/link-journal-entry.ts wrote the transaction link, the
-- invoice's paid/remaining amounts and the invoice_payments row as three
-- requests, with "rollbacks" that restored stale snapshots without a guard
-- (clobbering a concurrent winner) and a transaction update whose row count
-- was never checked. link_transaction_to_existing_voucher() does the three
-- writes under row locks on the transaction and the invoice: all or nothing.
--
-- pg-test: tests/pg/link-transaction-to-voucher.pg.test.ts

BEGIN;

CREATE OR REPLACE FUNCTION public.link_transaction_to_existing_voucher(
  p_company_id uuid,
  p_user_id uuid,
  p_transaction_id uuid,
  p_journal_entry_id uuid,
  p_invoice_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tx public.transactions%ROWTYPE;
  v_inv public.invoices%ROWTYPE;
  v_je public.journal_entries%ROWTYPE;
  v_remaining numeric;
  v_new_paid numeric;
  v_new_remaining numeric;
  v_new_status text;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.user_can_write_company(p_company_id) THEN
    RAISE EXCEPTION 'write access required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_tx FROM public.transactions
   WHERE id = p_transaction_id AND company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'TX_CATEGORIZE_TX_NOT_FOUND');
  END IF;
  IF v_tx.journal_entry_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_TX_TX_ALREADY_LINKED',
      'details', jsonb_build_object('existingJournalEntryId', v_tx.journal_entry_id));
  END IF;

  SELECT * INTO v_je FROM public.journal_entries
   WHERE id = p_journal_entry_id AND company_id = p_company_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_TX_JE_NOT_FOUND');
  END IF;
  IF v_je.status <> 'posted' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_TX_JE_NOT_POSTED',
      'details', jsonb_build_object('currentStatus', v_je.status));
  END IF;

  IF p_invoice_id IS NOT NULL THEN
    SELECT * INTO v_inv FROM public.invoices
     WHERE id = p_invoice_id AND company_id = p_company_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LINK_TX_INVOICE_NOT_FOUND');
    END IF;
    IF v_inv.status NOT IN ('sent', 'overdue', 'partially_paid') THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LINK_TX_INVOICE_NOT_OPEN',
        'details', jsonb_build_object('currentStatus', v_inv.status));
    END IF;
    IF v_tx.currency IS DISTINCT FROM v_inv.currency THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LINK_TX_INVOICE_CURRENCY_MISMATCH',
        'details', jsonb_build_object('transactionCurrency', v_tx.currency, 'invoiceCurrency', v_inv.currency));
    END IF;

    v_new_paid := round(coalesce(v_inv.paid_amount, 0) + v_tx.amount, 2);
    v_remaining := coalesce(v_inv.remaining_amount, v_inv.total - coalesce(v_inv.paid_amount, 0));
    v_new_remaining := greatest(0, round(v_remaining - v_tx.amount, 2));
    v_new_status := CASE WHEN v_new_remaining <= 0 THEN 'paid' ELSE 'partially_paid' END;

    UPDATE public.invoices
       SET status = v_new_status,
           paid_at = CASE WHEN v_new_status = 'paid' THEN now() ELSE NULL END,
           paid_amount = v_new_paid,
           remaining_amount = v_new_remaining
     WHERE id = p_invoice_id AND company_id = p_company_id;

    INSERT INTO public.invoice_payments (
      user_id, company_id, invoice_id, payment_date, amount, currency, exchange_rate,
      journal_entry_id, transaction_id, notes
    ) VALUES (
      p_user_id, p_company_id, p_invoice_id, v_tx.date, v_tx.amount, v_inv.currency, v_tx.exchange_rate,
      p_journal_entry_id, p_transaction_id, 'Kopplad till befintlig verifikation (ingen ny bokföring skapad)'
    );
  END IF;

  UPDATE public.transactions
     SET journal_entry_id = p_journal_entry_id,
         invoice_id = p_invoice_id,
         potential_invoice_id = NULL,
         potential_supplier_invoice_id = NULL,
         is_business = true
   WHERE id = p_transaction_id AND company_id = p_company_id;

  RETURN jsonb_build_object(
    'ok', true,
    'invoiceStatus', CASE WHEN p_invoice_id IS NULL THEN NULL ELSE v_new_status END,
    'paidAmount', v_new_paid,
    'remainingAmount', v_new_remaining
  );
END;
$$;

REVOKE ALL ON FUNCTION public.link_transaction_to_existing_voucher(uuid, uuid, uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_transaction_to_existing_voucher(uuid, uuid, uuid, uuid, uuid) TO authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
