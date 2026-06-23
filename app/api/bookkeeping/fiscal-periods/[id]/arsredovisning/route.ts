import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { buildArsredovisningData } from '@/lib/bokslut/arsredovisning/build-data'
import { requireYearEndAccess, yearEndAccessDeniedResponse } from '@/lib/year-end/access'

export const GET = withRouteContext(
  'period.arsredovisning_data',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    try {
      const access = await requireYearEndAccess(supabase, companyId, user.id, id, {
        operation: 'period.arsredovisning_data',
        requestId,
      })
      if (!access.allowed) return yearEndAccessDeniedResponse()

      const data = await buildArsredovisningData(supabase, companyId, id)
      return NextResponse.json({ data })
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      if (/not found/i.test(message)) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      }
      return errorResponse(err, log, { requestId })
    }
  },
)
