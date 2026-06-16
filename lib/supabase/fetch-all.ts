const PAGE_SIZE = 1000

/**
 * Fetches all rows from a Supabase query by paginating through results.
 * Overcomes PostgREST's default 1000-row limit.
 *
 * The callback receives `{ from, to }` range values — append `.range(from, to)`
 * to your query builder:
 *
 * ```ts
 * const accounts = await fetchAllRows(({ from, to }) =>
 *   supabase
 *     .from('chart_of_accounts')
 *     .select('account_number, account_name')
 *     .eq('company_id', companyId)
 *     .range(from, to)
 * )
 * ```
 */
export async function fetchAllRows<T>(
  queryFn: (range: { from: number; to: number }) => PromiseLike<{
    data: T[] | null
    error: { message: string } | null
  }>
): Promise<T[]> {
  const allRows: T[] = []
  let from = 0

  while (true) {
    const { data, error } = await queryFn({ from, to: from + PAGE_SIZE - 1 })
    if (error) throw new Error(error.message)
    if (!data || data.length === 0) break
    allRows.push(...data)
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  return allRows
}
