import { createServiceClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { NextResponse, type NextRequest } from 'next/server'
import { hashInviteToken } from '@/lib/auth/invite-tokens'
import { createLogger } from '@/lib/logger'
import { acceptInvitation } from '@/lib/invitations/accept'
import { checkDurableRateLimit } from '@/lib/auth/rate-limit-durable'
import { clientIpKey } from '@/lib/api/client-ip'

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

  // Unauthenticated lookup: bound it so tokens cannot be probed at volume.
  const limit = await checkDurableRateLimit({
    prefix: 'invite:lookup',
    identifier: clientIpKey(request),
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
 * Accepts company invites and agency staff invites for the signed-in user.
 * Everything after authentication happens in the accept_invitation RPC, in
 * one transaction.
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
  const token = typeof body?.token === 'string' ? body.token.trim() : ''
  if (!token) {
    return NextResponse.json({ error: 'Token saknas.' }, { status: 400 })
  }

  const result = await acceptInvitation(createServiceClient(), token, user.id)
  if (!result.ok) {
    if (result.error === 'unavailable') log.error('accept_invitation failed', { userId: user.id })
    return NextResponse.json({ error: result.message, code: result.error }, { status: result.status })
  }

  if (result.type === 'agency') {
    return NextResponse.json({
      data: { type: 'agency', agencyId: result.agencyId, companyId: result.companyId },
    })
  }
  return NextResponse.json({ data: { type: 'company', companyId: result.companyId } })
}
