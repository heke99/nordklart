import { createServiceClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { NextResponse, type NextRequest } from 'next/server'
import { hashInviteToken } from '@/lib/auth/invite-tokens'
import { createLogger } from '@/lib/logger'

const log = createLogger('api/team/accept')

/**
 * GET /api/team/accept?token=xxx
 * Validates an invite token and returns invite info (for the invite page).
 * Only company invitations are supported — team invitations are disabled.
 * No auth required — this is a public endpoint.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token')
  if (!token) {
    return NextResponse.json({ error: 'Token saknas.' }, { status: 400 })
  }

  const tokenHash = hashInviteToken(token)
  const serviceClient = createServiceClient()

  const { data: companyInvite, error: inviteLookupError } = await serviceClient
    .from('company_invitations')
    .select('id, email, status, expires_at, company_id, companies:company_id(name)')
    .eq('token_hash', tokenHash)
    .single()

  if (inviteLookupError) {
    log.error('company invitation lookup failed', { code: inviteLookupError.code })
    return NextResponse.json({ error: 'Kunde inte kontrollera inbjudan just nu.' }, { status: 503 })
  }

  if (!companyInvite) {
    return NextResponse.json({ error: 'Inbjudan hittades inte eller är ogiltig.' }, { status: 404 })
  }

  if (companyInvite.status !== 'pending') {
    return NextResponse.json({ error: 'Inbjudan har redan använts.' }, { status: 410 })
  }

  const expired = new Date(companyInvite.expires_at) < new Date()

  const { data: alreadyHasAccount, error: accountLookupError } = await serviceClient.rpc('check_email_exists', {
    email_to_check: companyInvite.email,
  })

  if (accountLookupError) {
    // This is a presentation hint only. A valid invite must still be usable
    // while a staged database rollout catches up with the lookup function.
    log.warn('check_email_exists failed', { code: accountLookupError.code })
  }

  return NextResponse.json({
    data: {
      type: 'company',
      companyName: (companyInvite.companies as unknown as { name: string })?.name || 'Företag',
      email: companyInvite.email,
      expired,
      alreadyHasAccount: alreadyHasAccount === true,
    },
  })
}

/**
 * POST /api/team/accept
 * Accepts a company invite after the user has signed up.
 * Team invitations are disabled — teams are single-user.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth()
  if (auth.error) return auth.error

  const { user } = auth

  const body = await request.json()
  const token = body.token as string
  if (!token) {
    return NextResponse.json({ error: 'Token saknas.' }, { status: 400 })
  }

  const tokenHash = hashInviteToken(token)
  const serviceClient = createServiceClient()

  const { data: companyInvite, error: companyLookupError } = await serviceClient
    .from('company_invitations')
    .select('id, company_id, email, role, status, expires_at, invited_by, membership_kind')
    .eq('token_hash', tokenHash)
    .single()

  if (companyLookupError) {
    log.error('company invitation lookup failed', { code: companyLookupError.code })
    return NextResponse.json({ error: 'Kunde inte kontrollera inbjudan just nu.' }, { status: 503 })
  }

  if (!companyInvite || companyInvite.status !== 'pending') {
    return NextResponse.json({ error: 'Inbjudan är ogiltig.' }, { status: 400 })
  }

  if (new Date(companyInvite.expires_at) < new Date()) {
    await serviceClient
      .from('company_invitations')
      .update({ status: 'expired' })
      .eq('id', companyInvite.id)
    return NextResponse.json({ error: 'Inbjudan har gått ut.' }, { status: 410 })
  }

  if (user.email?.toLowerCase() !== companyInvite.email.toLowerCase()) {
    return NextResponse.json({ error: 'E-postadressen matchar inte inbjudan.' }, { status: 403 })
  }

  // Add user to company
  const { error: memberError } = await serviceClient
    .from('company_members')
    .upsert({
      company_id: companyInvite.company_id,
      user_id: user.id,
      role: companyInvite.role,
      source: 'direct',
      status: 'active',
      access_source: 'invite',
      membership_kind: companyInvite.membership_kind ?? 'internal',
      invited_by: companyInvite.invited_by ?? null,
      approved_by: companyInvite.invited_by ?? null,
      approved_at: new Date().toISOString(),
    }, { onConflict: 'company_id,user_id' })

  if (memberError) {
    if (memberError.code === '23505') {
      return NextResponse.json({ error: 'Du är redan medlem.' }, { status: 409 })
    }
    return NextResponse.json({ error: 'Kunde inte lägga till medlem.' }, { status: 500 })
  }

  // Set active company
  await serviceClient
    .from('user_preferences')
    .upsert({
      user_id: user.id,
      active_company_id: companyInvite.company_id,
    }, { onConflict: 'user_id' })

  // Mark invite as accepted
  await serviceClient
    .from('company_invitations')
    .update({ status: 'accepted', accepted_by: user.id, accepted_at: new Date().toISOString() })
    .eq('id', companyInvite.id)

  return NextResponse.json({
    data: { type: 'company', companyId: companyInvite.company_id },
  })
}
