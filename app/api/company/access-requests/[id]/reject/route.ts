import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { resolveCompanyAccess } from '@/lib/access/company'

/**
 * POST /api/company/access-requests/[id]/reject
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
  'company.access_requests.reject',
  async (_request, { supabase, user, companyId }, { params }) => {
  const access = await resolveCompanyAccess(supabase, companyId)
  if (!access?.canManageCompany) return NextResponse.json({ error: 'Behörighet saknas.' }, { status: 403 })

  const { id } = await params
  const service = createServiceClient()
  const { data: accessRequest, error: readError } = await service
    .from('company_access_requests')
    .select('id, company_id, requester_user_id, status')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (readError || !accessRequest) return NextResponse.json({ error: 'Förfrågan hittades inte.' }, { status: 404 })
  if (accessRequest.status !== 'pending') return NextResponse.json({ error: 'Förfrågan är inte väntande.' }, { status: 400 })

  const { error } = await service
    .from('company_access_requests')
    .update({ status: 'rejected', reviewed_by: user.id, reviewed_at: new Date().toISOString() })
    .eq('id', accessRequest.id)

  if (error) return NextResponse.json({ error: 'Kunde inte neka förfrågan.' }, { status: 500 })

  await service.from('auth_audit_events').insert({
    user_id: user.id,
    email: user.email ?? null,
    event_type: 'company_access_request_rejected',
    status: 'success',
    metadata: { company_id: companyId, access_request_id: accessRequest.id, rejected_user_id: accessRequest.requester_user_id },
  }).then(() => undefined, () => undefined)

  return NextResponse.json({ data: { id: accessRequest.id, rejected: true } })
},
)
