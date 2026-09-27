import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/server'
import { checkDurableRateLimit } from '@/lib/auth/rate-limit-durable'
import { clientIpKey } from '@/lib/api/client-ip'
import { hashInviteToken } from '@/lib/auth/invite-tokens'
import { passwordSchema } from '@/lib/auth/password-policy'
import { acceptInvitation } from '@/lib/invitations/accept'
import { createLogger } from '@/lib/logger'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

const log = createLogger('api/auth/invite-signup')

const InviteSignupSchema = z.object({
  token: z.string().trim().min(16).max(200),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  password: passwordSchema,
  acceptedTerms: z.literal(true),
  acceptedPrivacy: z.literal(true),
})

type PendingInvite = { email: string; status: string; expires_at: string }

async function findPendingInvite(
  service: ReturnType<typeof createServiceClient>,
  tokenHash: string,
): Promise<PendingInvite | null | 'error'> {
  for (const table of ['company_invitations', 'agency_invitations'] as const) {
    const { data, error } = await service
      .from(table)
      .select('email, status, expires_at')
      .eq('token_hash', tokenHash)
      .maybeSingle()
    if (error) return 'error'
    if (data) return data as PendingInvite
  }
  return null
}

/**
 * POST /api/auth/invite-signup
 *
 * Creates an account for someone invited to a company or an agency who does
 * not have one yet, and accepts the invitation in the same request. The
 * invitation token was delivered to the invited mailbox, so presenting it is
 * proof of that address: the account is created confirmed, for exactly the
 * invited e-mail, and no company is created (the regular signup flow always
 * creates one). The browser signs in with the new password afterwards.
 */
export async function POST(request: NextRequest) {
  const limit = await checkDurableRateLimit({
    prefix: 'auth:invite-signup',
    identifier: clientIpKey(request),
    maxRequests: 10,
    windowMs: 15 * 60 * 1000,
  })
  if (!limit.ok) return limit.response!

  const parsed = InviteSignupSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    const passwordIssue = parsed.error.issues.find((i) => i.path[0] === 'password')
    return errorResponseFromCode('VALIDATION_ERROR', log, {
      messageSv: passwordIssue?.message ?? 'Fyll i namn, lösenord och godkänn villkoren.',
      status: 400,
    })
  }
  const input = parsed.data
  const service = createServiceClient()

  const invite = await findPendingInvite(service, hashInviteToken(input.token))
  if (invite === 'error') {
    return errorResponseFromCode('INTERNAL_ERROR', log, { messageSv: 'Kunde inte kontrollera inbjudan just nu.', status: 503 })
  }
  if (!invite) {
    return errorResponseFromCode('NOT_FOUND', log, { messageSv: 'Inbjudan hittades inte eller är ogiltig.', status: 404 })
  }
  if (invite.status !== 'pending') {
    return errorResponseFromCode('CONFLICT', log, { messageSv: 'Inbjudan har redan använts eller återkallats.', status: 409 })
  }
  if (new Date(invite.expires_at) <= new Date()) {
    return errorResponseFromCode('CONFLICT', log, { messageSv: 'Inbjudan har gått ut. Be om en ny inbjudan.', status: 410 })
  }

  const email = invite.email.trim().toLowerCase()
  const now = new Date().toISOString()
  const { data: created, error: createError } = await service.auth.admin.createUser({
    email,
    password: input.password,
    email_confirm: true,
    user_metadata: {
      first_name: input.firstName,
      last_name: input.lastName,
      full_name: `${input.firstName} ${input.lastName}`.trim(),
      signup_state: 'invited',
      accepted_terms_at: now,
      accepted_privacy_at: now,
    },
    app_metadata: { has_password: true },
  })

  if (createError || !created.user) {
    // An existing account must log in and accept instead. Same response
    // whatever the reason, so the endpoint cannot be used to probe accounts
    // beyond what the invite page already tells the invitee.
    log.warn('invite signup could not create the account', { code: createError?.code ?? 'no_user' })
    return errorResponseFromCode('CONFLICT', log, {
      messageSv: 'Kontot kunde inte skapas. Har du redan ett konto? Logga in för att gå med.',
      status: 409,
    })
  }

  const userId = created.user.id
  const result = await acceptInvitation(service, input.token, userId)
  if (!result.ok) {
    // Do not leave an orphan account behind for an invite that could not be used.
    await service.auth.admin.deleteUser(userId).catch(() => undefined)
    return errorResponseFromCode(result.status >= 500 ? 'INTERNAL_ERROR' : 'CONFLICT', log, {
      messageSv: result.message,
      status: result.status,
      reason: result.error,
    })
  }

  try {
    await service.from('auth_audit_events').insert({
      user_id: userId,
      email,
      event_type: 'invite_signup_completed',
      status: 'accepted',
      user_agent: request.headers.get('user-agent'),
      metadata: {
        invitation_type: result.type,
        company_id: result.companyId,
        agency_id: result.type === 'agency' ? result.agencyId : null,
        accepted_terms_at: now,
        accepted_privacy_at: now,
      },
    })
  } catch {
    // The account and membership exist; a missing audit row must not undo them.
  }

  return NextResponse.json(
    {
      data: {
        email,
        type: result.type,
        companyId: result.companyId,
        agencyId: result.type === 'agency' ? result.agencyId : null,
      },
    },
    { status: 201 },
  )
}
