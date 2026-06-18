import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getActiveCompanyId } from '@/lib/company/context'

export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const companyId = await getActiveCompanyId(supabase, user.id)
  if (!companyId) return NextResponse.json({ error: 'Ingen aktiv arbetsyta.' }, { status: 409 })

  const { data, error } = await supabase.rpc('complete_core_onboarding', {
    p_company_id: companyId,
  })

  if (error || !Array.isArray(data) || !data[0]) {
    return NextResponse.json({ error: 'Kunde inte slutföra installationen.' }, { status: 500 })
  }

  return NextResponse.json({ data: data[0] }, { headers: { 'Cache-Control': 'no-store' } })
}
