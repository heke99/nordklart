import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { requireCompanyId } from '@/lib/company/context'
import { requireCompanyFeatureResponse } from '@/lib/platform/feature-policy'
import { NORDKLART_FEATURES } from '@/lib/platform/entitlements'

ensureInitialized()

/**
 * Get tax payment status for an AGI period.
 *
 * Returns the AGI declaration's payment-tracking fields (file generated at,
 * paid at, totals) so the UI can render the TaxPaymentPanel without
 * round-tripping to load the full declaration.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ period: string }> }
) {
  const { period } = await params
  const periodMatch = /^(\d{4})-(\d{2})$/.exec(period)
  if (!periodMatch) {
    return NextResponse.json(
      { error: 'Ogiltig period. Använd YYYY-MM.' },
      { status: 400 }
    )
  }
  const periodYear = parseInt(periodMatch[1], 10)
  const periodMonth = parseInt(periodMatch[2], 10)

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const companyId = await requireCompanyId(supabase, user.id)

  // Commercial feature gate — same policy the JSON counterparts get via
  // withRouteContext (scripts/check-feature-policy-coverage.ts enforces it).
  const featureError = await requireCompanyFeatureResponse(supabase, companyId, NORDKLART_FEATURES.bookkeepingCore)
  if (featureError) return featureError

  const { data: agi } = await supabase
    .from('agi_declarations')
    .select('total_tax, total_avgifter, tax_payment_file_generated_at, tax_payment_file_format, tax_paid_at')
    .eq('company_id', companyId)
    .eq('period_year', periodYear)
    .eq('period_month', periodMonth)
    .single()

  if (!agi) {
    return NextResponse.json({ data: null })
  }

  return NextResponse.json({ data: agi })
}
