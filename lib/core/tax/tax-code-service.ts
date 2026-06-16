import type { SupabaseClient } from '@supabase/supabase-js'
import type { TaxCode } from '@/types'

/**
 * Tax Code Service
 *
 * Manages decoupled tax codes for momsdeklaration.
 * Tax codes map journal entry lines to specific moms rutor (boxes)
 * on the Swedish VAT declaration form.
 */

/**
 * Get all active tax codes for a user (including system codes)
 */
export async function getTaxCodes(supabase: SupabaseClient, userId: string): Promise<TaxCode[]> {

  const { data, error } = await supabase
    .from('tax_codes')
    .select('*')
    .or(`company_id.eq.${userId},company_id.is.null`)
    .order('code')

  if (error) {
    throw new Error(`Failed to fetch tax codes: ${error.message}`)
  }

  return (data as TaxCode[]) || []
}

/**
 * Get a single tax code by code string
 */
export async function getTaxCodeByCode(
  supabase: SupabaseClient,
  userId: string,
  code: string
): Promise<TaxCode | null> {

  // Prefer user-specific code over system code
  const { data, error } = await supabase
    .from('tax_codes')
    .select('*')
    .eq('code', code)
    .or(`company_id.eq.${userId},company_id.is.null`)
    .order('user_id', { ascending: false, nullsFirst: false })
    .limit(1)
    .single()

  if (error) {
    return null
  }

  return data as TaxCode
}

/**
 * Moms box result from tax code aggregation
 */
export interface MomsBoxResult {
  /** Ruta number (e.g. '05', '10', '48') */
  box: string
  /** Sum of amounts for this box */
  amount: number
}

/**
 * Calculate momsdeklaration from journal entry lines grouped by tax_code,
 * then mapped via the tax_codes table to moms boxes.
 *
 * This is the new, tax-code-driven approach that replaces the hardcoded
 * category-based VAT calculation.
 */
export async function calculateMomsFromTaxCodes(
  supabase: SupabaseClient,
  userId: string,
  periodStart: string,
  periodEnd: string
): Promise<MomsBoxResult[]> {

  // Fetch journal entry lines with tax_code in the period
  const { data: lines, error: linesError } = await supabase
    .from('journal_entry_lines')
    .select(`
      tax_code,
      debit_amount,
      credit_amount,
      journal_entry_id,
      journal_entries!inner (
        user_id,
        entry_date,
        status,
        fiscal_period_id
      )
    `)
    .not('tax_code', 'is', null)
    .eq('journal_entries.company_id', userId)
    .eq('journal_entries.status', 'posted')
    .gte('journal_entries.entry_date', periodStart)
    .lte('journal_entries.entry_date', periodEnd)

  if (linesError) {
    throw new Error(`Failed to fetch journal lines: ${linesError.message}`)
  }

  // Fetch all tax codes for lookup
  const taxCodes = await getTaxCodes(supabase, userId)
  const taxCodeMap = new Map<string, TaxCode>()
  for (const tc of taxCodes) {
    // User codes take precedence over system codes
    if (!taxCodeMap.has(tc.code) || tc.user_id) {
      taxCodeMap.set(tc.code, tc)
    }
  }

  // Aggregate amounts by moms box
  const boxTotals = new Map<string, number>()

  for (const line of lines || []) {
    if (!line.tax_code) continue

    const taxCode = taxCodeMap.get(line.tax_code)
    if (!taxCode) continue

    const netAmount = Number(line.debit_amount || 0) - Number(line.credit_amount || 0)
    const absAmount = Math.abs(netAmount)

    // For output VAT: debit_amount goes to basis boxes, tax amount to tax boxes
    // For input VAT: the amount goes to input boxes
    const allBoxes = [
      ...taxCode.moms_basis_boxes,
      ...taxCode.moms_tax_boxes,
      ...taxCode.moms_input_boxes,
    ]

    for (const box of allBoxes) {
      const current = boxTotals.get(box) || 0
      boxTotals.set(box, current + absAmount)
    }
  }

  // Convert to result array
  const results: MomsBoxResult[] = []
  for (const [box, amount] of boxTotals) {
    results.push({
      box,
      amount: Math.round(amount * 100) / 100,
    })
  }

  return results.sort((a, b) => a.box.localeCompare(b.box))
}

/**
 * Seed tax codes for a user by calling the database function
 */
export async function seedTaxCodes(supabase: SupabaseClient, userId: string): Promise<void> {

  const { error } = await supabase.rpc('seed_tax_codes_for_user', {
    p_user_id: userId,
  })

  if (error) {
    throw new Error(`Failed to seed tax codes: ${error.message}`)
  }
}
