import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'
import { resolveCompanyAccess } from '@/lib/access/company'

/**
 * DELETE /api/company/members/invite/[id]
 * Revoke a pending company invitation.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const companyId = await requireCompanyId(supabase, user.id)
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
}
