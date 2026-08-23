import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { resolveCompanyAccess } from '@/lib/access/company'

/**
 * GET /api/company/access-requests
 *
 * Pending access requests for the active company.
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
export const GET = withRouteContext('company.access_requests.list', async (_request, { supabase, companyId }) => {
  const access = await resolveCompanyAccess(supabase, companyId)
  if (!access?.canManageCompany) return NextResponse.json({ error: 'Behörighet saknas.' }, { status: 403 })

  const service = createServiceClient()
  const { data, error } = await service
    .from('company_access_requests')
    .select('id, requester_user_id, requester_email, requested_role, status, message, created_at, reviewed_at')
    .eq('company_id', companyId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })

  if (error) return NextResponse.json({ error: 'Kunde inte hämta åtkomstförfrågningar.' }, { status: 500 })
  return NextResponse.json({ data: data ?? [] })
})
