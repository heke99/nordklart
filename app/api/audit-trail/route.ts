import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { getAuditLog } from '@/lib/core/audit/audit-service'
import type { AuditAction } from '@/types'
import { requireCompanyId } from '@/lib/company/context'

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

  const { searchParams } = new URL(request.url)

  const filters = {
    action: (searchParams.get('action') as AuditAction) || undefined,
    table_name: searchParams.get('table_name') || undefined,
    record_id: searchParams.get('record_id') || undefined,
    from_date: searchParams.get('from_date') || undefined,
    to_date: searchParams.get('to_date') || undefined,
    page: searchParams.has('page') ? Number(searchParams.get('page')) : undefined,
    pageSize: searchParams.has('page_size') ? Number(searchParams.get('page_size')) : undefined,
  }

  try {
    const result = await getAuditLog(supabase, companyId, filters)
    return NextResponse.json({ data: result.data, count: result.count })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to fetch audit log' },
      { status: 500 }
    )
  }
}
