import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

/** GET /api/import/sie — list SIE imports visible to the active access scope. */
export const GET = withRouteContext(
  'sie_import.list',
  async (request, ctx) => {
    const { supabase, companyId, sieImportAccess, log, requestId } = ctx
    const { searchParams } = new URL(request.url)
    const limit = Math.min(Math.max(Number.parseInt(searchParams.get('limit') || '20', 10) || 20, 1), 100)
    const offset = Math.max(Number.parseInt(searchParams.get('offset') || '0', 10) || 0, 0)
    const status = searchParams.get('status')

    if (sieImportAccess?.allowedPeriodIds && sieImportAccess.allowedPeriodIds.length === 0) {
      return NextResponse.json({ data: [], count: 0, limit, offset })
    }

    let query = supabase
      .from('sie_imports')
      .select('*', { count: 'exact' })
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (status) query = query.eq('status', status)
    if (sieImportAccess?.allowedPeriodIds !== null && sieImportAccess?.allowedPeriodIds) {
      query = query.in('fiscal_period_id', sieImportAccess.allowedPeriodIds)
    }

    const { data, error, count } = await query
    if (error) {
      return errorResponseFromCode('DATABASE_QUERY_FAILED', log, {
        requestId,
        reason: error.message,
        details: { operation: 'list_sie_imports' },
      })
    }

    return NextResponse.json({ data: data ?? [], count: count ?? 0, limit, offset })
  },
  { accessPolicy: 'sie_import' },
)
