import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'
import { resolveCompanyAccess } from '@/lib/access/company'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const companyId = await requireCompanyId(supabase, user.id)
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
}
