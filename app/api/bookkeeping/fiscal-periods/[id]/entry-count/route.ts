import { withRouteContext } from '@/lib/api/with-route-context'
import { NextResponse } from 'next/server'

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.fiscal_periods.entry_count',
  async (_request, ctx, { params }) => {
    const { supabase, companyId } = ctx
    const { id } = await params



    const { data: period, error: fetchError } = await supabase
      .from('fiscal_periods')
      .select('id')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (fetchError || !period) {
      return NextResponse.json({ error: 'Räkenskapsår hittades inte' }, { status: 404 })
    }

    const { count, error: countError } = await supabase
      .from('journal_entries')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('fiscal_period_id', id)
      .in('status', ['posted', 'reversed'])

    if (countError) {
      return NextResponse.json({ error: countError.message }, { status: 500 })
    }

    return NextResponse.json({ data: { posted_count: count ?? 0 } })
  },
)
