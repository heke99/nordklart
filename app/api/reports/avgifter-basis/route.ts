import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'
import { generateAvgifterBasis } from '@/lib/reports/avgifter-basis'

/**
 * Arbetsgivaravgiftsunderlag report.
 * Monthly breakdown by avgifter rate category for AGI reconciliation.
 * Per BFL: Part of räkenskapsinformation, 7-year retention.
 */
export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const companyId = await requireCompanyId(supabase, user.id)

  const { searchParams } = new URL(request.url)
  const year = parseInt(searchParams.get('year') || new Date().getFullYear().toString())

  try {
    const report = await generateAvgifterBasis(supabase, companyId, year)
    return NextResponse.json({ data: report })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Kunde inte generera avgiftsunderlag'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
