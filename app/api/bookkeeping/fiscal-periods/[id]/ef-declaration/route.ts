import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { generateNEDeclaration } from '@/lib/reports/ne-bilaga/ne-engine'
import { requireYearEndAccess, yearEndAccessDeniedResponse } from '@/lib/year-end/access'
import { upsertTaxDeclarationProject } from '@/lib/tax-declaration/adjustments'

/**
 * GET /api/bookkeeping/fiscal-periods/:id/ef-declaration
 *
 * Backing route for EfDeclarationSection. Returns a production-safe NE preview:
 * R1–R11 from bookkeeping plus blockers until the EF questionnaire/R12–R48
 * data is complete. This prevents a half-finished NE from being presented as
 * a finished declaration while keeping the SIE→preview workflow usable.
 */
export const GET = withRouteContext(
  'tax_declaration.ef_preview',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ periodId: id })

    try {
      const access = await requireYearEndAccess(supabase, companyId, user.id, id, {
        operation: 'tax_declaration.ef_preview',
        requestId,
      })
      if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)

      const declaration = await generateNEDeclaration(supabase, companyId, id)
      const readiness = declaration.taxAnalysis
      if (readiness) {
        await upsertTaxDeclarationProject(
          supabase,
          companyId,
          id,
          'NE',
          user.id,
          readiness.status,
          readiness.readinessScore,
          readiness.issues.filter((item) => item.severity === 'blocker'),
          readiness.issues.filter((item) => item.severity === 'warning'),
        )
      }
      return NextResponse.json({ data: declaration })
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      if (/not found/i.test(message)) return errorResponseFromCode('PERIOD_NOT_FOUND', opLog, { requestId })
      return errorResponse(err, opLog, { requestId })
    }
  },
  { allowRequestedCompany: true },
)
