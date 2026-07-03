-- Batch 1 — VAT & invoice compliance hardening
--
-- 1) invoices.sale_type — goods/services discrimination for zero-rated sales.
--    Per ML 6 kap (varor) vs 6 kap 33-34 §§ (tjänster) the momsdeklaration
--    separates varuförsäljning EU (ruta 35, BAS 3108) from tjänsteförsäljning
--    EU (ruta 39, BAS 3308), and export of goods (ruta 36, 3105) from services
--    (ruta 40, 3305). Existing rows default to 'services' — that is what the
--    engine always booked before this migration, so history is unchanged.
--
-- 2) supplier_invoices.reverse_charge_type — classifies WHY a purchase is
--    reverse charged so the booking engine can pick the right basbelopp
--    account series (ruta 20-24):
--      eu_goods      → 4515/4516/4517 (ruta 20)
--      eu_services   → 4535/4536/4537 (ruta 21)
--      construction  → 4425/4426/4427 (ruta 24, ML 16 kap 13 §)
--      electronics   → 4415/4416/4417 (ruta 23, ML 16 kap 17 §)
--      import        → import VAT path (4545-4547 basis, 2615/2625/2635)
--    NULL keeps the pre-migration inference from supplier country.
--
-- 3) company_settings: blandad verksamhet + frivillig skattskyldighet.
--      vat_deduction_percent — proportionell avdragsrätt (ML 13 kap 29 §).
--        100 = full avdragsrätt (default, unchanged behaviour). Companies
--        with both momspliktig and momsfri verksamhet set their skälig
--        grund percentage; the booking engine splits ingående moms into a
--        deductible part (2641) and a non-deductible part (cost).
--      voluntary_vat_rental — frivillig beskattning för lokaluthyrning
--        (ML 12 kap). Informational flag consumed by booking templates and
--        VAT report guidance (accounts 2613/2642/2646).
--
-- 4) assets: capital-goods VAT adjustment (jämkning) base model per
--    ML 15 kap (investeringsvaror). Records the input VAT deducted at
--    acquisition and the correction period so ANY trigger event (changed
--    use, transfer, entry/exit of frivillig beskattning) can be computed —
--    not only disposal (which already has jamkning_* columns from
--    20260526120300). Assets qualify as investeringsvara when input VAT
--    ≥ 50 000 kr (movable) / ≥ 100 000 kr (real property).

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS sale_type TEXT NOT NULL DEFAULT 'services';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'invoices_sale_type_check'
  ) THEN
    ALTER TABLE public.invoices
      ADD CONSTRAINT invoices_sale_type_check
      CHECK (sale_type IN ('goods', 'services'));
  END IF;
END $$;

ALTER TABLE public.supplier_invoices
  ADD COLUMN IF NOT EXISTS reverse_charge_type TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'supplier_invoices_reverse_charge_type_check'
  ) THEN
    ALTER TABLE public.supplier_invoices
      ADD CONSTRAINT supplier_invoices_reverse_charge_type_check
      CHECK (
        reverse_charge_type IS NULL OR reverse_charge_type IN (
          'eu_goods', 'eu_services', 'construction', 'electronics', 'import'
        )
      );
  END IF;
END $$;

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS vat_deduction_percent NUMERIC(5, 2) NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS voluntary_vat_rental BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'company_settings_vat_deduction_percent_check'
  ) THEN
    ALTER TABLE public.company_settings
      ADD CONSTRAINT company_settings_vat_deduction_percent_check
      CHECK (vat_deduction_percent >= 0 AND vat_deduction_percent <= 100);
  END IF;
END $$;

-- Capital-goods jämkning base model (ML 15 kap). Acquisition-side inputs:
-- the actual input VAT deducted and the correction period. The existing
-- jamkning_* columns from 20260526120300 remain the disposal-event record.
ALTER TABLE public.assets
  ADD COLUMN IF NOT EXISTS acquisition_input_vat NUMERIC(15, 2) NULL,
  ADD COLUMN IF NOT EXISTS vat_correction_total_months INT NULL,
  ADD COLUMN IF NOT EXISTS is_investeringsvara BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assets_vat_correction_months_check'
  ) THEN
    ALTER TABLE public.assets
      ADD CONSTRAINT assets_vat_correction_months_check
      CHECK (
        vat_correction_total_months IS NULL
        OR vat_correction_total_months IN (60, 120)
      );
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
