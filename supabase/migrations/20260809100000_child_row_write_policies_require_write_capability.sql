-- Child rows inherit their parent's write gate, not just its tenancy.
--
-- 20260808170000 swapped 147 write policies from "is a member" to "may write
-- for this company". That sweep was built from tables carrying their own
-- `company_id` column, and so it missed the tables that reach tenancy through
-- a parent:
--
--   supplier_invoice_items -> supplier_invoices.company_id
--   receipt_line_items     -> receipts.company_id
--   agent_messages         -> agent_conversations.company_id
--
-- Their predicates still read `parent.company_id IN (SELECT user_company_ids())`,
-- which is membership. So a viewer could not touch a supplier invoice — but
-- could still INSERT, UPDATE and DELETE its line items, and those lines are
-- where the amounts, VAT rates and account numbers live. Rewriting a line is
-- rewriting the invoice.
--
-- The same shape applied to receipt_line_items (the underlag behind a booked
-- expense) and to agent_messages, whose parent was made owner-scoped in
-- 20260808180000 — a member could still write messages into another member's
-- conversation.
--
-- Fix: the two economic tables require write capability for the parent's
-- company. agent_messages mirrors its parent exactly — membership AND the
-- conversation must belong to the caller.
--
-- The guard in tests/pg/tenant-isolation-matrix.pg.test.ts is widened in the
-- same change so it no longer only inspects tables with their own company_id;
-- that filter is the reason this survived the first sweep.

-- supplier_invoice_items ------------------------------------------------------
DROP POLICY IF EXISTS supplier_invoice_items_insert ON public.supplier_invoice_items;
CREATE POLICY supplier_invoice_items_insert ON public.supplier_invoice_items FOR INSERT TO public
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.supplier_invoices si
      WHERE si.id = supplier_invoice_items.supplier_invoice_id
        AND public.user_can_write_company(si.company_id)
    )
  );

DROP POLICY IF EXISTS supplier_invoice_items_update ON public.supplier_invoice_items;
CREATE POLICY supplier_invoice_items_update ON public.supplier_invoice_items FOR UPDATE TO public
  USING (
    EXISTS (
      SELECT 1 FROM public.supplier_invoices si
      WHERE si.id = supplier_invoice_items.supplier_invoice_id
        AND public.user_can_write_company(si.company_id)
    )
  );

DROP POLICY IF EXISTS supplier_invoice_items_delete ON public.supplier_invoice_items;
CREATE POLICY supplier_invoice_items_delete ON public.supplier_invoice_items FOR DELETE TO public
  USING (
    EXISTS (
      SELECT 1 FROM public.supplier_invoices si
      WHERE si.id = supplier_invoice_items.supplier_invoice_id
        AND public.user_can_write_company(si.company_id)
    )
  );

-- receipt_line_items ----------------------------------------------------------
DROP POLICY IF EXISTS receipt_line_items_insert ON public.receipt_line_items;
CREATE POLICY receipt_line_items_insert ON public.receipt_line_items FOR INSERT TO public
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.receipts r
      WHERE r.id = receipt_line_items.receipt_id
        AND public.user_can_write_company(r.company_id)
    )
  );

DROP POLICY IF EXISTS receipt_line_items_update ON public.receipt_line_items;
CREATE POLICY receipt_line_items_update ON public.receipt_line_items FOR UPDATE TO public
  USING (
    EXISTS (
      SELECT 1 FROM public.receipts r
      WHERE r.id = receipt_line_items.receipt_id
        AND public.user_can_write_company(r.company_id)
    )
  );

DROP POLICY IF EXISTS receipt_line_items_delete ON public.receipt_line_items;
CREATE POLICY receipt_line_items_delete ON public.receipt_line_items FOR DELETE TO public
  USING (
    EXISTS (
      SELECT 1 FROM public.receipts r
      WHERE r.id = receipt_line_items.receipt_id
        AND public.user_can_write_company(r.company_id)
    )
  );

-- agent_messages --------------------------------------------------------------
-- Mirrors 20260808180000: a conversation is personal, so a message may only be
-- written into a conversation the caller owns, in a company they belong to.
-- Write capability is deliberately NOT required — a viewer must be able to talk
-- to the assistant.
DROP POLICY IF EXISTS agent_messages_insert ON public.agent_messages;
CREATE POLICY agent_messages_insert ON public.agent_messages FOR INSERT TO public
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.agent_conversations ac
      WHERE ac.id = agent_messages.conversation_id
        AND ac.company_id IN (SELECT public.user_company_ids())
        AND ac.user_id = auth.uid()
    )
  );

NOTIFY pgrst, 'reload schema';
