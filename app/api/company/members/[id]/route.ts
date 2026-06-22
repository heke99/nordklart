import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'
import { resolveCompanyAccess } from '@/lib/access/company'

/**
 * DELETE /api/company/members/[id]
 * Revokes a member from the current company without deleting audit-relevant rows.
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
}
