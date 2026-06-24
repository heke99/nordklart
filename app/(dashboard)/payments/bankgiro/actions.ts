'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getActiveCompanyId } from '@/lib/company/context'
import { checkFeatureAccess, NORDKLART_FEATURES } from '@/lib/platform/entitlements'

function text(formData: FormData, key: string) {
  const value = formData.get(key)
  return typeof value === 'string' ? value.trim() : ''
}

function numberOrNull(value: string) {
  if (!value) return null
  const parsed = Number(value.replaceAll(' ', '').replace(',', '.'))
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

export async function requestBankgiroApplicationAction(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const companyId = await getActiveCompanyId(supabase, user.id)
  if (!companyId) redirect('/onboarding?intent=bankgiro')

  const featureAccess = await checkFeatureAccess(supabase, companyId, NORDKLART_FEATURES.bankgiroApplication)
  if (!featureAccess.allowed) {
    redirect('/payments/bankgiro?error=bankgiro_access_required')
  }

  const providerId = text(formData, 'provider_id') || null
  const status = text(formData, 'status') === 'submitted' ? 'submitted' : 'draft'
  const monthlyVolume = numberOrNull(text(formData, 'expected_monthly_volume'))
  const useCase = text(formData, 'use_case')
  const ownerName = text(formData, 'beneficial_owner_name')
  const ownerRole = text(formData, 'beneficial_owner_role')
  const companyActivity = text(formData, 'company_activity')
  const customerType = text(formData, 'customer_type')

  const beneficialOwners = ownerName
    ? [{ name: ownerName, role: ownerRole || 'verklig huvudman' }]
    : []

  const { error } = await supabase.rpc('request_bankgiro_application', {
    p_company_id: companyId,
    p_provider_id: providerId,
    p_status: status,
    p_expected_monthly_volume: monthlyVolume,
    p_use_case: useCase || null,
    p_beneficial_owners: beneficialOwners,
    p_company_questions: {
      activity: companyActivity || null,
      customer_type: customerType || null,
    },
    p_volume_answers: {
      expected_monthly_volume: monthlyVolume,
    },
    p_requested_by: user.id,
  })

  if (error) {
    const code = error.code === '23505'
      ? 'active_application_exists'
      : error.code === '42501'
        ? 'not_allowed'
        : 'application_failed'
    redirect(`/payments/bankgiro?error=${code}`)
  }

  revalidatePath('/payments/bankgiro')
  redirect('/payments/bankgiro?notice=application_created')
}
