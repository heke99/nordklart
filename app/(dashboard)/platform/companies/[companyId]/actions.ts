'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requirePlatformAdmin } from '@/lib/auth/platform'

function fail(companyId: string, message: string): never {
  redirect(`/platform/companies/${companyId}?error=${encodeURIComponent(message)}`)
}

function done(companyId: string, message: string): never {
  redirect(`/platform/companies/${companyId}?notice=${encodeURIComponent(message)}`)
}

function text(formData: FormData, key: string, required = false) {
  const value = String(formData.get(key) ?? '').trim()
  if (required && !value) throw new Error('required')
  return value || null
}

function dateValue(formData: FormData, key: string) {
  const value = text(formData, key)
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('invalid_date')
  return date.toISOString()
}

function numberValue(formData: FormData, key: string, fallback: number) {
  const raw = text(formData, key)
  if (!raw) return fallback
  const parsed = Number(raw.replace(',', '.'))
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('invalid_number')
  return parsed
}

async function assertCompany(companyId: string) {
  const { supabase } = await requirePlatformAdmin()
  const { data, error } = await supabase.from('companies').select('id').eq('id', companyId).maybeSingle()
  if (error || !data) fail(companyId, 'Bolaget finns inte eller kan inte administreras.')
  return supabase
}

export async function setCompanySubscriptionFromCardAction(formData: FormData) {
  const companyId = text(formData, 'company_id', true)!
  try {
    const supabase = await assertCompany(companyId)
    const planVersionId = text(formData, 'plan_version_id', true)!
    const status = text(formData, 'status', true) || 'active'
    const periodEnd = dateValue(formData, 'current_period_end')
    const note = text(formData, 'note') || 'Manuellt administrerat från bolagskortet'

    const { error } = await supabase.rpc('platform_set_company_subscription', {
      p_company_id: companyId,
      p_plan_version_id: planVersionId,
      p_status: status,
      p_starts_at: new Date().toISOString(),
      p_current_period_end: periodEnd,
      p_trial_ends_at: null,
      p_override_note: note,
    })
    if (error) fail(companyId, error.message || 'Abonnemanget kunde inte uppdateras.')
    revalidatePath('/platform/companies')
    revalidatePath(`/platform/companies/${companyId}`)
    done(companyId, 'Bolagets abonnemang har uppdaterats och audit-loggats.')
  } catch (error) {
    fail(companyId, error instanceof Error && error.message !== 'required' ? error.message : 'Ett obligatoriskt fält saknas.')
  }
}

export async function addSubscriptionItemFromCardAction(formData: FormData) {
  const companyId = text(formData, 'company_id', true)!
  try {
    const supabase = await assertCompany(companyId)
    const subscriptionId = text(formData, 'subscription_id', true)!
    const planVersionId = text(formData, 'plan_version_id', true)!
    const quantity = numberValue(formData, 'quantity', 1)
    const currentPeriodEnd = dateValue(formData, 'current_period_end')
    const note = text(formData, 'note') || 'Tillägg administrerat från bolagskortet'

    const { error } = await supabase.rpc('platform_add_subscription_item', {
      p_subscription_id: subscriptionId,
      p_plan_version_id: planVersionId,
      p_item_type: 'addon',
      p_quantity: quantity,
      p_current_period_end: currentPeriodEnd,
      p_note: note,
    })
    if (error) fail(companyId, error.message || 'Tillägget kunde inte läggas till.')
    revalidatePath('/platform/companies')
    revalidatePath(`/platform/companies/${companyId}`)
    done(companyId, 'Tillägget har lagts till och audit-loggats.')
  } catch (error) {
    fail(companyId, error instanceof Error && error.message !== 'required' ? error.message : 'Ett obligatoriskt fält saknas.')
  }
}

export async function grantCompanyAccessFromCardAction(formData: FormData) {
  const companyId = text(formData, 'company_id', true)!
  try {
    const supabase = await assertCompany(companyId)
    const grantType = text(formData, 'grant_type', true)!
    const startsAt = dateValue(formData, 'starts_at') || new Date().toISOString()
    const expiresAt = dateValue(formData, 'expires_at')
    const note = text(formData, 'note') || 'Beviljad från bolagskortet'
    const rpcName = grantType === 'complimentary_bankgiro'
      ? 'platform_grant_complimentary_bankgiro'
      : 'platform_grant_complimentary_full_access'

    const { error } = await supabase.rpc(rpcName, {
      p_company_id: companyId,
      p_starts_at: startsAt,
      p_expires_at: expiresAt,
      p_note: note,
    })
    if (error) fail(companyId, error.message || 'Åtkomsten kunde inte beviljas.')
    revalidatePath('/platform/companies')
    revalidatePath(`/platform/companies/${companyId}`)
    done(companyId, 'Åtkomsten har beviljats och audit-loggats.')
  } catch (error) {
    fail(companyId, error instanceof Error && error.message !== 'required' ? error.message : 'Ett obligatoriskt fält saknas.')
  }
}

export async function revokeCompanyAccessFromCardAction(formData: FormData) {
  const companyId = text(formData, 'company_id', true)!
  try {
    const supabase = await assertCompany(companyId)
    const grantId = text(formData, 'grant_id', true)!
    const reason = text(formData, 'reason', true)
    const { error } = await supabase.rpc('platform_revoke_commercial_access_grant', {
      p_grant_id: grantId,
      p_reason: reason,
    })
    if (error) fail(companyId, error.message || 'Åtkomsten kunde inte återkallas.')
    revalidatePath('/platform/companies')
    revalidatePath(`/platform/companies/${companyId}`)
    done(companyId, 'Åtkomsten har återkallats och audit-loggats.')
  } catch (error) {
    fail(companyId, error instanceof Error && error.message !== 'required' ? error.message : 'Ett obligatoriskt fält saknas.')
  }
}
