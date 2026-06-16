import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

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
}
