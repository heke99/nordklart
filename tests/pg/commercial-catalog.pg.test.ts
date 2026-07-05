import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'

/**
 * Covers 20260714140000_commercial_catalog_consolidation:
 *   - Legacy onboarding-era plans are archived and hidden from the public
 *     catalog while the current public plans remain purchasable.
 *   - public_price_plans_v renders an interval-aware price label.
 */

describe('commercial catalog consolidation', () => {
  it('archives the legacy duplicate plans and keeps year_end_one_time active', async () => {
    const { rows } = await getPool().query<{ code: string; status: string; is_public: boolean }>(
      `select code, status, is_public
       from public.platform_price_plans
       where code in ('start_monthly', 'auto_monthly', 'agency_monthly', 'bankgiro_addon_monthly', 'year_end_one_time')
       order by code`,
    )

    const byCode = new Map(rows.map((row) => [row.code, row]))
    for (const legacy of ['start_monthly', 'auto_monthly', 'agency_monthly', 'bankgiro_addon_monthly']) {
      expect(byCode.get(legacy)?.status).toBe('archived')
      expect(byCode.get(legacy)?.is_public).toBe(false)
    }
    expect(byCode.get('year_end_one_time')?.status).toBe('active')
  })

  it('keeps the public company/agency plans in the public pricing view', async () => {
    const { rows } = await getPool().query<{ plan_code: string }>(
      `select plan_code from public.public_price_plans_v`,
    )
    const codes = new Set(rows.map((row) => row.plan_code))
    for (const expected of ['company_start', 'company_plus', 'company_pro', 'agency_start', 'agency_plus', 'agency_pro']) {
      expect(codes.has(expected)).toBe(true)
    }
    for (const legacy of ['start_monthly', 'auto_monthly', 'agency_monthly', 'bankgiro_addon_monthly']) {
      expect(codes.has(legacy)).toBe(false)
    }
  })

  it('renders interval-aware price labels', async () => {
    const { rows } = await getPool().query<{ plan_code: string; billing_interval: string; price_from_label: string }>(
      `select plan_code, billing_interval, price_from_label from public.public_price_plans_v`,
    )
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      if (row.billing_interval === 'month') {
        expect(row.price_from_label).toMatch(/kr\/mån$/)
      } else if (row.billing_interval === 'year') {
        expect(row.price_from_label).toMatch(/kr\/år$/)
      } else {
        expect(row.price_from_label).toMatch(/kr$/)
      }
    }
  })
})
