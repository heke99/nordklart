import type { SupabaseClient } from '@supabase/supabase-js'
import type { K2FormalReportModel } from '@/lib/bokslut/formal-report/k2-model'
import type { FlerarsoversiktRow } from './types'

export type ComparativeSourceType =
  | 'established_annual_report'
  | 'final_report_snapshot'
  | 'manually_verified'

export interface VerifiedComparativeSnapshot {
  id: string
  source_fiscal_period_id: string
  source_type: ComparativeSourceType
  source_label: string
  formal_report_snapshot: K2FormalReportModel | null
  overview_snapshot: unknown
  verified_by: string | null
  verified_at: string
}

export async function loadVerifiedComparativeSnapshot(
  supabase: SupabaseClient,
  companyId: string,
  sourceFiscalPeriodId: string,
): Promise<VerifiedComparativeSnapshot | null> {
  const { data, error } = await supabase
    .from('annual_report_comparative_snapshots')
    .select(
      'id, source_fiscal_period_id, source_type, source_label, formal_report_snapshot, overview_snapshot, verified_by, verified_at',
    )
    .eq('company_id', companyId)
    .eq('source_fiscal_period_id', sourceFiscalPeriodId)
    .eq('is_current', true)
    .is('superseded_at', null)
    .maybeSingle()
  if (error) throw new Error(`Failed to load verified comparatives: ${error.message}`)
  return (data as VerifiedComparativeSnapshot | null) ?? null
}

export function overviewRowFromSnapshot(
  snapshot: VerifiedComparativeSnapshot,
  fallbackYear: string,
): FlerarsoversiktRow | null {
  const raw = snapshot.overview_snapshot
  const rows = Array.isArray(raw) ? raw : []
  const row = rows.find((candidate) => {
    if (!candidate || typeof candidate !== 'object') return false
    return String((candidate as { year?: unknown }).year ?? '') === fallbackYear
  }) as Partial<FlerarsoversiktRow> | undefined
  if (!row) return null
  const netRevenue = Number(row.net_revenue)
  const resultAfterFinancial = Number(row.result_after_financial)
  const soliditet = row.soliditet_pct == null ? null : Number(row.soliditet_pct)
  if (!Number.isFinite(netRevenue) || !Number.isFinite(resultAfterFinancial)) return null
  return {
    year: fallbackYear,
    net_revenue: Math.round(netRevenue),
    result_after_financial: Math.round(resultAfterFinancial),
    soliditet_pct: soliditet !== null && Number.isFinite(soliditet) ? soliditet : null,
  }
}
