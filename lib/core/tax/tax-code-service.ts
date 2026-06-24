import type { SupabaseClient } from '@supabase/supabase-js'
import type { TaxCode } from '@/types'

/**
 * Tax Code Service
 *
 * Company-scoped tax codes for Swedish VAT reporting. The production schema is
 * optional in older installations, so reads degrade safely instead of crashing a
 * moms flow when the legacy placeholder migration is still the only migration present.
 */

function isMissingTaxCodeSchema(error: { code?: string; message?: string } | null | undefined) {
  if (!error) return false
  return error.code === '42P01' || /tax_codes|seed_tax_codes_for_company|seed_tax_codes_for_user/i.test(error.message ?? '')
}

/** Get all active tax codes for a company, including global system codes. */
export async function getTaxCodes(supabase: SupabaseClient, companyId: string): Promise<TaxCode[]> {
  const { data, error } = await supabase
    .from('tax_codes')
    .select('*')
    .or(`company_id.eq.${companyId},company_id.is.null`)
    .order('code')

  if (error) {
    if (isMissingTaxCodeSchema(error)) return []
    throw new Error(`Failed to fetch tax codes: ${error.message}`)
  }

  return (data as TaxCode[]) || []
}

/** Get a single tax code by code string. Company-specific codes win over system codes. */
export async function getTaxCodeByCode(
  supabase: SupabaseClient,
  companyId: string,
  code: string,
): Promise<TaxCode | null> {
  const { data, error } = await supabase
    .from('tax_codes')
    .select('*')
    .eq('code', code)
    .or(`company_id.eq.${companyId},company_id.is.null`)
    .order('company_id', { ascending: false, nullsFirst: false })
    .limit(1)
    .single()

  if (error) return null
  return data as TaxCode
}

export interface MomsBoxResult {
  /** Ruta number, e.g. '05', '10', '48'. */
  box: string
  /** Sum of amounts for this box. */
  amount: number
}

/**
 * Calculate VAT declaration boxes from journal entry lines grouped by tax_code.
 */
export async function calculateMomsFromTaxCodes(
  supabase: SupabaseClient,
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<MomsBoxResult[]> {
  const { data: lines, error: linesError } = await supabase
    .from('journal_entry_lines')
    .select(`
      tax_code,
      debit_amount,
      credit_amount,
      journal_entry_id,
      journal_entries!inner (
        company_id,
        entry_date,
        status,
        fiscal_period_id
      )
    `)
    .not('tax_code', 'is', null)
    .eq('journal_entries.company_id', companyId)
    .eq('journal_entries.status', 'posted')
    .gte('journal_entries.entry_date', periodStart)
    .lte('journal_entries.entry_date', periodEnd)

  if (linesError) {
    throw new Error(`Failed to fetch journal lines: ${linesError.message}`)
  }

  const taxCodes = await getTaxCodes(supabase, companyId)
  const taxCodeMap = new Map<string, TaxCode>()
  for (const taxCode of taxCodes) {
    // Company-specific codes take precedence over global system codes. The
    // legacy test helpers still set user_id, so keep that as a compatibility hint.
    if (!taxCodeMap.has(taxCode.code) || taxCode.user_id || taxCode.is_system === false) {
      taxCodeMap.set(taxCode.code, taxCode)
    }
  }

  const boxTotals = new Map<string, number>()
  for (const line of lines || []) {
    const row = line as { tax_code?: string | null; debit_amount?: number | string | null; credit_amount?: number | string | null }
    if (!row.tax_code) continue

    const taxCode = taxCodeMap.get(row.tax_code)
    if (!taxCode) continue

    const netAmount = Number(row.debit_amount || 0) - Number(row.credit_amount || 0)
    const absAmount = Math.abs(netAmount)
    const boxes = [
      ...taxCode.moms_basis_boxes,
      ...taxCode.moms_tax_boxes,
      ...taxCode.moms_input_boxes,
    ]

    for (const box of boxes) {
      boxTotals.set(box, (boxTotals.get(box) || 0) + absAmount)
    }
  }

  return Array.from(boxTotals.entries())
    .map(([box, amount]) => ({ box, amount: Math.round(amount * 100) / 100 }))
    .sort((a, b) => a.box.localeCompare(b.box))
}

/** Seed default company tax codes when the production schema is present. */
export async function seedTaxCodes(supabase: SupabaseClient, companyId: string): Promise<void> {
  const { error } = await supabase.rpc('seed_tax_codes_for_company', {
    p_company_id: companyId,
  })

  if (error) {
    if (isMissingTaxCodeSchema(error)) return
    throw new Error(`Failed to seed tax codes: ${error.message}`)
  }
}
