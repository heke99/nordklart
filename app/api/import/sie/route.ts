import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'

/**
 * GET /api/import/sie
 * List all SIE imports for the user
 */
export async function GET(request: Request) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

  // Parse query params
  const { searchParams } = new URL(request.url)
  const limit = parseInt(searchParams.get('limit') || '20', 10)
  const offset = parseInt(searchParams.get('offset') || '0', 10)
  const status = searchParams.get('status')

  let query = supabase
    .from('sie_imports')
    .select('*', { count: 'exact' })
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (status) {
    query = query.eq('status', status)
  }

  const { data, error, count } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    data,
    count,
    limit,
    offset,
  })
}
