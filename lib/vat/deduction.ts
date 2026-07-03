import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import type { CreateJournalEntryLineInput } from '@/types'

/**
 * Blandad verksamhet — proportionell avdragsrätt för ingående moms
 * (ML 2023:200 13 kap 29 §, tidigare ML 8 kap 13 §).
 *
 * Companies with BOTH momspliktig and momsfri verksamhet may only deduct the
 * share of input VAT that corresponds to the taxable activity ("skälig
 * grund", typically the turnover ratio). The percentage is stored on
 * company_settings.vat_deduction_percent (100 = full avdragsrätt, the
 * default — behaviour is unchanged for ordinary companies).
 *
 * The non-deductible portion of the VAT is NOT lost in the ether: per
 * IL 16 kap 16 § it is part of the acquisition cost, i.e. it books onto the
 * cost account rather than 2641. The booking engine splits every input-VAT
 * line accordingly.
 */

/**
 * Fetch the company's proportionell avdragsrätt percentage.
 * Returns 100 (full deduction) when unset or on any read failure —
 * the safe default for ordinary single-activity companies.
 */
export async function getVatDeductionPercent(
  supabase: SupabaseClient,
  companyId: string,
): Promise<number> {
  try {
    const { data } = await supabase
      .from('company_settings')
      .select('vat_deduction_percent')
      .eq('company_id', companyId)
      .maybeSingle()
    const raw = data?.vat_deduction_percent
    if (raw == null) return 100
    const value = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(value) || value < 0 || value > 100) return 100
    return value
  } catch {
    // Settings read must never block a booking — fall back to full deduction
    // (the pre-blandad-verksamhet behaviour).
    return 100
  }
}

/**
 * Split an input-VAT amount into deductible (→ 2641/2645/2647, ruta 48) and
 * non-deductible (→ cost account) parts. Öre-exact: the two parts always sum
 * to the original amount (non-deductible takes the rounding residual).
 */
export function splitDeductibleVat(
  vatAmount: number,
  deductionPercent: number,
): { deductible: number; nonDeductible: number } {
  const pct = Number.isFinite(deductionPercent)
    ? Math.min(100, Math.max(0, deductionPercent))
    : 100
  const total = roundOre(vatAmount)
  const deductible = roundOre((total * pct) / 100)
  const nonDeductible = roundOre(total - deductible)
  return { deductible, nonDeductible }
}

/**
 * Build the journal line for the non-deductible VAT portion in a blandad
 * verksamhet. Booked as a cost (IL 16 kap 16 §) on the given expense account.
 */
export function buildNonDeductibleVatLine(
  amount: number,
  expenseAccount: string,
  deductionPercent: number,
): CreateJournalEntryLineInput {
  return {
    account_number: expenseAccount,
    debit_amount: roundOre(amount),
    credit_amount: 0,
    line_description: `Ej avdragsgill ingående moms (blandad verksamhet, avdragsrätt ${deductionPercent}%)`,
  }
}
