import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

/**
 * Source types written by the year-end close. They move the year's result from
 * classes 3–8 into equity (2099/2010) inside the same period, so a report that
 * sums the period's vouchers after the close sees every income-statement
 * account at zero. Declarations and income statements must leave them out and
 * derive the result from the accounts instead; `year_end` is the pre-rename
 * value still present on older data.
 */
export const YEAR_END_CLOSING_SOURCE_TYPES = ['year_end', 'year_end_closing'] as const

/**
 * Net (debit − credit) per account for every posted/reversed voucher in a
 * fiscal period, the opening-balance voucher included.
 *
 * Paginates with a stable order: PostgREST caps a response at 1 000 rows, and
 * paging without ORDER BY lets Postgres return a row twice or not at all across
 * pages.
 */
export async function fetchPeriodAccountNets(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  options: { excludeYearEndClosing: boolean },
): Promise<Map<string, number>> {
  const lines = await fetchAllRows<{
    account_number: string
    debit_amount: number | string | null
    credit_amount: number | string | null
  }>(({ from, to }) => {
    let query = supabase
      .from('journal_entry_lines')
      .select('account_number, debit_amount, credit_amount, journal_entries!inner(company_id, fiscal_period_id, status, source_type)')
      .eq('journal_entries.company_id', companyId)
      .eq('journal_entries.fiscal_period_id', fiscalPeriodId)
      .in('journal_entries.status', ['posted', 'reversed'])
    if (options.excludeYearEndClosing) {
      for (const sourceType of YEAR_END_CLOSING_SOURCE_TYPES) {
        query = query.neq('journal_entries.source_type', sourceType)
      }
    }
    return query.order('id', { ascending: true }).range(from, to)
  })

  const nets = new Map<string, number>()
  for (const line of lines) {
    const net = (Number(line.debit_amount) || 0) - (Number(line.credit_amount) || 0)
    nets.set(line.account_number, (nets.get(line.account_number) ?? 0) + net)
  }
  return nets
}
