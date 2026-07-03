-- Batch 4 — duplicate flagging at document intake.
--
-- When an inbox item is extracted, the intake pipeline checks whether the
-- extracted invoice number / OCR already exists (as another inbox item or a
-- registered supplier invoice for the same supplier). A hit does not block —
-- the document is still archived (BFL) — but the item is flagged so the UI
-- can warn before the user registers a double.

alter table public.invoice_inbox_items
  add column if not exists duplicate_of_supplier_invoice_id uuid null
    references public.supplier_invoices(id) on delete set null,
  add column if not exists duplicate_of_inbox_item_id uuid null
    references public.invoice_inbox_items(id) on delete set null,
  add column if not exists duplicate_reason text null;

comment on column public.invoice_inbox_items.duplicate_reason is
  'Set at intake when the extracted invoice number/OCR matches an existing supplier invoice or inbox item: invoice_number_match | ocr_match. NULL = no duplicate signal.';

NOTIFY pgrst, 'reload schema';
