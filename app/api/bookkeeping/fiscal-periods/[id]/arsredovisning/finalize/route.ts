import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { requireYearEndAccess, yearEndAccessDeniedResponse } from '@/lib/year-end/access'
import {
  AnnualReportFinalizationError,
  finalizeAnnualReport,
} from '@/lib/bokslut/arsredovisning/version-service'

export const POST = withRouteContext(
  'period.arsredovisning_finalize',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    try {
      const access = await requireYearEndAccess(supabase, companyId, user.id, id, {
        allowIxbrlFeature: true,
        operation: 'period.arsredovisning_finalize',
        requestId,
        requireWrite: true,
      })
      if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)

      const result = await finalizeAnnualReport(supabase, user.id, companyId, id)
      return NextResponse.json({ data: result }, { status: 201 })
    } catch (error) {
      if (error instanceof AnnualReportFinalizationError) {
        return errorResponseFromCode('VALIDATION_FAILED', log, {
          requestId,
          details: {
            reason: error.message,
            preflight: error.report,
            ...error.details,
          },
        })
      }
      return errorResponse(error, log, { requestId })
    }
  },
  { allowRequestedCompany: true },
)
