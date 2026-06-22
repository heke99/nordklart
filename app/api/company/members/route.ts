import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'
import { resolveCompanyAccess } from '@/lib/access/company'

/**
 * GET /api/company/members
 * Returns active/limited members, pending invitations and pending access requests for the current company.
 */
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const companyId = await requireCompanyId(supabase, user.id)
  const access = await resolveCompanyAccess(supabase, companyId)
  if (!access?.canRead) return NextResponse.json({ error: 'Behörighet saknas.' }, { status: 403 })

  const serviceClient = createServiceClient()
  const canManage = access.canManageCompany

  const { data: members, error: membersError } = await serviceClient
    .from('company_members')
    .select('id, user_id, role, source, status, access_source, membership_kind, joined_at, approved_at')
    .eq('company_id', companyId)
    .in('status', ['active', 'active_limited'])
    .order('joined_at', { ascending: true })

  if (membersError) {
    return NextResponse.json({ error: 'Kunde inte hämta medlemmar.' }, { status: 500 })
  }

  const userIds = (members || []).map((m) => m.user_id)
  const { data: profiles } = userIds.length > 0
    ? await serviceClient
        .from('profiles')
        .select('id, email')
        .in('id', userIds)
    : { data: [] }

  const emailMap = new Map((profiles || []).map((p) => [p.id, p.email]))

  const { data: invitations } = canManage
    ? await serviceClient
        .from('company_invitations')
        .select('id, email, role, status, membership_kind, expires_at, created_at')
        .eq('company_id', companyId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
    : { data: [] }

  const { data: accessRequests } = canManage
    ? await serviceClient
        .from('company_access_requests')
        .select('id, requester_user_id, requester_email, requested_role, status, message, created_at')
        .eq('company_id', companyId)
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
    : { data: [] }

  return NextResponse.json({
    data: {
      members: (members || []).map((m) => ({
        id: m.id,
        user_id: m.user_id,
        email: emailMap.get(m.user_id) || '',
        role: m.role,
        source: m.source,
        status: m.status,
        access_source: m.access_source,
        membership_kind: m.membership_kind,
        joined_at: m.joined_at,
        approved_at: m.approved_at,
        is_current_user: m.user_id === user.id,
      })),
      invitations: invitations || [],
      accessRequests: accessRequests || [],
      canInvite: canManage,
      canManage,
    },
  })
}
