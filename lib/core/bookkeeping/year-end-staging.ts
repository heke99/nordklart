import type { SupabaseClient } from '@supabase/supabase-js'
import type { CreateJournalEntryLineInput, YearEndPreview } from '@/types'

export type YearEndAdjustmentGroup =
  | 'accrual'
  | 'disposition'
  | 'depreciation'
  | 'tax'
  | 'other'

export interface StageYearEndAdjustmentInput {
  stable_key: string
  adjustment_kind: string
  description: string
  entry_date?: string
  reversal_date?: string | null
  journal_lines: CreateJournalEntryLineInput[]
  calculation_payload?: Record<string, unknown>
  ruleset_version?: string | null
  idempotency_key?: string
}

export interface StagedYearEndAdjustment {
  id: string
  adjustment_group: YearEndAdjustmentGroup
  adjustment_kind: string
  stable_key: string
  description: string
  entry_date: string
  reversal_date: string | null
  journal_lines: CreateJournalEntryLineInput[]
  calculation_payload: Record<string, unknown>
  ruleset_version: string | null
  status: 'approved' | 'included_in_preview'
  version: number
}

export interface YearEndRuleset {
  tax_year: number
  version: string
  corporate_tax_rate: number
  slp_rate: number
  periodiseringsfond_rate: number
  schablonintakt_rate: number
}

export async function getYearEndRuleset(
  supabase: SupabaseClient,
  taxYear: number,
): Promise<YearEndRuleset> {
  const { data, error } = await supabase
    .from('year_end_rulesets')
    .select(
      'tax_year, version, corporate_tax_rate, slp_rate, periodiseringsfond_rate, schablonintakt_rate',
    )
    .eq('tax_year', taxYear)
    .single()
  if (error || !data) {
    throw new Error(`YE_RULESET_MISSING: no year-end ruleset for tax year ${taxYear}`)
  }
  return {
    tax_year: Number(data.tax_year),
    version: String(data.version),
    corporate_tax_rate: Number(data.corporate_tax_rate),
    slp_rate: Number(data.slp_rate),
    periodiseringsfond_rate: Number(data.periodiseringsfond_rate),
    schablonintakt_rate: Number(data.schablonintakt_rate),
  }
}

export async function stageYearEndAdjustments(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  userId: string,
  group: YearEndAdjustmentGroup,
  items: StageYearEndAdjustmentInput[],
): Promise<{ staged_ids: string[]; count: number; adjustment_hash: string }> {
  const { data, error } = await supabase.rpc('stage_year_end_adjustments', {
    p_company_id: companyId,
    p_fiscal_period_id: fiscalPeriodId,
    p_user_id: userId,
    p_adjustment_group: group,
    p_items: items,
  })
  if (error) throw new Error(`YE_ADJUSTMENT_INVALID: ${error.message}`)
  return data as { staged_ids: string[]; count: number; adjustment_hash: string }
}

export async function listStagedYearEndAdjustments(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<StagedYearEndAdjustment[]> {
  const { data, error } = await supabase
    .from('year_end_staged_adjustments')
    .select(
      'id, adjustment_group, adjustment_kind, stable_key, description, entry_date, reversal_date, journal_lines, calculation_payload, ruleset_version, status, version',
    )
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .in('status', ['approved', 'included_in_preview'])
    .order('adjustment_group')
    .order('stable_key')
  if (error) throw new Error(`YE_ADJUSTMENT_INVALID: ${error.message}`)
  return (data ?? []) as StagedYearEndAdjustment[]
}

export async function persistYearEndPreview(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  userId: string,
  preview: YearEndPreview,
): Promise<YearEndPreview> {
  const { data, error } = await supabase.rpc('create_year_end_preview', {
    p_company_id: companyId,
    p_fiscal_period_id: fiscalPeriodId,
    p_user_id: userId,
    p_payload: preview,
  })
  if (error) throw new Error(error.message)
  const persisted = data as {
    preview_id: string
    ledger_hash: string
    readiness_hash: string
    adjustment_hash: string
    ruleset_version: string
    generated_at: string
    expires_at: string
    payload: YearEndPreview
  }
  return {
    ...persisted.payload,
    previewId: persisted.preview_id,
    ledgerHash: persisted.ledger_hash,
    readinessHash: persisted.readiness_hash,
    adjustmentHash: persisted.adjustment_hash,
    rulesetVersion: persisted.ruleset_version,
    generatedAt: persisted.generated_at,
    expiresAt: persisted.expires_at,
  }
}
