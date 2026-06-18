import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { getActiveCompanyId } from '@/lib/company/context'

const Body = z.object({
  path: z.enum([
    'bookkeeping_direct',
    'bank_automation',
    'year_end_one_time',
    'bankgiro_autogiro',
    'agency_setup',
    'configure_later',
  ]),
})

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const payload = Body.safeParse(await request.json().catch(() => null))
  if (!payload.success) return NextResponse.json({ error: 'Ogiltigt val.' }, { status: 400 })

  const companyId = await getActiveCompanyId(supabase, user.id)
  if (!companyId) return NextResponse.json({ error: 'Ingen aktiv arbetsyta.' }, { status: 409 })

  const { data, error } = await supabase.rpc('select_onboarding_start_path', {
    p_company_id: companyId,
    p_path: payload.data.path,
  })

  if (error || !Array.isArray(data) || !data[0]) {
    return NextResponse.json({ error: 'Kunde inte spara valet just nu.' }, { status: 500 })
  }

  return NextResponse.json({ data: data[0] }, { headers: { 'Cache-Control': 'no-store' } })
}
