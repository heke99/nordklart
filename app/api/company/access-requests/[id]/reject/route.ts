import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'
import { resolveCompanyAccess } from '@/lib/access/company'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const companyId = await requireCompanyId(supabase, user.id)
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
}
