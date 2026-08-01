import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  'supabase/migrations/20260801140000_production_financial_atomicity_and_billing_lifecycle.sql',
  'utf8',
)

describe('production financial hardening migration', () => {
  it('defines database-owned customer and supplier settlements', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.settle_customer_invoice')
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.settle_supplier_invoice')
    expect(sql).toContain('pg_advisory_xact_lock')
    expect(sql).toContain('FOR UPDATE')
    expect(sql).toContain('financial_operation_idempotency')
    expect(sql).toContain('financial_outbox_events')
  })

  it('forbids posted -> cancelled and requires linked reversal', () => {
    expect(sql).toContain("OLD.status = 'posted' AND NEW.status = 'cancelled'")
    expect(sql).toContain('POSTED_ENTRY_REQUIRES_REVERSAL')
    expect(sql).toContain('REVERSAL_LINK_REQUIRED')
  })

  it('keeps all financial RPCs service-only with pinned search paths', () => {
    for (const name of [
      'settle_customer_invoice',
      'settle_supplier_invoice',
      'stripe_apply_one_time_purchase_event',
    ]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${name}`)
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${name}`)
    }
    expect(sql.match(/SET search_path = public, pg_temp/g)?.length ?? 0).toBeGreaterThanOrEqual(6)
  })

  it('uses one service-only exact-period capability resolver', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.resolve_year_end_period_capability_for_user')
    expect(sql).toContain("FROM public.company_feature_access(p_company_id, 'year_end.projects')")
    expect(sql).toContain('otp.fiscal_period_id = p_fiscal_period_id')
    expect(sql).toContain('otp.access_revoked_at IS NULL')
    expect(sql).toContain('p_require_write boolean DEFAULT false')
    expect(sql).toContain('require_service_role()')
  })

})
