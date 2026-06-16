import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { regenerateTaxDeadlinesForUser } from '@/lib/tax/deadline-generator'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'

/**
 * POST /api/tax-deadlines/generate
 * Manually trigger tax deadline generation for the current user
 */
export async function POST() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  // Fetch company settings
  const { data: settings, error: settingsError } = await supabase
    .from('company_settings')
    .select('entity_type, moms_period, f_skatt, vat_registered, pays_salaries, fiscal_year_start_month')
    .eq('company_id', companyId)
    .single()

  if (settingsError || !settings) {
    return NextResponse.json(
      { error: 'Company settings not found' },
      { status: 404 }
    )
  }

  try {
    const result = await regenerateTaxDeadlinesForUser(supabase, companyId, {
      entity_type: settings.entity_type,
      moms_period: settings.moms_period,
      f_skatt: settings.f_skatt,
      vat_registered: settings.vat_registered,
      pays_salaries: settings.pays_salaries ?? false,
      fiscal_year_start_month: settings.fiscal_year_start_month,
    })

    return NextResponse.json({
      success: true,
      created: result.created,
      deleted: result.deleted,
    })
  } catch (error) {
    console.error('Error generating tax deadlines:', error)
    return NextResponse.json(
      { error: 'Failed to generate tax deadlines' },
      { status: 500 }
    )
  }
}
