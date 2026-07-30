import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import type { ProposedDisposition } from '../types'

/** Särskild löneskatt på pensionskostnader (SLP). 24.26 % per SLF 1991:687. */
export const SLP_RATE = 0.2426

export interface SlpComputation {
  /** Total pension cost during the period — sum of posted debits on accounts
   *  7410–7419 (pensionsförsäkringspremier, individuella pensioner, etc.). */
  pensionCostsBooked: number
  /** Optional manual adjustment — e.g. avsättning till pensionsskuld on 2210
   *  bokad under perioden som inte ligger på 7410–7419 men ska SLP-belastas. */
  manualAdjustment: number
  /** Base for SLP = pensionCostsBooked + manualAdjustment. */
  base: number
  rate: number
  slpAmount: number
}

/**
 * Compute särskild löneskatt på pensionskostnader.
 *
 * SLP gäller arbetsgivares kostnader för avtalspension samt pensionsavsättningar
 * (men inte allmän pension som finansieras av arbetsgivaravgifterna). Räknas
 * på 7410-7419 (tjänstepensionspremier) och avsättningar till pensionsskuld.
 *
 * Caller can supply `manualAdjustment` to include pensionsavsättningar made on
 * 2210 (avsättning för pensioner) that aren't reflected in 7410-7419 — common
 * when companies book direct to the avsättningskonto rather than via a cost
 * account.
 */
export async function calculateSarskildLoneskatt(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  options: {
    manualAdjustment?: number
    pensionCostsBooked?: number
    rate?: number
  } = {},
): Promise<ProposedDisposition | null> {
  let pensionCostsBooked = options.pensionCostsBooked
  if (pensionCostsBooked === undefined) {
    const { data, error } = await supabase
      .from('journal_entry_lines')
      .select(
        'account_number, debit_amount, credit_amount, journal_entries!inner(company_id, fiscal_period_id, status)',
      )
      .eq('journal_entries.company_id', companyId)
      .eq('journal_entries.fiscal_period_id', fiscalPeriodId)
      .eq('journal_entries.status', 'posted')
      .gte('account_number', '7410')
      .lte('account_number', '7419')

    if (error) {
      throw new Error(`Failed to fetch pension costs: ${error.message}`)
    }

    type Row = { debit_amount: number | string | null; credit_amount: number | string | null }
    pensionCostsBooked = ((data ?? []) as Row[]).reduce((sum, row) => {
      return sum + ((Number(row.debit_amount) || 0) - (Number(row.credit_amount) || 0))
    }, 0)
  }

  const manualAdjustment = options.manualAdjustment ?? 0
  const base = Math.max(0, pensionCostsBooked + manualAdjustment)
  const rate = options.rate ?? SLP_RATE
  const slpAmount = Math.round(base * rate)
  const rateLabel = `${roundOre(rate * 100).toLocaleString('sv-SE')} %`

  const computation: SlpComputation = {
    pensionCostsBooked: roundOre(pensionCostsBooked),
    manualAdjustment,
    base,
    rate,
    slpAmount,
  }

  if (slpAmount === 0) {
    return null
  }

  return {
    kind: 'sarskild_loneskatt',
    label: `Särskild löneskatt på pensionskostnader (${rateLabel})`,
    description: 'Debet 7533, kredit 2514.',
    amount: slpAmount,
    lines: [
      {
        account_number: '7533',
        debit_amount: slpAmount,
        credit_amount: 0,
        line_description: `SLP ${rateLabel} på ${base} kr pensionskostnader`,
      },
      {
        account_number: '2514',
        debit_amount: 0,
        credit_amount: slpAmount,
        line_description: 'Beräknad särskild löneskatt på pensionskostnader',
      },
    ],
    warnings: [],
    computation: computation as unknown as Record<string, unknown>,
  }
}
