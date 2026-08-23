import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { resolveCompanyAccess } from '@/lib/access/company'

/**
 * DELETE /api/company/members/[id]
 * Revokes a member from the current company without deleting audit-relevant rows.
 *
 * The wrapper resolves companyId through the same validated path this route
 * used by hand, and adds requireAuth's AAL2 check. canManageCompany below is
 * what authorizes the action; requireWrite is deliberately not set for the
 * same reason as the access-request routes — it authorizes on direct
 * membership and would exclude the platform-admin path canManageCompany
 * admits. The service client and its company_id scoping are untouched.
 */
export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'company.members.remove',
  async (_request, { supabase, user, companyId }, { params }) => {
  const access = await resolveCompanyAccess(supabase, companyId)
  if (!access?.canManageCompany) {
    return NextResponse.json({ error: 'Behörighet saknas.' }, { status: 403 })
  }

  const { id: memberId } = await params
  const serviceClient = createServiceClient()

  const { data: member } = await serviceClient
    .from('company_members')
    .select('id, user_id, role, source, status')
    .eq('id', memberId)
    .eq('company_id', companyId)
    .single()

  if (!member) {
    return NextResponse.json({ error: 'Medlem hittades inte.' }, { status: 404 })
  }

  if (member.user_id === user.id) {
    return NextResponse.json({ error: 'Du kan inte ta bort dig själv.' }, { status: 400 })
  }

  if (member.role === 'owner') {
    return NextResponse.json({ error: 'Ägaren kan inte tas bort.' }, { status: 400 })
  }

  if (member.source === 'team') {
    return NextResponse.json({
      error: 'Denna medlem läggs till via teamet. Ta bort från teamet istället.',
    }, { status: 400 })
  }

  const { error } = await serviceClient
    .from('company_members')
    .update({ status: 'revoked', revoked_by: user.id, revoked_at: new Date().toISOString() })
    .eq('id', memberId)
    .eq('company_id', companyId)

  if (error) {
    return NextResponse.json({ error: 'Kunde inte ta bort medlem.' }, { status: 500 })
  }

  return NextResponse.json({ data: { removed: memberId } })
},
)
