import { requireCompanyFeatureResponse } from '@/lib/platform/feature-policy'
import { NORDKLART_FEATURES } from '@/lib/platform/entitlements'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { generateJournalRegister } from '@/lib/reports/journal-register'
import { requireCompanyId } from '@/lib/company/context'

export async function GET(request: Request) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)
  const featureGateResponse = await requireCompanyFeatureResponse(supabase, companyId, NORDKLART_FEATURES.reportsCore)
  if (featureGateResponse) return featureGateResponse

  const { searchParams } = new URL(request.url)
  const periodId = searchParams.get('period_id')

  if (!periodId) {
    return NextResponse.json({ error: 'period_id is required' }, { status: 400 })
  }

  const data = await generateJournalRegister(supabase, companyId, periodId)

  return NextResponse.json({ data })
}
