import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { resolveCompanyAccess } from '@/lib/access/company'
import { assertCommercialLimit, COMMERCIAL_LIMITS } from '@/lib/platform/entitlement-limits'

const allowedRoles = new Set(['admin', 'member', 'viewer', 'accountant', 'auditor'])

/**
 * POST /api/company/access-requests/[id]/approve
 *
 * The wrapper resolves companyId through the same validated path this route
 * used by hand, and adds requireAuth's AAL2 check. The canManageCompany check
 * below stays and is what authorizes the action.
 *
 * requireWrite is deliberately NOT set. It delegates to requireWritePermission,
 * which authorizes on DIRECT membership in the active company, whereas
 * canManageCompany also admits platform-admin access. Turning it on would
 * therefore narrow who can approve a request, not harden the route — and the
 * membership case it covers is already subsumed by canManageCompany. The
 * consequence to be explicit about: these routes are not covered by the
 * read-only maintenance kill switch, which the wrapper only applies under
 * requireWrite. That matches the behaviour they had before this conversion.
 *
 * The service client and its company_id scoping are untouched.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'company.access_requests.approve',
  async (request, { supabase, user, companyId }, { params }) => {
  const access = await resolveCompanyAccess(supabase, companyId)
  if (!access?.canManageCompany) return NextResponse.json({ error: 'Behörighet saknas.' }, { status: 403 })

  const { id } = await params
  const body = await request.json().catch(() => ({})) as { role?: string }
  const role = allowedRoles.has(body.role || '') ? body.role! : 'member'
  const membershipKind = ['viewer', 'auditor', 'accountant'].includes(role) ? 'external' : 'internal'
  const capacity = await assertCommercialLimit(
    supabase,
    companyId,
    membershipKind === 'external' ? COMMERCIAL_LIMITS.externalAdvisors : COMMERCIAL_LIMITS.companyUsers,
    membershipKind === 'external'
      ? 'Din plan tillåter inte fler externa rådgivare eller revisorer.'
      : 'Din plan tillåter inte fler användare.',
  )
  if (!capacity.ok) return capacity.response

  const service = createServiceClient()

  const { data: accessRequest, error: readError } = await service
    .from('company_access_requests')
    .select('id, company_id, requester_user_id, requester_email, status')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (readError || !accessRequest) return NextResponse.json({ error: 'Förfrågan hittades inte.' }, { status: 404 })
  if (accessRequest.status !== 'pending') return NextResponse.json({ error: 'Förfrågan är inte väntande.' }, { status: 400 })

  const now = new Date().toISOString()
  const { error: memberError } = await service
    .from('company_members')
    .upsert({
      company_id: companyId,
      user_id: accessRequest.requester_user_id,
      role,
      source: 'direct',
      status: 'active',
      access_source: 'access_request',
      membership_kind: membershipKind,
      approved_by: user.id,
      approved_at: now,
      revoked_by: null,
      revoked_at: null,
    }, { onConflict: 'company_id,user_id' })

  if (memberError) return NextResponse.json({ error: 'Kunde inte godkänna användaren.' }, { status: 500 })

  await service.from('user_preferences').upsert({
    user_id: accessRequest.requester_user_id,
    active_company_id: companyId,
    active_workspace_type: 'company',
    active_agency_id: null,
    updated_at: now,
  }, { onConflict: 'user_id' }).then(() => undefined, () => undefined)

  const { error: updateError } = await service
    .from('company_access_requests')
    .update({ status: 'approved', requested_role: role, reviewed_by: user.id, reviewed_at: now })
    .eq('id', accessRequest.id)

  if (updateError) return NextResponse.json({ error: 'Användaren fick åtkomst, men förfrågan kunde inte markeras som godkänd.' }, { status: 500 })

  await service.from('auth_audit_events').insert({
    user_id: user.id,
    email: user.email ?? null,
    event_type: 'company_access_request_approved',
    status: 'success',
    metadata: {
      company_id: companyId,
      access_request_id: accessRequest.id,
      approved_user_id: accessRequest.requester_user_id,
      role,
      membership_kind: membershipKind,
    },
  }).then(() => undefined, () => undefined)

  return NextResponse.json({ data: { id: accessRequest.id, approved: true, role } })
},
)
