import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { z } from 'zod'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { ensureInitialized } from '@/lib/init'
import { assertAgencyStaffCapacity, resolveManageableAgency } from '@/lib/agency/commercial'
import { generateInviteToken, getInviteExpiry } from '@/lib/auth/invite-tokens'
import { getEmailService } from '@/lib/email/service'
import { createLogger } from '@/lib/logger'
import { checkDurableRateLimit } from '@/lib/auth/rate-limit-durable'
import {
  AGENCY_INVITE_ROLE_LABELS,
  generateAgencyInviteEmailHtml,
  generateAgencyInviteEmailSubject,
  generateAgencyInviteEmailText,
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
  const authResult = await requireAuth()
  if (authResult.error) return authResult.error
  const { user } = authResult
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const limit = await checkDurableRateLimit({
    prefix: 'invite:agency:user',
    identifier: user.id,
    maxRequests: 20,
    windowMs: 60 * 60 * 1000,
  })
  if (!limit.ok) return limit.response!

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

  // A pending invitation that has expired no longer blocks a new one; mark it
  // expired first so the one-pending-per-e-mail index lets the new row in.
  await serviceClient
    .from('agency_invitations')
    .update({ status: 'expired' })
    .eq('agency_id', agencyAccess.agencyId)
    .eq('email', email)
    .eq('status', 'pending')
    .lte('expires_at', new Date().toISOString())

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
    log.error('agency invitation insert failed', { code: insertError.code })
    if (insertError.code === '23505') {
      return NextResponse.json({ error: 'En byråinbjudan har redan skickats till denna e-post.' }, { status: 409 })
    }
    return NextResponse.json({ error: 'Kunde inte skapa byråinbjudan.' }, { status: 500 })
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  const inviteUrl = `${appUrl}/invite/${token}`
  const emailService = getEmailService()

  if (emailService.isConfigured()) {
    const emailData = {
      agencyName: agencyRow.name || 'Redovisningsbyrå',
      inviterEmail: user.email || '',
      inviteUrl,
      roleLabel: AGENCY_INVITE_ROLE_LABELS[parsed.data.role] ?? 'medarbetare',
    }

    const result = await emailService.sendEmail({
      to: email,
      subject: generateAgencyInviteEmailSubject(emailData),
      html: generateAgencyInviteEmailHtml(emailData),
      text: generateAgencyInviteEmailText(emailData),
      context: {
        companyId: agencyRow.company_id,
        templateKey: 'agency.staff_invite',
      },
    })

    if (!result.success) {
      log.error('agency staff invite email send failed', { agencyId: agencyAccess.agencyId })
    }
  } else {
    log.warn('agency staff invite email service not configured', { agencyId: agencyAccess.agencyId })
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

/**
 * GET /api/agency/staff/invite?agency_id=
 * Pending staff invitations of an agency the caller administers.
 */
export async function GET(request: Request) {
  const supabase = await createClient()
  const authResult = await requireAuth()
  if (authResult.error) return authResult.error
  const { user } = authResult

  const agencyId = new URL(request.url).searchParams.get('agency_id')
  if (agencyId && !z.string().uuid().safeParse(agencyId).success) {
    return NextResponse.json({ error: 'Ogiltigt byrå-id.' }, { status: 400 })
  }

  const agencyAccess = await resolveManageableAgency(supabase, user.id, agencyId)
  if (!agencyAccess.ok) return agencyAccess.response

  const { data, error } = await createServiceClient()
    .from('agency_invitations')
    .select('id, email, role, status, expires_at, created_at, invited_by')
    .eq('agency_id', agencyAccess.agencyId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })

  if (error) {
    log.error('agency invitation list failed', { code: error.code })
    return NextResponse.json({ error: 'Kunde inte hämta inbjudningar.' }, { status: 500 })
  }

  const now = Date.now()
  return NextResponse.json({
    data: (data ?? []).map((row) => ({ ...row, expired: new Date(row.expires_at).getTime() <= now })),
  })
}

const RevokeSchema = z.object({ id: z.string().uuid(), agency_id: z.string().uuid().optional() })

/**
 * DELETE /api/agency/staff/invite  { id, agency_id? }
 * Revokes a pending staff invitation of an agency the caller administers.
 */
export async function DELETE(request: Request) {
  const supabase = await createClient()
  const authResult = await requireAuth()
  if (authResult.error) return authResult.error
  const { user } = authResult

  const parsed = RevokeSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Ogiltig begäran.' }, { status: 400 })
  }

  const agencyAccess = await resolveManageableAgency(supabase, user.id, parsed.data.agency_id ?? null)
  if (!agencyAccess.ok) return agencyAccess.response

  const { data, error } = await createServiceClient()
    .from('agency_invitations')
    .update({ status: 'revoked', revoked_by: user.id, revoked_at: new Date().toISOString() })
    .eq('id', parsed.data.id)
    .eq('agency_id', agencyAccess.agencyId)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle()

  if (error) {
    log.error('agency invitation revoke failed', { code: error.code })
    return NextResponse.json({ error: 'Kunde inte återkalla inbjudan.' }, { status: 500 })
  }
  if (!data) {
    return NextResponse.json({ error: 'Inbjudan hittades inte eller är inte väntande.' }, { status: 404 })
  }

  return NextResponse.json({ data: { revoked: data.id } })
}
