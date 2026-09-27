import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { resolveCompanyAccess } from '@/lib/access/company'
import { generateInviteToken, getInviteExpiry } from '@/lib/auth/invite-tokens'
import { getEmailService } from '@/lib/email/service'
import { assertCommercialLimit, COMMERCIAL_LIMITS } from '@/lib/platform/entitlement-limits'
import { checkDurableRateLimit } from '@/lib/auth/rate-limit-durable'
import { createLogger } from '@/lib/logger'
import {
  generateInviteEmailSubject,
  generateInviteEmailHtml,
  generateInviteEmailText,
} from '@/lib/email/invite-templates'

// Loads the email extension so getEmailService() returns the Resend
// implementation instead of the noop default. Without this, the invite email
// is silently skipped in dev whenever this route is hit before any other
// init'd route in the process.
ensureInitialized()

const log = createLogger('api/company/members/invite')

/**
 * POST /api/company/members/invite
 * Invite a user to the current company (e.g., a client as viewer).
 * Only company owners and admins can invite.
 *
 * The wrapper resolves companyId through the same validated path this route
 * used by hand, and adds requireAuth's AAL2 check. canManageCompany below is
 * what authorizes the action; requireWrite is deliberately not set for the
 * same reason as the access-request routes — it authorizes on direct
 * membership and would exclude the platform-admin path canManageCompany
 * admits. The service client and its company_id scoping are untouched.
 */
export const POST = withRouteContext('company.members.invite', async (request, { supabase, user, companyId }) => {
  const access = await resolveCompanyAccess(supabase, companyId)
  if (!access?.canManageCompany) {
    return NextResponse.json({ error: 'Behörighet saknas.' }, { status: 403 })
  }

  // Each invite sends an e-mail naming the company to an address of the
  // caller's choosing; bound it per inviter and per company.
  for (const [prefix, identifier, maxRequests, windowMs] of [
    ['invite:company:user', user.id, 20, 60 * 60 * 1000],
    ['invite:company:company', companyId, 50, 24 * 60 * 60 * 1000],
  ] as const) {
    const limit = await checkDurableRateLimit({ prefix, identifier, maxRequests, windowMs })
    if (!limit.ok) return limit.response!
  }

  const serviceClient = createServiceClient()

  const body = await request.json().catch(() => ({}))
  const email = (typeof body?.email === 'string' ? body.email : '').trim().toLowerCase()
  const role = (typeof body?.role === 'string' ? body.role : '') || 'viewer'

  if (!email || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: 'Ogiltig e-postadress.' }, { status: 400 })
  }

  if (!['admin', 'member', 'viewer', 'accountant', 'auditor'].includes(role)) {
    return NextResponse.json({ error: 'Ogiltig roll.' }, { status: 400 })
  }

  const membershipKind = ['viewer', 'accountant', 'auditor'].includes(role) ? 'external' : 'internal'
  const limitCheck = await assertCommercialLimit(
    supabase,
    companyId,
    membershipKind === 'external' ? COMMERCIAL_LIMITS.externalAdvisors : COMMERCIAL_LIMITS.companyUsers,
    membershipKind === 'external'
      ? 'Din plan tillåter inte fler externa rådgivare eller revisorer'
      : 'Din plan tillåter inte fler interna användare',
  )
  if (!limitCheck.ok) return limitCheck.response

  // Check if email is already a member of this company
  const { data: existingMembers } = await serviceClient
    .from('company_members')
    .select('id, user_id, status')
    .eq('company_id', companyId)
    .in('status', ['active', 'active_limited', 'suspended'])

  if (existingMembers && existingMembers.length > 0) {
    const memberUserIds = existingMembers.map((m) => m.user_id)
    const { data: memberProfiles } = await serviceClient
      .from('profiles')
      .select('id, email')
      .in('id', memberUserIds)

    const matchedProfile = memberProfiles?.find(
      (p) => p.email?.toLowerCase() === email
    )
    if (matchedProfile) {
      const matched = existingMembers.find((m) => m.user_id === matchedProfile.id)
      return NextResponse.json(
        {
          error: matched?.status === 'suspended'
            ? 'Personens åtkomst är pausad. Återaktivera den i medlemslistan i stället för att bjuda in igen.'
            : 'Denna person är redan medlem.',
        },
        { status: 409 },
      )
    }
  }

  // Check for an existing invite. An expired one no longer blocks a new
  // invitation; the row is reused because (company_id, email) is unique.
  const { data: existingInvite } = await serviceClient
    .from('company_invitations')
    .select('id, status, expires_at')
    .eq('company_id', companyId)
    .eq('email', email)
    .maybeSingle()

  if (
    existingInvite
    && existingInvite.status === 'pending'
    && new Date(existingInvite.expires_at) > new Date()
  ) {
    return NextResponse.json({ error: 'En inbjudan har redan skickats till denna e-post.' }, { status: 409 })
  }

  // Get company name for the email
  const { data: company } = await serviceClient
    .from('companies')
    .select('name')
    .eq('id', companyId)
    .single()

  // Generate token
  const { token, hash } = generateInviteToken()
  const expiresAt = getInviteExpiry()

  // Upsert invitation
  if (existingInvite) {
    const { error } = await serviceClient
      .from('company_invitations')
      .update({
        token_hash: hash,
        invited_by: user.id,
        revoked_by: null,
        revoked_at: null,
        accepted_by: null,
        accepted_at: null,
        status: 'pending',
        expires_at: expiresAt.toISOString(),
        role,
        membership_kind: membershipKind,
      })
      .eq('id', existingInvite.id)

    if (error) {
      log.error('invitation write failed', { code: error.code })
      return NextResponse.json({ error: 'Kunde inte skapa inbjudan.' }, { status: 500 })
    }
  } else {
    const { error } = await serviceClient
      .from('company_invitations')
      .insert({
        company_id: companyId,
        email,
        role,
        membership_kind: membershipKind,
        token_hash: hash,
        invited_by: user.id,
        revoked_by: null,
        revoked_at: null,
        status: 'pending',
        expires_at: expiresAt.toISOString(),
      })

    if (error) {
      log.error('invitation write failed', { code: error.code })
      return NextResponse.json({ error: 'Kunde inte skapa inbjudan.' }, { status: 500 })
    }
  }

  // Send email
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  const emailService = getEmailService()
  if (emailService.isConfigured()) {
    const inviteUrl = `${appUrl}/invite/${token}`

    const emailData = {
      companyName: company?.name || 'Företag',
      inviterEmail: user.email || '',
      inviteUrl,
    }

    const result = await emailService.sendEmail({
      to: email,
      subject: generateInviteEmailSubject(emailData),
      html: generateInviteEmailHtml(emailData),
      text: generateInviteEmailText(emailData),
      context: {
        companyId,
        templateKey: 'company.member_invite',
      },
    })

    if (!result.success) {
      log.error('invite email send failed', { companyId })
    }
  } else {
    log.warn('email service not configured; invite e-mail not sent', { companyId })
  }

  // In development, return the invite URL directly (no email service)
  const isDev = process.env.NODE_ENV === 'development'
  const devInviteUrl = isDev ? `${appUrl}/invite/${token}` : undefined

  return NextResponse.json({
    data: { email, status: 'pending', ...(isDev && { inviteUrl: devInviteUrl }) },
  })
})
