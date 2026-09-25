import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'

const log = createLogger('account-sums')

export type AccountSums = Map<string, { debit: number; credit: number }>

export interface AccountSumsParams {
  companyId: string
  fiscalPeriodId: string
  fromDate?: string | null
  toDate?: string | null
  excludeEntryId?: string | null
  excludeSourceTypes?: readonly string[] | null
}

/**
 * Debit and credit per account for the posted/reversed vouchers of a fiscal
 * period, summed in Postgres (account_period_sums) — one row per account
 * instead of every voucher line.
 *
 * `rowFallback` computes the same sums from rows. It runs only when the RPC is
 * not available (e.g. a database that has not received the migration yet);
 * the result is identical either way.
 */
export async function fetchAccountSums(
  supabase: SupabaseClient,
  params: AccountSumsParams,
  rowFallback: () => Promise<Array<{ account_number: string; debit_amount: number | string | null; credit_amount: number | string | null }>>,
): Promise<AccountSums> {
  const sums: AccountSums = new Map()

  if (typeof (supabase as { rpc?: unknown }).rpc === 'function') {
    const { data, error } = await supabase.rpc('account_period_sums', {
      p_company_id: params.companyId,
      p_fiscal_period_id: params.fiscalPeriodId,
      p_from_date: params.fromDate ?? null,
      p_to_date: params.toDate ?? null,
      p_exclude_entry_id: params.excludeEntryId ?? null,
      p_exclude_source_types: params.excludeSourceTypes ? [...params.excludeSourceTypes] : null,
    })
    if (!error && Array.isArray(data)) {
      for (const row of data as Array<{ account_number: string; debit: number | string; credit: number | string }>) {
        sums.set(row.account_number, { debit: Number(row.debit) || 0, credit: Number(row.credit) || 0 })
      }
      return sums
    }
    if (error) log.warn('account_period_sums unavailable, summing rows', { code: (error as { code?: string }).code })
  }

  for (const line of await rowFallback()) {
    const current = sums.get(line.account_number) ?? { debit: 0, credit: 0 }
    current.debit += Number(line.debit_amount) || 0
    current.credit += Number(line.credit_amount) || 0
    sums.set(line.account_number, current)
  }
  return sums
}
