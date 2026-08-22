import { withRouteContext } from '@/lib/api/with-route-context'
import { NextResponse } from 'next/server'
import { generateARLedger } from '@/lib/reports/ar-ledger'
import { generateARReconciliation } from '@/lib/reports/ar-reconciliation'

export const GET = withRouteContext('reports.ar_ledger', async (request, ctx) => {
  const { supabase, companyId } = ctx
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
})
