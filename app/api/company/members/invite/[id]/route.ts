import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { resolveCompanyAccess } from '@/lib/access/company'

/**
 * DELETE /api/company/members/invite/[id]
 * Revoke a pending company invitation.
 *
 * The wrapper resolves companyId through the same validated path this route
 * used by hand, and adds requireAuth's AAL2 check. canManageCompany below is
 * what authorizes the action; requireWrite is deliberately not set for the
 * same reason as the access-request routes — it authorizes on direct
 * membership and would exclude the platform-admin path canManageCompany
 * admits. The service client and its company_id scoping are untouched.
 */
export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'company.members.invite_revoke',
  async (_request, { supabase, user, companyId }, { params }) => {
  const access = await resolveCompanyAccess(supabase, companyId)
  if (!access?.canManageCompany) {
    return NextResponse.json({ error: 'Behörighet saknas.' }, { status: 403 })
  }

  const { id: inviteId } = await params
  const serviceClient = createServiceClient()

  const { data: invitation } = await serviceClient
    .from('company_invitations')
    .select('id, company_id, status')
    .eq('id', inviteId)
    .eq('company_id', companyId)
    .single()

  if (!invitation) {
    return NextResponse.json({ error: 'Inbjudan hittades inte.' }, { status: 404 })
  }

  if (invitation.status !== 'pending') {
    return NextResponse.json({ error: 'Inbjudan är inte väntande.' }, { status: 400 })
  }

  const { error } = await serviceClient
    .from('company_invitations')
    .update({ status: 'revoked', revoked_by: user.id, revoked_at: new Date().toISOString() })
    .eq('id', inviteId)
    .eq('company_id', companyId)

  if (error) {
    return NextResponse.json({ error: 'Kunde inte återkalla inbjudan.' }, { status: 500 })
  }

  return NextResponse.json({ data: { revoked: inviteId } })
},
)
