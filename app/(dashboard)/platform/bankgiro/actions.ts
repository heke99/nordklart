'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requirePlatformAdmin } from '@/lib/auth/platform'

const REVIEW_STATUSES = [
  'under_review',
  'needs_information',
  'approved',
  'provider_setup',
  'active',
  'rejected',
  'suspended',
] as const

type ReviewStatus = (typeof REVIEW_STATUSES)[number]

function fail(message: string): never {
  redirect(`/platform/bankgiro?error=${encodeURIComponent(message)}`)
}

function done(message: string): never {
  redirect(`/platform/bankgiro?notice=${encodeURIComponent(message)}`)
}

/**
 * Platform review of a Bankgiro/Autogiro application: moves the application
 * through the review pipeline. Superadmin only; every transition stamps
 * reviewed_by/reviewed_at and appends a bankgiro_provider_status_events row
 * so the support timeline shows who decided what and when.
 */
export async function reviewBankgiroApplicationAction(formData: FormData) {
  const { supabase, user } = await requirePlatformAdmin()

  const applicationId = String(formData.get('application_id') ?? '').trim()
  const nextStatus = String(formData.get('next_status') ?? '').trim() as ReviewStatus
  const note = String(formData.get('note') ?? '').trim()

  if (!applicationId) fail('Ansökan saknas.')
  if (!REVIEW_STATUSES.includes(nextStatus)) fail('Ogiltig status.')
  if (nextStatus === 'rejected' && !note) fail('Ange en motivering vid avslag.')

  const { data: application, error: fetchError } = await supabase
    .from('bankgiro_applications')
    .select('id, company_id, status')
    .eq('id', applicationId)
    .maybeSingle()

  if (fetchError || !application) fail('Ansökan kunde inte läsas.')

  const now = new Date().toISOString()
  const { error: updateError } = await supabase
    .from('bankgiro_applications')
    .update({
      status: nextStatus,
      reviewed_by: user.id,
      reviewed_at: now,
      rejection_reason: nextStatus === 'rejected' ? note : null,
      ...(nextStatus === 'active' ? { activated_at: now } : {}),
    })
    .eq('id', applicationId)

  if (updateError) fail(updateError.message || 'Statusen kunde inte uppdateras.')

  // Append-only decision trail alongside provider webhooks.
  await supabase.from('bankgiro_provider_status_events').insert({
    application_id: applicationId,
    company_id: application!.company_id,
    provider_status: `platform_review:${nextStatus}`,
    payload: {
      previous_status: application!.status,
      next_status: nextStatus,
      note: note || null,
      reviewed_by: user.id,
    },
  })

  revalidatePath('/platform/bankgiro')
  done(`Ansökan uppdaterad till ${nextStatus}.`)
}
