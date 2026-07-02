import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * SIE-overlap protection for bank automation.
 *
 * When a completed SIE import covers (part of) the date range of a bank
 * import/sync, the imported GL very likely already contains journal entries
 * for those bank transactions. Auto-booking category entries on top of the
 * SIE-imported ones would double-book (double expense/revenue + wrong bank
 * balance) — so overlap must block category auto-booking while still allowing
 * safe invoice-payment matching for transactions that carry no journal link.
 *
 * Shared by lib/transactions/ingest.ts, the Enable Banking sync paths and the
 * bank-file import routes so the overlap rule cannot drift between callers.
 */
export interface SieOverlapCheck {
  overlaps: boolean
  /** Ids of the completed SIE imports whose fiscal range touches the window. */
  importIds: string[]
}

export async function checkSieOverlap(
  supabase: SupabaseClient,
  companyId: string,
  fromDate: string,
  toDate?: string,
): Promise<SieOverlapCheck> {
  try {
    let query = supabase
      .from('sie_imports')
      .select('id')
      .eq('company_id', companyId)
      .eq('status', 'completed')
      // Import range [fiscal_year_start, fiscal_year_end] intersects
      // [fromDate, toDate]: start ≤ toDate AND end ≥ fromDate.
      .gte('fiscal_year_end', fromDate)

    if (toDate) {
      query = query.lte('fiscal_year_start', toDate)
    }

    const { data } = await query.limit(10)
    const importIds = (data ?? []).map((row) => String((row as { id: string }).id))
    return { overlaps: importIds.length > 0, importIds }
  } catch {
    // Fail SAFE: if the check cannot run, treat the window as overlapping so
    // automation never auto-books into a state it could not verify.
    return { overlaps: true, importIds: [] }
  }
}

/** Overlap check for a batch of transaction dates. */
export async function checkSieOverlapForDates(
  supabase: SupabaseClient,
  companyId: string,
  dates: string[],
): Promise<SieOverlapCheck> {
  if (dates.length === 0) return { overlaps: false, importIds: [] }
  const sorted = [...dates].sort()
  return checkSieOverlap(supabase, companyId, sorted[0], sorted[sorted.length - 1])
}
