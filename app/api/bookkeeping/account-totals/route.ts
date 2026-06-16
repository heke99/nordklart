import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

  const { searchParams } = new URL(request.url)
  const from = searchParams.get('from')
  const to = searchParams.get('to')
  const dateFrom = searchParams.get('date_from')
  const dateTo = searchParams.get('date_to')
  const groupBy = searchParams.get('group_by')

  if (!from || !to) {
    return NextResponse.json(
      { error: 'from and to account numbers are required' },
      { status: 400 }
    )
  }

  // Get posted journal entries within date range
  let entriesQuery = supabase
    .from('journal_entries')
    .select('id, entry_date')
    .eq('company_id', companyId)
    .eq('status', 'posted')

  if (dateFrom) {
    entriesQuery = entriesQuery.gte('entry_date', dateFrom)
  }
  if (dateTo) {
    entriesQuery = entriesQuery.lte('entry_date', dateTo)
  }

  const { data: entries, error: entriesError } = await entriesQuery

  if (entriesError) {
    return NextResponse.json({ error: entriesError.message }, { status: 500 })
  }

  if (!entries || entries.length === 0) {
    return NextResponse.json({ totals: [], monthly: groupBy === 'month' ? [] : undefined })
  }

  const entryIds = entries.map((e) => e.id)
  const entryDateMap = new Map(entries.map((e) => [e.id, e.entry_date]))

  // Fetch lines in batches to avoid URL length limits
  const batchSize = 200
  const allLines: Array<{
    journal_entry_id: string
    account_number: string
    debit_amount: number
    credit_amount: number
  }> = []

  for (let i = 0; i < entryIds.length; i += batchSize) {
    const batch = entryIds.slice(i, i + batchSize)
    const { data: lines, error: linesError } = await supabase
      .from('journal_entry_lines')
      .select('journal_entry_id, account_number, debit_amount, credit_amount')
      .in('journal_entry_id', batch)
      .gte('account_number', from)
      .lte('account_number', to)

    if (linesError) {
      return NextResponse.json({ error: linesError.message }, { status: 500 })
    }
    if (lines) {
      allLines.push(...lines)
    }
  }

  // Aggregate by account
  const accountTotals = new Map<string, { debit: number; credit: number }>()

  for (const line of allLines) {
    const existing = accountTotals.get(line.account_number) || { debit: 0, credit: 0 }
    existing.debit += Number(line.debit_amount) || 0
    existing.credit += Number(line.credit_amount) || 0
    accountTotals.set(line.account_number, existing)
  }

  const totals = Array.from(accountTotals.entries())
    .map(([account_number, bal]) => ({
      account_number,
      debit: Math.round(bal.debit * 100) / 100,
      credit: Math.round(bal.credit * 100) / 100,
      net: Math.round((bal.debit - bal.credit) * 100) / 100,
    }))
    .sort((a, b) => a.account_number.localeCompare(b.account_number))

  // Monthly grouping
  if (groupBy === 'month') {
    const monthlyMap = new Map<string, Map<string, { debit: number; credit: number }>>()

    for (const line of allLines) {
      const entryDate = entryDateMap.get(line.journal_entry_id)
      if (!entryDate) continue
      const month = entryDate.slice(0, 7)
      if (!monthlyMap.has(month)) {
        monthlyMap.set(month, new Map())
      }
      const monthAccounts = monthlyMap.get(month)!
      const existing = monthAccounts.get(line.account_number) || { debit: 0, credit: 0 }
      existing.debit += Number(line.debit_amount) || 0
      existing.credit += Number(line.credit_amount) || 0
      monthAccounts.set(line.account_number, existing)
    }

    const monthlyFlat = Array.from(monthlyMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([month, accounts]) =>
        Array.from(accounts.entries()).map(([account_number, bal]) => ({
          month,
          account_number,
          debit: Math.round(bal.debit * 100) / 100,
          credit: Math.round(bal.credit * 100) / 100,
          net: Math.round((bal.debit - bal.credit) * 100) / 100,
        }))
      )

    return NextResponse.json({ totals, monthly: monthlyFlat })
  }

  return NextResponse.json({ totals })
}
