import { requireCompanyFeatureResponse } from '@/lib/platform/feature-policy'
import { NORDKLART_FEATURES } from '@/lib/platform/entitlements'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { generateSupplierLedger } from '@/lib/reports/supplier-ledger'
import { generateReconciliation } from '@/lib/reports/supplier-reconciliation'
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
  const asOfDate = searchParams.get('as_of_date') || undefined
  const periodId = searchParams.get('period_id') || undefined

  const ledger = await generateSupplierLedger(supabase, companyId, asOfDate)

  let reconciliation = null
  if (periodId) {
    reconciliation = await generateReconciliation(supabase, companyId, periodId)
  }

  return NextResponse.json({
    data: {
      ledger,
      reconciliation,
    },
  })
}
