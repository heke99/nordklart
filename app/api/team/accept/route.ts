import { createServiceClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { NextResponse, type NextRequest } from 'next/server'
import { hashInviteToken } from '@/lib/auth/invite-tokens'
import { createLogger } from '@/lib/logger'
import { checkDurableRateLimit } from '@/lib/auth/rate-limit-durable'
import { truncateIp } from '@/lib/api/truncate-ip'

const log = createLogger('api/team/accept')

type CompanyInviteRow = {
  id: string
  email: string
  status: string
  expires_at: string
  company_id: string
  role?: string | null
  membership_kind?: string | null
  invited_by?: string | null
  companies?: { name: string | null } | { name: string | null }[] | null
}

type AgencyInviteRow = {
  id: string
  agency_id: string
  email: string
  role: string
  status: string
  expires_at: string
  invited_by?: string | null
  agencies?: { name: string | null; company_id: string | null } | { name: string | null; company_id: string | null }[] | null
}

/**
 * Relative authority of each role. Accepting an invitation may raise a
 * member's role but never lower it: an owner who follows an old viewer link
 * must stay owner. Unknown roles rank lowest.
 */
const COMPANY_ROLE_RANK: Record<string, number> = {
  viewer: 1,
  auditor: 1,
  member: 2,
  accountant: 3,
  admin: 4,
  owner: 5,
}

const AGENCY_ROLE_RANK: Record<string, number> = {
  read_only: 1,
  reviewer: 2,
  payroll: 3,
  accountant: 3,
  agency_admin: 4,
  agency_owner: 5,
}

function rank(table: Record<string, number>, role: string | null | undefined): number {
  return (role && table[role]) || 0
}

function clientIp(request: NextRequest): string {
  const raw = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || ''
  return truncateIp(raw || undefined) ?? 'unknown'
}

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

async function findCompanyInvite(serviceClient: ReturnType<typeof createServiceClient>, tokenHash: string) {
  const { data, error } = await serviceClient
    .from('company_invitations')
    .select('id, email, status, expires_at, company_id, role, membership_kind, invited_by, companies:company_id(name)')
    .eq('token_hash', tokenHash)
    .maybeSingle()

  if (error) {
    log.error('company invitation lookup failed', { code: error.code })
    throw new Error('lookup_failed')
  }

  return data as CompanyInviteRow | null
}

async function findAgencyInvite(serviceClient: ReturnType<typeof createServiceClient>, tokenHash: string) {
  const { data, error } = await serviceClient
    .from('agency_invitations')
    .select('id, agency_id, email, role, status, expires_at, invited_by, agencies:agency_id(name, company_id)')
    .eq('token_hash', tokenHash)
    .maybeSingle()

  if (error) {
    log.error('agency invitation lookup failed', { code: error.code })
    throw new Error('lookup_failed')
  }

  return data as AgencyInviteRow | null
}

/**
 * GET /api/team/accept?token=xxx
 * Validates an invite token and returns invite info (for the invite page).
 * Supports company invitations and agency staff invitations. The legacy route
 * name stays for compatibility with the existing invite page.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token')
  if (!token) {
    return NextResponse.json({ error: 'Token saknas.' }, { status: 400 })
  }

  // Unauthenticated lookup: bound it so tokens cannot be probed at volume.
  const limit = await checkDurableRateLimit({
    prefix: 'invite:lookup',
    identifier: clientIp(request),
    maxRequests: 30,
    windowMs: 15 * 60 * 1000,
  })
  if (!limit.ok) return limit.response!

  const tokenHash = hashInviteToken(token)
  const serviceClient = createServiceClient()

  let companyInvite: CompanyInviteRow | null
  try {
    companyInvite = await findCompanyInvite(serviceClient, tokenHash)
  } catch {
    return NextResponse.json({ error: 'Kunde inte kontrollera inbjudan just nu.' }, { status: 503 })
  }

  if (companyInvite) {
    if (companyInvite.status !== 'pending') {
      return NextResponse.json({ error: 'Inbjudan har redan använts.' }, { status: 410 })
    }

    const expired = new Date(companyInvite.expires_at) < new Date()
    const { data: alreadyHasAccount, error: accountLookupError } = await serviceClient.rpc('check_email_exists', {
      email_to_check: companyInvite.email,
    })

    if (accountLookupError) {
      log.warn('check_email_exists failed', { code: accountLookupError.code })
    }

    const company = firstRelation(companyInvite.companies)
    return NextResponse.json({
      data: {
        type: 'company',
        companyName: company?.name || 'Företag',
        email: companyInvite.email,
        expired,
        alreadyHasAccount: alreadyHasAccount === true,
      },
    })
  }

  let agencyInvite: AgencyInviteRow | null
  try {
    agencyInvite = await findAgencyInvite(serviceClient, tokenHash)
  } catch {
    return NextResponse.json({ error: 'Kunde inte kontrollera inbjudan just nu.' }, { status: 503 })
  }

  if (!agencyInvite) {
    return NextResponse.json({ error: 'Inbjudan hittades inte eller är ogiltig.' }, { status: 404 })
  }

  if (agencyInvite.status !== 'pending') {
    return NextResponse.json({ error: 'Inbjudan har redan använts.' }, { status: 410 })
  }

  const expired = new Date(agencyInvite.expires_at) < new Date()
  const { data: alreadyHasAccount, error: accountLookupError } = await serviceClient.rpc('check_email_exists', {
    email_to_check: agencyInvite.email,
  })

  if (accountLookupError) {
    log.warn('check_email_exists failed', { code: accountLookupError.code })
  }

  const agency = firstRelation(agencyInvite.agencies)
  return NextResponse.json({
    data: {
      type: 'agency',
      companyName: agency?.name || 'Redovisningsbyrå',
      email: agencyInvite.email,
      expired,
      alreadyHasAccount: alreadyHasAccount === true,
    },
  })
}

/**
 * POST /api/team/accept
 * Accepts company invites and agency staff invites after the user has signed up.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth()
  if (auth.error) return auth.error

  const { user } = auth

  const limit = await checkDurableRateLimit({
    prefix: 'invite:accept',
    identifier: user.id,
    maxRequests: 10,
    windowMs: 15 * 60 * 1000,
  })
  if (!limit.ok) return limit.response!

  const body = await request.json().catch(() => ({}))
  const token = body.token as string
  if (!token) {
    return NextResponse.json({ error: 'Token saknas.' }, { status: 400 })
  }

  const tokenHash = hashInviteToken(token)
  const serviceClient = createServiceClient()

  let companyInvite: CompanyInviteRow | null
  try {
    companyInvite = await findCompanyInvite(serviceClient, tokenHash)
  } catch {
    return NextResponse.json({ error: 'Kunde inte kontrollera inbjudan just nu.' }, { status: 503 })
  }

  if (companyInvite) {
    if (companyInvite.status !== 'pending') {
      return NextResponse.json({ error: 'Inbjudan är ogiltig.' }, { status: 400 })
    }

    if (new Date(companyInvite.expires_at) < new Date()) {
      await serviceClient.from('company_invitations').update({ status: 'expired' }).eq('id', companyInvite.id)
      return NextResponse.json({ error: 'Inbjudan har gått ut.' }, { status: 410 })
    }

    if (user.email?.toLowerCase() !== companyInvite.email.toLowerCase()) {
      return NextResponse.json({ error: 'E-postadressen matchar inte inbjudan.' }, { status: 403 })
    }

    // Claim the invitation first, conditionally on it still being pending.
    // Only one request can win this UPDATE, so a token cannot be redeemed
    // twice by concurrent requests.
    const acceptedAt = new Date().toISOString()
    const { data: claimed, error: claimError } = await serviceClient
      .from('company_invitations')
      .update({ status: 'accepted', accepted_by: user.id, accepted_at: acceptedAt })
      .eq('id', companyInvite.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()

    if (claimError) {
      log.error('company invitation claim failed', { code: claimError.code })
      return NextResponse.json({ error: 'Kunde inte acceptera inbjudan just nu.' }, { status: 503 })
    }
    if (!claimed) {
      return NextResponse.json({ error: 'Inbjudan har redan använts.' }, { status: 409 })
    }

    const invitedRole = companyInvite.role ?? 'viewer'
    const { data: existing } = await serviceClient
      .from('company_members')
      .select('id, role, status')
      .eq('company_id', companyInvite.company_id)
      .eq('user_id', user.id)
      .maybeSingle()

    let memberError: { code?: string } | null = null
    if (!existing) {
      const { error } = await serviceClient.from('company_members').insert({
        company_id: companyInvite.company_id,
        user_id: user.id,
        role: invitedRole,
        source: 'direct',
        status: 'active',
        access_source: 'invite',
        membership_kind: companyInvite.membership_kind ?? 'internal',
        invited_by: companyInvite.invited_by ?? null,
        approved_by: companyInvite.invited_by ?? null,
        approved_at: acceptedAt,
      })
      memberError = error
    } else if (existing.role !== 'owner') {
      // Keep the higher of the current and the invited role; an invitation
      // (re)activates a pending/revoked membership but never demotes.
      const role = rank(COMPANY_ROLE_RANK, invitedRole) > rank(COMPANY_ROLE_RANK, existing.role)
        ? invitedRole
        : existing.role
      const { error } = await serviceClient
        .from('company_members')
        .update({
          role,
          status: 'active',
          access_source: 'invite',
          approved_by: companyInvite.invited_by ?? null,
          approved_at: acceptedAt,
        })
        .eq('id', existing.id)
      memberError = error
    }

    if (memberError) {
      log.error('company membership write failed after claim', { code: memberError.code })
      await serviceClient
        .from('company_invitations')
        .update({ status: 'pending', accepted_by: null, accepted_at: null })
        .eq('id', companyInvite.id)
      return NextResponse.json({ error: 'Kunde inte lägga till medlem.' }, { status: 500 })
    }

    await serviceClient.from('user_preferences').upsert({
      user_id: user.id,
      active_company_id: companyInvite.company_id,
      active_workspace_type: 'company',
      active_agency_id: null,
    }, { onConflict: 'user_id' })

    return NextResponse.json({ data: { type: 'company', companyId: companyInvite.company_id } })
  }

  let agencyInvite: AgencyInviteRow | null
  try {
    agencyInvite = await findAgencyInvite(serviceClient, tokenHash)
  } catch {
    return NextResponse.json({ error: 'Kunde inte kontrollera inbjudan just nu.' }, { status: 503 })
  }

  if (!agencyInvite || agencyInvite.status !== 'pending') {
    return NextResponse.json({ error: 'Inbjudan är ogiltig.' }, { status: 400 })
  }

  if (new Date(agencyInvite.expires_at) < new Date()) {
    await serviceClient.from('agency_invitations').update({ status: 'expired' }).eq('id', agencyInvite.id)
    return NextResponse.json({ error: 'Inbjudan har gått ut.' }, { status: 410 })
  }

  if (user.email?.toLowerCase() !== agencyInvite.email.toLowerCase()) {
    return NextResponse.json({ error: 'E-postadressen matchar inte inbjudan.' }, { status: 403 })
  }

  const acceptedAt = new Date().toISOString()
  const { data: claimed, error: claimError } = await serviceClient
    .from('agency_invitations')
    .update({ status: 'accepted', accepted_by: user.id, accepted_at: acceptedAt })
    .eq('id', agencyInvite.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle()

  if (claimError) {
    log.error('agency invitation claim failed', { code: claimError.code })
    return NextResponse.json({ error: 'Kunde inte acceptera inbjudan just nu.' }, { status: 503 })
  }
  if (!claimed) {
    return NextResponse.json({ error: 'Inbjudan har redan använts.' }, { status: 409 })
  }

  const agency = firstRelation(agencyInvite.agencies)
  const { data: existingAgencyMember } = await serviceClient
    .from('agency_members')
    .select('id, role, status')
    .eq('agency_id', agencyInvite.agency_id)
    .eq('user_id', user.id)
    .maybeSingle()

  let agencyMemberError: { code?: string } | null = null
  if (!existingAgencyMember) {
    const { error } = await serviceClient.from('agency_members').insert({
      agency_id: agencyInvite.agency_id,
      user_id: user.id,
      role: agencyInvite.role,
      status: 'active',
      invited_by: agencyInvite.invited_by ?? null,
      joined_at: acceptedAt,
    })
    agencyMemberError = error
  } else if (existingAgencyMember.role !== 'agency_owner') {
    const role = rank(AGENCY_ROLE_RANK, agencyInvite.role) > rank(AGENCY_ROLE_RANK, existingAgencyMember.role)
      ? agencyInvite.role
      : existingAgencyMember.role
    const { error } = await serviceClient
      .from('agency_members')
      .update({ role, status: 'active', updated_at: acceptedAt })
      .eq('id', existingAgencyMember.id)
    agencyMemberError = error
  }

  if (agencyMemberError) {
    log.error('agency membership write failed after claim', { code: agencyMemberError.code })
    await serviceClient
      .from('agency_invitations')
      .update({ status: 'pending', accepted_by: null, accepted_at: null })
      .eq('id', agencyInvite.id)
    return NextResponse.json({ error: 'Kunde inte lägga till byråmedlem.' }, { status: 500 })
  }

  await serviceClient.from('user_preferences').upsert({
    user_id: user.id,
    active_company_id: agency?.company_id ?? null,
    active_workspace_type: 'agency',
    active_agency_id: agencyInvite.agency_id,
  }, { onConflict: 'user_id' })

  return NextResponse.json({
    data: { type: 'agency', agencyId: agencyInvite.agency_id, companyId: agency?.company_id ?? null },
  })
}
