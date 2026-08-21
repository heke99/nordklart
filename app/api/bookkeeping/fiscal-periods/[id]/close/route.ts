import { withRouteContext } from '@/lib/api/with-route-context'
import { NextResponse } from 'next/server'
import { closePeriod } from '@/lib/core/bookkeeping/period-service'
import { requireWritePermission } from '@/lib/auth/require-write'

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.fiscal_periods.close',
  async (_request, ctx, { params }) => {
    const { supabase, companyId, user } = ctx
    const { id } = await params


    const writeCheck = await requireWritePermission(supabase, user.id)
    if (!writeCheck.ok) return writeCheck.response


    try {
      const period = await closePeriod(supabase, companyId, user.id, id)
      return NextResponse.json({ data: period })
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Failed to close period' },
        { status: 400 }
      )
    }
  },
)
