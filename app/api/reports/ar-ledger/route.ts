import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { generateARLedger } from '@/lib/reports/ar-ledger'
import { generateARReconciliation } from '@/lib/reports/ar-reconciliation'
import { requireCompanyId } from '@/lib/company/context'

export async function GET(request: Request) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

  const { searchParams } = new URL(request.url)
  const asOfDate = searchParams.get('as_of_date') || undefined
  const periodId = searchParams.get('period_id') || undefined

  const ledger = await generateARLedger(supabase, companyId, asOfDate)

  let reconciliation = null
  if (periodId) {
    reconciliation = await generateARReconciliation(supabase, companyId, periodId)
  }

  return NextResponse.json({
    data: {
      ledger,
      reconciliation,
    },
  })
}
