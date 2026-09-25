-- Posting a year's planenliga avskrivningar is one transaction.
--
-- lib/bokslut/assets/depreciation-engine.ts committed one voucher per asset
-- and only afterwards wrote the depreciation_schedules row that links the
-- asset to it. The proposal treats an asset without a linked schedule as
-- "not yet posted", so a failure between the two made the next run post that
-- asset's depreciation a second time.
--
-- The engine now creates every voucher as a draft and calls
-- post_depreciation_batch(), which commits each draft through
-- commit_journal_entry and upserts its schedule row (unique per asset and
-- period) in the same transaction. A schedule that is already linked to a
-- voucher fails the whole batch, so a double posting is impossible.
--
-- pg-test: tests/pg/post-depreciation-atomic.pg.test.ts

BEGIN;

CREATE OR REPLACE FUNCTION public.post_depreciation_batch(
  p_company_id uuid,
  p_user_id uuid,
  p_fiscal_period_id uuid,
  p_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item jsonb;
  v_entry_id uuid;
  v_asset_id uuid;
  v_schedule_id uuid;
  v_result jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.user_can_write_company(p_company_id) THEN
    RAISE EXCEPTION 'write access required' USING ERRCODE = '42501';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) LOOP
    v_entry_id := (v_item->>'journal_entry_id')::uuid;
    v_asset_id := (v_item->>'asset_id')::uuid;

    IF NOT EXISTS (
      SELECT 1 FROM public.journal_entries je
       WHERE je.id = v_entry_id AND je.company_id = p_company_id
         AND je.status = 'draft' AND je.source_type = 'year_end_depreciation'
         AND je.fiscal_period_id = p_fiscal_period_id
    ) THEN
      RAISE EXCEPTION 'voucher % is not a depreciation draft for this period', v_entry_id USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.assets a WHERE a.id = v_asset_id AND a.company_id = p_company_id) THEN
      RAISE EXCEPTION 'asset % not found', v_asset_id USING ERRCODE = 'P0002';
    END IF;

    PERFORM public.commit_journal_entry(p_company_id, v_entry_id, NULL, NULL, NULL, NULL);

    INSERT INTO public.depreciation_schedules AS d (
      user_id, company_id, asset_id, fiscal_period_id, planned_depreciation, journal_entry_id, posted_at
    ) VALUES (
      p_user_id, p_company_id, v_asset_id, p_fiscal_period_id, (v_item->>'amount')::numeric, v_entry_id, now()
    )
    ON CONFLICT (asset_id, fiscal_period_id) DO UPDATE
      SET journal_entry_id = excluded.journal_entry_id,
          planned_depreciation = excluded.planned_depreciation,
          posted_at = excluded.posted_at
      WHERE d.journal_entry_id IS NULL
    RETURNING d.id INTO v_schedule_id;

    IF v_schedule_id IS NULL THEN
      RAISE EXCEPTION 'depreciation for asset % is already posted in this period', v_asset_id USING ERRCODE = '23505';
    END IF;

    v_result := v_result || jsonb_build_object('asset_id', v_asset_id, 'journal_entry_id', v_entry_id, 'schedule_id', v_schedule_id);
  END LOOP;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.post_depreciation_batch(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_depreciation_batch(uuid, uuid, uuid, jsonb) TO authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
