-- Nordklart Accounting Intelligence Core
-- Adds rule-decision/audit storage and hardens fixed assets for property,
-- direct-deduction and mixed-use workflows. Idempotent so it can be applied
-- safely after the existing 347+ migration baseline.

-- ============================================================
-- assets: property + classification metadata
-- ============================================================
ALTER TABLE public.assets
  ADD COLUMN IF NOT EXISTS asset_subtype TEXT,
  ADD COLUMN IF NOT EXISTS property_kind TEXT,
  ADD COLUMN IF NOT EXISTS land_value NUMERIC(15, 2),
  ADD COLUMN IF NOT EXISTS building_value NUMERIC(15, 2),
  ADD COLUMN IF NOT EXISTS tax_depreciation_rate NUMERIC(7, 4),
  ADD COLUMN IF NOT EXISTS accounting_depreciation_rate NUMERIC(7, 4),
  ADD COLUMN IF NOT EXISTS accounting_depreciation_model TEXT,
  ADD COLUMN IF NOT EXISTS acquisition_source_document_id UUID,
  ADD COLUMN IF NOT EXISTS supplier_invoice_id UUID,
  ADD COLUMN IF NOT EXISTS bank_transaction_id UUID,
  ADD COLUMN IF NOT EXISTS private_use_percentage NUMERIC(7, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS business_use_percentage NUMERIC(7, 4) NOT NULL DEFAULT 100;

UPDATE public.assets
SET asset_subtype = CASE
    WHEN category = 'building' THEN 'building'
    WHEN category = 'land_improvement' THEN 'land_improvement'
    ELSE 'standard'
  END
WHERE asset_subtype IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assets_asset_subtype_check'
  ) THEN
    ALTER TABLE public.assets
      ADD CONSTRAINT assets_asset_subtype_check
      CHECK (asset_subtype IS NULL OR asset_subtype IN (
        'standard', 'building', 'land', 'land_improvement',
        'property_component', 'low_value_inventory', 'short_life_inventory'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assets_property_kind_check'
  ) THEN
    ALTER TABLE public.assets
      ADD CONSTRAINT assets_property_kind_check
      CHECK (property_kind IS NULL OR property_kind IN (
        'hyreshus', 'industribyggnad', 'ekonomibyggnad', 'ovrig', 'mixed'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assets_accounting_depreciation_model_check'
  ) THEN
    ALTER TABLE public.assets
      ADD CONSTRAINT assets_accounting_depreciation_model_check
      CHECK (accounting_depreciation_model IS NULL OR accounting_depreciation_model IN (
        'k2_single_unit', 'k3_components', 'tax_plan'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assets_property_amounts_check'
  ) THEN
    ALTER TABLE public.assets
      ADD CONSTRAINT assets_property_amounts_check
      CHECK (
        coalesce(land_value, 0) >= 0
        AND coalesce(building_value, 0) >= 0
        AND coalesce(land_value, 0) + coalesce(building_value, 0) <= acquisition_cost + 1
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assets_use_percentages_check'
  ) THEN
    ALTER TABLE public.assets
      ADD CONSTRAINT assets_use_percentages_check
      CHECK (
        private_use_percentage BETWEEN 0 AND 100
        AND business_use_percentage BETWEEN 0 AND 100
        AND round((private_use_percentage + business_use_percentage)::numeric, 4) = 100
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assets_rates_check'
  ) THEN
    ALTER TABLE public.assets
      ADD CONSTRAINT assets_rates_check
      CHECK (
        (tax_depreciation_rate IS NULL OR tax_depreciation_rate BETWEEN 0 AND 100)
        AND (accounting_depreciation_rate IS NULL OR accounting_depreciation_rate BETWEEN 0 AND 100)
      );
  END IF;
END $$;


-- Extend disposed-asset immutability to the new property/use fields. Notes are
-- still editable, but financial allocation and source links must stay stable.
CREATE OR REPLACE FUNCTION public.enforce_asset_post_disposal_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.disposed_at IS NOT NULL THEN
    IF NEW.acquisition_cost IS DISTINCT FROM OLD.acquisition_cost
       OR NEW.salvage_value IS DISTINCT FROM OLD.salvage_value
       OR NEW.useful_life_months IS DISTINCT FROM OLD.useful_life_months
       OR NEW.depreciation_method IS DISTINCT FROM OLD.depreciation_method
       OR NEW.restvarde_target IS DISTINCT FROM OLD.restvarde_target
       OR NEW.bas_asset_account IS DISTINCT FROM OLD.bas_asset_account
       OR NEW.bas_accumulated_account IS DISTINCT FROM OLD.bas_accumulated_account
       OR NEW.bas_expense_account IS DISTINCT FROM OLD.bas_expense_account
       OR NEW.acquisition_date IS DISTINCT FROM OLD.acquisition_date
       OR NEW.asset_subtype IS DISTINCT FROM OLD.asset_subtype
       OR NEW.property_kind IS DISTINCT FROM OLD.property_kind
       OR NEW.land_value IS DISTINCT FROM OLD.land_value
       OR NEW.building_value IS DISTINCT FROM OLD.building_value
       OR NEW.tax_depreciation_rate IS DISTINCT FROM OLD.tax_depreciation_rate
       OR NEW.accounting_depreciation_rate IS DISTINCT FROM OLD.accounting_depreciation_rate
       OR NEW.accounting_depreciation_model IS DISTINCT FROM OLD.accounting_depreciation_model
       OR NEW.private_use_percentage IS DISTINCT FROM OLD.private_use_percentage
       OR NEW.business_use_percentage IS DISTINCT FROM OLD.business_use_percentage
       OR NEW.acquisition_source_document_id IS DISTINCT FROM OLD.acquisition_source_document_id
       OR NEW.supplier_invoice_id IS DISTINCT FROM OLD.supplier_invoice_id
       OR NEW.bank_transaction_id IS DISTINCT FROM OLD.bank_transaction_id THEN
      RAISE EXCEPTION 'Cannot modify financial attributes of a disposed asset (id=%)', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE INDEX IF NOT EXISTS idx_assets_property_kind ON public.assets (company_id, property_kind) WHERE property_kind IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_assets_source_document ON public.assets (company_id, acquisition_source_document_id) WHERE acquisition_source_document_id IS NOT NULL;

COMMENT ON COLUMN public.assets.land_value IS 'Non-depreciable land allocation for property purchases. Depreciation engine excludes this value from depreciation base.';
COMMENT ON COLUMN public.assets.building_value IS 'Depreciable building allocation for property purchases. K3 components should sum to this value when present.';
COMMENT ON COLUMN public.assets.private_use_percentage IS 'Private share of asset use. Must sum with business_use_percentage to 100.';
COMMENT ON COLUMN public.assets.business_use_percentage IS 'Business share of asset use. Must sum with private_use_percentage to 100.';

-- ============================================================
-- Rule decisions and manual overrides
-- ============================================================
CREATE TABLE IF NOT EXISTS public.accounting_rule_decisions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  source_type TEXT NOT NULL CHECK (source_type IN (
    'bank_transaction', 'supplier_invoice', 'receipt', 'customer_invoice', 'manual', 'asset'
  )),
  source_id UUID,
  decision TEXT NOT NULL CHECK (decision IN ('expense', 'asset', 'private', 'mixed', 'review_required')),
  account_number TEXT CHECK (account_number IS NULL OR account_number ~ '^\d{4}$'),
  vat_treatment TEXT NOT NULL,
  deductible_percentage NUMERIC(7, 4) NOT NULL DEFAULT 100 CHECK (deductible_percentage BETWEEN 0 AND 100),
  private_percentage NUMERIC(7, 4) NOT NULL DEFAULT 0 CHECK (private_percentage BETWEEN 0 AND 100),
  reason_code TEXT NOT NULL,
  explanation_sv TEXT NOT NULL,
  review_severity TEXT NOT NULL CHECK (review_severity IN ('none', 'info', 'warning', 'danger', 'blocking')),
  required_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  suggested_asset JSONB,
  rule_version TEXT NOT NULL DEFAULT '2026.1',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_accounting_rule_decisions_company_source
  ON public.accounting_rule_decisions (company_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_accounting_rule_decisions_review
  ON public.accounting_rule_decisions (company_id, review_severity, created_at DESC);

ALTER TABLE public.accounting_rule_decisions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'accounting_rule_decisions' AND policyname = 'accounting_rule_decisions_select'
  ) THEN
    CREATE POLICY accounting_rule_decisions_select ON public.accounting_rule_decisions
      FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'accounting_rule_decisions' AND policyname = 'accounting_rule_decisions_insert'
  ) THEN
    CREATE POLICY accounting_rule_decisions_insert ON public.accounting_rule_decisions
      FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.accounting_manual_overrides (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  rule_decision_id UUID REFERENCES public.accounting_rule_decisions(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  source_type TEXT NOT NULL,
  source_id UUID,
  field_name TEXT NOT NULL,
  old_value JSONB,
  new_value JSONB NOT NULL,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'locked_period_correction')),
  reason TEXT,
  evidence_document_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_accounting_manual_overrides_company_source
  ON public.accounting_manual_overrides (company_id, source_type, source_id);

ALTER TABLE public.accounting_manual_overrides ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'accounting_manual_overrides' AND policyname = 'accounting_manual_overrides_select'
  ) THEN
    CREATE POLICY accounting_manual_overrides_select ON public.accounting_manual_overrides
      FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'accounting_manual_overrides' AND policyname = 'accounting_manual_overrides_insert'
  ) THEN
    CREATE POLICY accounting_manual_overrides_insert ON public.accounting_manual_overrides
      FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.accounting_review_queue (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  rule_decision_id UUID REFERENCES public.accounting_rule_decisions(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_id UUID,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'danger', 'blocking')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_review', 'resolved', 'dismissed')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  assigned_to UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_accounting_review_queue_company_status
  ON public.accounting_review_queue (company_id, status, severity, created_at DESC);

ALTER TABLE public.accounting_review_queue ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'accounting_review_queue' AND policyname = 'accounting_review_queue_select'
  ) THEN
    CREATE POLICY accounting_review_queue_select ON public.accounting_review_queue
      FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'accounting_review_queue' AND policyname = 'accounting_review_queue_insert'
  ) THEN
    CREATE POLICY accounting_review_queue_insert ON public.accounting_review_queue
      FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'accounting_review_queue' AND policyname = 'accounting_review_queue_update'
  ) THEN
    CREATE POLICY accounting_review_queue_update ON public.accounting_review_queue
      FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
      WITH CHECK (company_id IN (SELECT public.user_company_ids()));
  END IF;
END $$;

DROP TRIGGER IF EXISTS accounting_review_queue_updated_at ON public.accounting_review_queue;
CREATE TRIGGER accounting_review_queue_updated_at
  BEFORE UPDATE ON public.accounting_review_queue
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

NOTIFY pgrst, 'reload schema';
