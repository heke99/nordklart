import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'

/**
 * GET /api/company/members
 * Returns members and pending invitations for the current company.
 */
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const companyId = await requireCompanyId(supabase, user.id)
  const serviceClient = await createServiceClient()

  // Fetch members (source column may not exist if migration not yet applied)
  let members: { id: string; user_id: string; role: string; source?: string; joined_at: string }[] | null = null

  const { data: membersWithSource, error: membersError } = await serviceClient
    .from('company_members')
    .select('id, user_id, role, source, joined_at')
    .eq('company_id', companyId)
    .order('joined_at', { ascending: true })

  if (membersError) {
    // Fallback: query without source column
    const { data: membersFallback, error: fallbackError } = await serviceClient
      .from('company_members')
      .select('id, user_id, role, joined_at')
      .eq('company_id', companyId)
      .order('joined_at', { ascending: true })

    if (fallbackError) {
      return NextResponse.json({ error: 'Kunde inte hämta medlemmar.' }, { status: 500 })
    }
    members = (membersFallback || []).map((m) => ({ ...m, source: 'direct' as const }))
  } else {
    members = membersWithSource
  }

  // Fetch emails from profiles
  const userIds = (members || []).map((m) => m.user_id)
  const { data: profiles } = userIds.length > 0
    ? await serviceClient
        .from('profiles')
        .select('id, email')
        .in('id', userIds)
    : { data: [] }

  const emailMap = new Map((profiles || []).map((p) => [p.id, p.email]))

  // Fetch pending company invitations
  const { data: invitations } = await serviceClient
    .from('company_invitations')
    .select('id, email, role, status, expires_at, created_at')
    .eq('company_id', companyId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })

  // Get current user's role
  const currentMember = members?.find((m) => m.user_id === user.id)
  const canInvite = currentMember?.role === 'owner' || currentMember?.role === 'admin'

  return NextResponse.json({
    data: {
      members: (members || []).map((m) => ({
        id: m.id,
        user_id: m.user_id,
        email: emailMap.get(m.user_id) || '',
        role: m.role,
        source: m.source,
        joined_at: m.joined_at,
        is_current_user: m.user_id === user.id,
      })),
      invitations: invitations || [],
      canInvite,
    },
  })
}
