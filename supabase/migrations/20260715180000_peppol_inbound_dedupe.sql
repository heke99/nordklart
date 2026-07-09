-- Peppol inbound replay protection.
--
-- Access-point webhooks are at-least-once: a redelivered inbound invoice
-- previously created a duplicate e_invoice_deliveries row AND a duplicate
-- WORM document, which then surfaced as a duplicate supplier invoice to
-- book. Deliveries now carry a content hash and inbound rows are unique per
-- (company, content) — the route acknowledges replays without side effects.
--
-- pg-test: covered-by tests/pg/webhook-dedupe.pg.test.ts

-- pgcrypto's digest() may live in `extensions` (Supabase default) or
-- `public` (older local setups) — make both resolvable for the backfill.
SET search_path = public, extensions;

ALTER TABLE public.e_invoice_deliveries
  ADD COLUMN IF NOT EXISTS content_sha256 text;

-- Backfill existing inbound rows so the unique index can be created even on
-- databases that already received deliveries.
UPDATE public.e_invoice_deliveries
SET content_sha256 = encode(digest(coalesce(ubl_xml, ''), 'sha256'), 'hex')
WHERE direction = 'inbound' AND content_sha256 IS NULL AND ubl_xml IS NOT NULL;

-- Defensive dedupe (keep the oldest row per content) before the unique index.
DELETE FROM public.e_invoice_deliveries d
USING (
  SELECT id, row_number() OVER (
    PARTITION BY company_id, content_sha256
    ORDER BY created_at ASC, id ASC
  ) AS rn
  FROM public.e_invoice_deliveries
  WHERE direction = 'inbound' AND content_sha256 IS NOT NULL
) ranked
WHERE d.id = ranked.id AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS e_invoice_deliveries_inbound_content_unique_idx
  ON public.e_invoice_deliveries (company_id, content_sha256)
  WHERE direction = 'inbound' AND content_sha256 IS NOT NULL;

NOTIFY pgrst, 'reload schema';
