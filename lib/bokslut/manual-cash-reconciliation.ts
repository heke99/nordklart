import type { SupabaseClient } from '@supabase/supabase-js'

export interface YearEndCashReconciliationStatus {
  cash_account_id: string | null
  ledger_account: string
  account_name: string
  currency: string
  reconciliation_mode: 'automated' | 'manual'
  ledger_balance: number
  statement_balance: number | null
  difference: number | null
  unmatched_transaction_count: number
  unmatched_gl_line_count: number
  matching_conflict_count: number
  reconciliation_id: string | null
  evidence_document_id: string | null
  evidence_file_name: string | null
  evidence_sha256: string | null
  verified_at: string | null
  invalidated_at: string | null
  invalidation_reason: string | null
  snapshot_current: boolean
  is_reconciled: boolean
}

export async function loadYearEndCashReconciliationStatus(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<YearEndCashReconciliationStatus[]> {
  const { data, error } = await supabase.rpc('year_end_cash_reconciliation_status', {
    p_company_id: companyId,
    p_fiscal_period_id: fiscalPeriodId,
  })
  if (error) throw new Error(error.message)
  return (data ?? []) as YearEndCashReconciliationStatus[]
}
