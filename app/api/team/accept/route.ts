import { createServiceClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { NextResponse, type NextRequest } from 'next/server'
import { hashInviteToken } from '@/lib/auth/invite-tokens'
import { createLogger } from '@/lib/logger'

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

  const body = await request.json()
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

    const { error: memberError } = await serviceClient
      .from('company_members')
      .upsert({
        company_id: companyInvite.company_id,
        user_id: user.id,
        role: companyInvite.role ?? 'viewer',
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

    await serviceClient.from('user_preferences').upsert({
      user_id: user.id,
      active_company_id: companyInvite.company_id,
      active_workspace_type: 'company',
      active_agency_id: null,
    }, { onConflict: 'user_id' })

    await serviceClient
      .from('company_invitations')
      .update({ status: 'accepted', accepted_by: user.id, accepted_at: new Date().toISOString() })
      .eq('id', companyInvite.id)

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

  const agency = firstRelation(agencyInvite.agencies)
  const { error: agencyMemberError } = await serviceClient
    .from('agency_members')
    .upsert({
      agency_id: agencyInvite.agency_id,
      user_id: user.id,
      role: agencyInvite.role,
      status: 'active',
      invited_by: agencyInvite.invited_by ?? null,
      joined_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'agency_id,user_id' })

  if (agencyMemberError) {
    if (agencyMemberError.code === '23505') {
      return NextResponse.json({ error: 'Du är redan medlem i byrån.' }, { status: 409 })
    }
    return NextResponse.json({ error: 'Kunde inte lägga till byråmedlem.' }, { status: 500 })
  }

  await serviceClient.from('user_preferences').upsert({
    user_id: user.id,
    active_company_id: agency?.company_id ?? null,
    active_workspace_type: 'agency',
    active_agency_id: agencyInvite.agency_id,
  }, { onConflict: 'user_id' })

  await serviceClient
    .from('agency_invitations')
    .update({ status: 'accepted', accepted_by: user.id, accepted_at: new Date().toISOString() })
    .eq('id', agencyInvite.id)

  return NextResponse.json({
    data: { type: 'agency', agencyId: agencyInvite.agency_id, companyId: agency?.company_id ?? null },
  })
}
