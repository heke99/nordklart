import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { ensureInitialized } from '@/lib/init'
import { assertAgencyStaffCapacity, resolveManageableAgency } from '@/lib/agency/commercial'
import { generateInviteToken, getInviteExpiry } from '@/lib/auth/invite-tokens'
import { getEmailService } from '@/lib/email/service'
import { createLogger } from '@/lib/logger'
import {
  generateInviteEmailHtml,
  generateInviteEmailSubject,
  generateInviteEmailText,
} from '@/lib/email/invite-templates'

ensureInitialized()

const log = createLogger('api/agency/staff/invite')

const AgencyStaffInviteSchema = z.object({
  agency_id: z.string().uuid().optional(),
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(['agency_admin', 'accountant', 'payroll', 'reviewer', 'read_only']).default('accountant'),
})

type ExistingProfile = { id: string; email: string | null }
type AgencyRow = { id: string; name: string | null; company_id: string | null }

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const parsed = AgencyStaffInviteSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Ogiltig begäran.', issues: parsed.error.flatten() }, { status: 400 })
  }

  const agencyAccess = await resolveManageableAgency(supabase, user.id, parsed.data.agency_id ?? null)
  if (!agencyAccess.ok) return agencyAccess.response

  const capacity = await assertAgencyStaffCapacity(supabase, agencyAccess.agencyCompanyId)
  if (!capacity.ok) return capacity.response

  const serviceClient = createServiceClient()
  const email = parsed.data.email

  const { data: agency, error: agencyError } = await serviceClient
    .from('agencies')
    .select('id, name, company_id')
    .eq('id', agencyAccess.agencyId)
    .maybeSingle()

  if (agencyError || !agency) {
    return NextResponse.json({ error: 'Byrån kunde inte läsas.' }, { status: 500 })
  }

  const agencyRow = agency as AgencyRow

  const { data: profile } = await serviceClient
    .from('profiles')
    .select('id, email')
    .eq('email', email)
    .maybeSingle()

  const existingProfile = profile as ExistingProfile | null
  if (existingProfile?.id) {
    const { data: existingMember } = await serviceClient
      .from('agency_members')
      .select('id, status')
      .eq('agency_id', agencyAccess.agencyId)
      .eq('user_id', existingProfile.id)
      .maybeSingle()

    if (existingMember && ['active', 'pending'].includes(String(existingMember.status ?? 'active'))) {
      return NextResponse.json({ error: 'Personen är redan medlem eller väntar på åtkomst i byrån.' }, { status: 409 })
    }
  }

  const { data: existingInvite } = await serviceClient
    .from('agency_invitations')
    .select('id, status')
    .eq('agency_id', agencyAccess.agencyId)
    .eq('email', email)
    .eq('status', 'pending')
    .maybeSingle()

  if (existingInvite) {
    return NextResponse.json({ error: 'En byråinbjudan har redan skickats till denna e-post.' }, { status: 409 })
  }

  const { token, hash } = generateInviteToken()
  const expiresAt = getInviteExpiry()

  const { error: insertError } = await serviceClient
    .from('agency_invitations')
    .insert({
      agency_id: agencyAccess.agencyId,
      email,
      role: parsed.data.role,
      token_hash: hash,
      status: 'pending',
      invited_by: user.id,
      expires_at: expiresAt.toISOString(),
      metadata: { created_via: 'agency_staff_invite_api' },
    })

  if (insertError) {
    return NextResponse.json({ error: insertError.message || 'Kunde inte skapa byråinbjudan.' }, { status: 500 })
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  const inviteUrl = `${appUrl}/invite/${token}`
  const emailService = getEmailService()

  if (emailService.isConfigured()) {
    const emailData = {
      companyName: agencyRow.name || 'Redovisningsbyrå',
      inviterEmail: user.email || '',
      inviteUrl,
    }

    const result = await emailService.sendEmail({
      to: email,
      subject: generateInviteEmailSubject(emailData),
      html: generateInviteEmailHtml(emailData),
      text: generateInviteEmailText(emailData),
    })

    if (!result.success) {
      log.error('agency staff invite email send failed', result.error)
    }
  } else {
    log.warn('agency staff invite email service not configured', { email })
  }

  const isDev = process.env.NODE_ENV === 'development'
  return NextResponse.json({
    data: {
      email,
      role: parsed.data.role,
      status: 'pending',
      ...(isDev && { inviteUrl }),
    },
  }, { status: 201 })
}
