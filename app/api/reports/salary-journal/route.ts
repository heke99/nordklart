import { withRouteContext } from '@/lib/api/with-route-context'
import { NextResponse } from 'next/server'
import { generateSalaryJournal } from '@/lib/reports/salary-journal'

/**
 * Lönejournal report — per BFNAR 2013:2 behandlingshistorik requirement.
 * Monthly/annual per-employee salary register for AGI reconciliation.
 */
export const GET = withRouteContext('reports.salary_journal', async (request, ctx) => {
  const { supabase, companyId } = ctx
  const { searchParams } = new URL(request.url)
  const year = parseInt(searchParams.get('year') || new Date().getFullYear().toString())
  const monthFrom = searchParams.get('month_from') ? parseInt(searchParams.get('month_from')!) : undefined
  const monthTo = searchParams.get('month_to') ? parseInt(searchParams.get('month_to')!) : undefined

  try {
    const report = await generateSalaryJournal(supabase, companyId, year, monthFrom, monthTo)
    return NextResponse.json({ data: report })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Kunde inte generera lönejournal'
    return NextResponse.json({ error: message }, { status: 500 })
  }
})
