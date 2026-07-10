-- RLS write-capability hardening.
--
-- Defensive production hotfix for the real Nordklart baseline.
-- The previous version assumed `public.skatteverket_company_settings` existed,
-- but the real database only has Skatteverket token/audit/request/catalog
-- objects. This migration now applies policies only to tables that exist and
-- never fails on optional modules being absent.
--
-- Covered by tests/pg/rls-write-capability.pg.test.ts

-- ============================================================
-- Helpers
-- ============================================================

DO $$
DECLARE
  pol record;
BEGIN
  -- Sanity: this migration is intentionally after 20260715160000, which
  -- defines user_can_write_company(). Give a clear error if migrations were
  -- applied out of order.
  IF to_regprocedure('public.user_can_write_company(uuid)') IS NULL THEN
    RAISE EXCEPTION 'public.user_can_write_company(uuid) is required before applying RLS write-capability hardening';
  END IF;
END $$;

-- ============================================================
-- 1. Invoices
-- ============================================================

DO $$
BEGIN
  IF to_regclass('public.invoices') IS NOT NULL THEN
    DROP POLICY IF EXISTS invoices_insert ON public.invoices;
    CREATE POLICY invoices_insert ON public.invoices
      FOR INSERT WITH CHECK (public.user_can_write_company(company_id));

    DROP POLICY IF EXISTS invoices_update ON public.invoices;
    CREATE POLICY invoices_update ON public.invoices
      FOR UPDATE USING (public.user_can_write_company(company_id))
      WITH CHECK (public.user_can_write_company(company_id));

    DROP POLICY IF EXISTS invoices_delete ON public.invoices;
    CREATE POLICY invoices_delete ON public.invoices
      FOR DELETE USING (public.user_can_write_company(company_id));
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.invoice_items') IS NOT NULL THEN
    DROP POLICY IF EXISTS invoice_items_insert ON public.invoice_items;
    CREATE POLICY invoice_items_insert ON public.invoice_items
      FOR INSERT WITH CHECK (EXISTS (
        SELECT 1 FROM public.invoices i
        WHERE i.id = invoice_id
          AND public.user_can_write_company(i.company_id)
      ));

    DROP POLICY IF EXISTS invoice_items_update ON public.invoice_items;
    CREATE POLICY invoice_items_update ON public.invoice_items
      FOR UPDATE USING (EXISTS (
        SELECT 1 FROM public.invoices i
        WHERE i.id = invoice_items.invoice_id
          AND public.user_can_write_company(i.company_id)
      ))
      WITH CHECK (EXISTS (
        SELECT 1 FROM public.invoices i
        WHERE i.id = invoice_items.invoice_id
          AND public.user_can_write_company(i.company_id)
      ));

    DROP POLICY IF EXISTS invoice_items_delete ON public.invoice_items;
    CREATE POLICY invoice_items_delete ON public.invoice_items
      FOR DELETE USING (EXISTS (
        SELECT 1 FROM public.invoices i
        WHERE i.id = invoice_items.invoice_id
          AND public.user_can_write_company(i.company_id)
      ));
  END IF;
END $$;

-- ============================================================
-- 2. Journal entries (drafts — posted rows stay trigger-immutable)
-- ============================================================

DO $$
BEGIN
  IF to_regclass('public.journal_entries') IS NOT NULL THEN
    DROP POLICY IF EXISTS journal_entries_insert ON public.journal_entries;
    CREATE POLICY journal_entries_insert ON public.journal_entries
      FOR INSERT WITH CHECK (public.user_can_write_company(company_id));

    DROP POLICY IF EXISTS journal_entries_update ON public.journal_entries;
    CREATE POLICY journal_entries_update ON public.journal_entries
      FOR UPDATE USING (public.user_can_write_company(company_id))
      WITH CHECK (public.user_can_write_company(company_id));

    DROP POLICY IF EXISTS journal_entries_delete ON public.journal_entries;
    CREATE POLICY journal_entries_delete ON public.journal_entries
      FOR DELETE USING (public.user_can_write_company(company_id));
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.journal_entry_lines') IS NOT NULL THEN
    DROP POLICY IF EXISTS journal_entry_lines_insert ON public.journal_entry_lines;
    CREATE POLICY journal_entry_lines_insert ON public.journal_entry_lines
      FOR INSERT WITH CHECK (EXISTS (
        SELECT 1 FROM public.journal_entries je
        WHERE je.id = journal_entry_id
          AND public.user_can_write_company(je.company_id)
      ));

    DROP POLICY IF EXISTS journal_entry_lines_update ON public.journal_entry_lines;
    CREATE POLICY journal_entry_lines_update ON public.journal_entry_lines
      FOR UPDATE USING (EXISTS (
        SELECT 1 FROM public.journal_entries je
        WHERE je.id = journal_entry_lines.journal_entry_id
          AND public.user_can_write_company(je.company_id)
      ))
      WITH CHECK (EXISTS (
        SELECT 1 FROM public.journal_entries je
        WHERE je.id = journal_entry_lines.journal_entry_id
          AND public.user_can_write_company(je.company_id)
      ));

    DROP POLICY IF EXISTS journal_entry_lines_delete ON public.journal_entry_lines;
    CREATE POLICY journal_entry_lines_delete ON public.journal_entry_lines
      FOR DELETE USING (EXISTS (
        SELECT 1 FROM public.journal_entries je
        WHERE je.id = journal_entry_lines.journal_entry_id
          AND public.user_can_write_company(je.company_id)
      ));
  END IF;
END $$;

-- ============================================================
-- 3. Recurring invoice schedules
-- ============================================================

DO $$
BEGIN
  IF to_regclass('public.recurring_invoice_schedules') IS NOT NULL THEN
    DROP POLICY IF EXISTS recurring_invoice_schedules_insert ON public.recurring_invoice_schedules;
    DROP POLICY IF EXISTS "recurring_invoice_schedules_insert" ON public.recurring_invoice_schedules;
    CREATE POLICY recurring_invoice_schedules_insert ON public.recurring_invoice_schedules
      FOR INSERT WITH CHECK (public.user_can_write_company(company_id));

    DROP POLICY IF EXISTS recurring_invoice_schedules_update ON public.recurring_invoice_schedules;
    DROP POLICY IF EXISTS "recurring_invoice_schedules_update" ON public.recurring_invoice_schedules;
    CREATE POLICY recurring_invoice_schedules_update ON public.recurring_invoice_schedules
      FOR UPDATE USING (public.user_can_write_company(company_id))
      WITH CHECK (public.user_can_write_company(company_id));

    DROP POLICY IF EXISTS recurring_invoice_schedules_delete ON public.recurring_invoice_schedules;
    DROP POLICY IF EXISTS "recurring_invoice_schedules_delete" ON public.recurring_invoice_schedules;
    CREATE POLICY recurring_invoice_schedules_delete ON public.recurring_invoice_schedules
      FOR DELETE USING (public.user_can_write_company(company_id));
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.recurring_invoice_schedule_items') IS NOT NULL THEN
    DROP POLICY IF EXISTS recurring_invoice_schedule_items_insert ON public.recurring_invoice_schedule_items;
    DROP POLICY IF EXISTS "recurring_invoice_schedule_items_insert" ON public.recurring_invoice_schedule_items;
    CREATE POLICY recurring_invoice_schedule_items_insert ON public.recurring_invoice_schedule_items
      FOR INSERT WITH CHECK (EXISTS (
        SELECT 1 FROM public.recurring_invoice_schedules s
        WHERE s.id = schedule_id
          AND public.user_can_write_company(s.company_id)
      ));

    DROP POLICY IF EXISTS recurring_invoice_schedule_items_update ON public.recurring_invoice_schedule_items;
    DROP POLICY IF EXISTS "recurring_invoice_schedule_items_update" ON public.recurring_invoice_schedule_items;
    CREATE POLICY recurring_invoice_schedule_items_update ON public.recurring_invoice_schedule_items
      FOR UPDATE USING (EXISTS (
        SELECT 1 FROM public.recurring_invoice_schedules s
        WHERE s.id = recurring_invoice_schedule_items.schedule_id
          AND public.user_can_write_company(s.company_id)
      ))
      WITH CHECK (EXISTS (
        SELECT 1 FROM public.recurring_invoice_schedules s
        WHERE s.id = recurring_invoice_schedule_items.schedule_id
          AND public.user_can_write_company(s.company_id)
      ));

    DROP POLICY IF EXISTS recurring_invoice_schedule_items_delete ON public.recurring_invoice_schedule_items;
    DROP POLICY IF EXISTS "recurring_invoice_schedule_items_delete" ON public.recurring_invoice_schedule_items;
    CREATE POLICY recurring_invoice_schedule_items_delete ON public.recurring_invoice_schedule_items
      FOR DELETE USING (EXISTS (
        SELECT 1 FROM public.recurring_invoice_schedules s
        WHERE s.id = recurring_invoice_schedule_items.schedule_id
          AND public.user_can_write_company(s.company_id)
      ));
  END IF;
END $$;

-- ============================================================
-- 4. Skatteverket company settings: create if missing, member-readable, writer-writable
-- ============================================================

-- The real production baseline can miss this table even though the current
-- dashboard/API code reads it. Create it here defensively instead of letting
-- dashboard Skatteverket status crash after the RLS patch.
CREATE TABLE IF NOT EXISTS public.skatteverket_company_settings (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  connection_status text NOT NULL DEFAULT 'not_connected'
    CHECK (connection_status IN ('not_connected','connected','needs_reauth','disabled')),
  token_status text NOT NULL DEFAULT 'missing'
    CHECK (token_status IN ('missing','valid','expiring','expired','revoked')),
  oauth_connected_at timestamptz,
  last_token_check_at timestamptz,
  requires_signing boolean NOT NULL DEFAULT true,
  vat_registered boolean,
  default_submitter_name text,
  default_submitter_email text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.skatteverket_company_settings
  ADD COLUMN IF NOT EXISTS auth_flow text NOT NULL DEFAULT 'per_bankid'
    CHECK (auth_flow IN ('per_bankid','ccg_sysorg','org_acg')),
  ADD COLUMN IF NOT EXISTS api_environment text NOT NULL DEFAULT 'test'
    CHECK (api_environment IN ('test','prod')),
  ADD COLUMN IF NOT EXISTS sysorg_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS filframstallare_orgnr text,
  ADD COLUMN IF NOT EXISTS filframstallare_id text,
  ADD COLUMN IF NOT EXISTS filframstallare_name text,
  ADD COLUMN IF NOT EXISTS filframstallare_contact_name text,
  ADD COLUMN IF NOT EXISTS filframstallare_contact_email text,
  ADD COLUMN IF NOT EXISTS last_sysorg_token_test_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_sysorg_token_status text
    CHECK (last_sysorg_token_status IS NULL OR last_sysorg_token_status IN ('ok','failed','missing_config','disabled'));

CREATE INDEX IF NOT EXISTS skatteverket_company_settings_status_idx
  ON public.skatteverket_company_settings(connection_status, token_status);

ALTER TABLE public.skatteverket_company_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS skatteverket_company_settings_select ON public.skatteverket_company_settings;
CREATE POLICY skatteverket_company_settings_select ON public.skatteverket_company_settings
  FOR SELECT USING (
    public.is_platform_admin()
    OR public.user_can_access_company_v2(company_id)
  );

DROP POLICY IF EXISTS skatteverket_company_settings_write ON public.skatteverket_company_settings;
DROP POLICY IF EXISTS skatteverket_company_settings_insert ON public.skatteverket_company_settings;
DROP POLICY IF EXISTS skatteverket_company_settings_update ON public.skatteverket_company_settings;
DROP POLICY IF EXISTS skatteverket_company_settings_delete ON public.skatteverket_company_settings;

CREATE POLICY skatteverket_company_settings_insert ON public.skatteverket_company_settings
  FOR INSERT WITH CHECK (
    public.is_platform_admin()
    OR public.user_can_write_company(company_id)
  );

CREATE POLICY skatteverket_company_settings_update ON public.skatteverket_company_settings
  FOR UPDATE USING (
    public.is_platform_admin()
    OR public.user_can_write_company(company_id)
  )
  WITH CHECK (
    public.is_platform_admin()
    OR public.user_can_write_company(company_id)
  );

CREATE POLICY skatteverket_company_settings_delete ON public.skatteverket_company_settings
  FOR DELETE USING (
    public.is_platform_admin()
    OR public.user_can_write_company(company_id)
  );

DO $$
BEGIN
  IF to_regprocedure('public.update_updated_at_column()') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS skatteverket_company_settings_updated_at ON public.skatteverket_company_settings;
    CREATE TRIGGER skatteverket_company_settings_updated_at
      BEFORE UPDATE ON public.skatteverket_company_settings
      FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
  END IF;
END $$;

-- ============================================================
-- 5. Skatteverket API request log: member-readable, server-written
-- ============================================================

DO $$
DECLARE
  pol record;
BEGIN
  IF to_regclass('public.skatteverket_api_requests') IS NOT NULL THEN
    ALTER TABLE public.skatteverket_api_requests ENABLE ROW LEVEL SECURITY;

    -- Keep SELECT policies, remove every member-write policy regardless of
    -- its historical name (`write`, `insert`, `all`, etc.).
    FOR pol IN
      SELECT policyname
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'skatteverket_api_requests'
        AND cmd <> 'SELECT'
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.skatteverket_api_requests', pol.policyname);
    END LOOP;
  END IF;
END $$;

-- ============================================================
-- 6. Skatteverket immutable audit log: member-readable, server-written
-- ============================================================

DO $$
DECLARE
  pol record;
BEGIN
  IF to_regclass('public.skatteverket_api_audit_log') IS NOT NULL THEN
    ALTER TABLE public.skatteverket_api_audit_log ENABLE ROW LEVEL SECURITY;

    -- This table is append-only server evidence. Preserve SELECT; remove any
    -- accidental authenticated INSERT/UPDATE/DELETE/ALL policy.
    FOR pol IN
      SELECT policyname
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'skatteverket_api_audit_log'
        AND cmd <> 'SELECT'
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.skatteverket_api_audit_log', pol.policyname);
    END LOOP;
  END IF;
END $$;

-- ============================================================
-- 7. Skatteverket tokens: service-role only + safe metadata view
-- ============================================================

DO $$
DECLARE
  pol record;
BEGIN
  IF to_regclass('public.skatteverket_tokens') IS NOT NULL THEN
    ALTER TABLE public.skatteverket_tokens ENABLE ROW LEVEL SECURITY;

    -- Remove every policy (SELECT included). Encrypted token material must
    -- never be available to authenticated users over PostgREST.
    FOR pol IN
      SELECT policyname
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'skatteverket_tokens'
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.skatteverket_tokens', pol.policyname);
    END LOOP;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.skatteverket_tokens') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'skatteverket_tokens' AND column_name = 'company_id'
     )
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'skatteverket_tokens' AND column_name = 'user_id'
     )
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'skatteverket_tokens' AND column_name = 'scope'
     )
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'skatteverket_tokens' AND column_name = 'expires_at'
     )
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'skatteverket_tokens' AND column_name = 'created_at'
     )
  THEN
    EXECUTE $view$
      CREATE OR REPLACE VIEW public.skatteverket_connections_v AS
      SELECT
        t.company_id,
        t.user_id,
        t.scope,
        t.expires_at,
        t.created_at
      FROM public.skatteverket_tokens t
      WHERE t.company_id IN (SELECT public.user_company_ids())
    $view$;

    GRANT SELECT ON public.skatteverket_connections_v TO authenticated, service_role;
  END IF;
END $$;

-- ============================================================
-- 8. Skatteverket service catalog: authenticated read, platform/service write
-- ============================================================

DO $$
DECLARE
  pol record;
BEGIN
  IF to_regclass('public.skatteverket_service_catalog') IS NOT NULL THEN
    ALTER TABLE public.skatteverket_service_catalog ENABLE ROW LEVEL SECURITY;

    -- Preserve explicitly read/admin policies if present, but remove any
    -- non-SELECT policy that does not require platform admin by recreating the
    -- admin policy below.
    FOR pol IN
      SELECT policyname
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'skatteverket_service_catalog'
        AND cmd <> 'SELECT'
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.skatteverket_service_catalog', pol.policyname);
    END LOOP;

    DROP POLICY IF EXISTS skatteverket_service_catalog_admin ON public.skatteverket_service_catalog;
    CREATE POLICY skatteverket_service_catalog_admin ON public.skatteverket_service_catalog
      FOR ALL USING (public.is_platform_admin())
      WITH CHECK (public.is_platform_admin());
  END IF;
END $$;

-- ============================================================
-- 9. oauth_used_codes: replay table locked to service role
-- ============================================================

DO $$
DECLARE
  pol record;
BEGIN
  IF to_regclass('public.oauth_used_codes') IS NOT NULL THEN
    ALTER TABLE public.oauth_used_codes ENABLE ROW LEVEL SECURITY;

    FOR pol IN
      SELECT policyname
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'oauth_used_codes'
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.oauth_used_codes', pol.policyname);
    END LOOP;
    -- No policies = service-role only.
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
