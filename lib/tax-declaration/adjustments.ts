import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'

export type TaxDeclarationType = 'INK2' | 'NE'
export type TaxAdjustmentSource = 'auto' | 'account_rule' | 'user_input' | 'imported' | 'calculated'

export interface TaxDeclarationAdjustment {
  id: string
  declaration_type: TaxDeclarationType
  form: string
  field_code: string
  amount: number
  description: string | null
  source: TaxAdjustmentSource
  confidence: number | null
  requires_review: boolean
  approved_at: string | null
}

export async function listTaxDeclarationAdjustments(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  declarationType: TaxDeclarationType,
): Promise<TaxDeclarationAdjustment[]> {
  const { data, error } = await supabase
    .from('tax_declaration_adjustments')
    .select('id, declaration_type, form, field_code, amount, description, source, confidence, requires_review, approved_at')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .eq('declaration_type', declarationType)
    .is('deleted_at', null)
    .order('field_code', { ascending: true })

  if (error) {
    // The completion migration may not have been applied yet in older dev
    // databases. Generation must remain available as a safe draft instead of
    // crashing; readiness will flag missing project storage separately.
    return []
  }

  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    declaration_type: String(row.declaration_type) as TaxDeclarationType,
    form: String(row.form),
    field_code: String(row.field_code),
    amount: Number(row.amount ?? 0),
    description: typeof row.description === 'string' ? row.description : null,
    source: String(row.source ?? 'user_input') as TaxAdjustmentSource,
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    requires_review: row.requires_review === true,
    approved_at: typeof row.approved_at === 'string' ? row.approved_at : null,
  }))
}

export function approvedAdjustmentAmount(
  adjustments: TaxDeclarationAdjustment[],
  fieldCode: string,
): number {
  return adjustments
    .filter((row) => row.field_code === fieldCode)
    .filter((row) => !row.requires_review || Boolean(row.approved_at))
    .reduce((sum, row) => sum + Number(row.amount || 0), 0)
}

export function pendingAdjustmentWarnings(adjustments: TaxDeclarationAdjustment[]): string[] {
  return adjustments
    .filter((row) => row.requires_review && !row.approved_at)
    .map((row) => `${row.form} ${row.field_code} kräver granskning innan deklarationen kan markeras som färdig${row.description ? `: ${row.description}` : '.'}`)
}

export async function upsertTaxDeclarationProject(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  declarationType: TaxDeclarationType,
  generatedBy: string,
  status: string,
  readinessScore: number,
  blockers: unknown[],
  warnings: unknown[],
) {
  const { data, error } = await supabase
    .from('tax_declaration_projects')
    .upsert({
      company_id: companyId,
      fiscal_period_id: fiscalPeriodId,
      declaration_type: declarationType,
      status,
      readiness_score: readinessScore,
      blockers,
      warnings,
      last_generated_at: new Date().toISOString(),
      generated_by: generatedBy,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'company_id,fiscal_period_id,declaration_type' })
    .select('id')
    .maybeSingle()

  if (error) return null
  return data?.id ? String(data.id) : null
}

export async function recordTaxDeclarationExport(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  declarationType: TaxDeclarationType,
  userId: string,
  payload: {
    format: string
    filename: string
    readinessScore: number
    blockerCount: number
    warningCount: number
    validation: unknown
  },
) {
  const projectId = await upsertTaxDeclarationProject(
    supabase,
    companyId,
    fiscalPeriodId,
    declarationType,
    userId,
    payload.blockerCount > 0 ? 'blocked' : 'exported',
    payload.readinessScore,
    [],
    [],
  )

  if (!projectId) return null

  const { data } = await supabase
    .from('tax_declaration_exports')
    .insert({
      company_id: companyId,
      fiscal_period_id: fiscalPeriodId,
      tax_declaration_project_id: projectId,
      declaration_type: declarationType,
      format: payload.format,
      filename: payload.filename,
      readiness_score: payload.readinessScore,
      blocker_count: payload.blockerCount,
      warning_count: payload.warningCount,
      validation_result: payload.validation,
      exported_by: userId,
    })
    .select('id')
    .maybeSingle()

  return data?.id ? String(data.id) : null
}
