import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import {
  proposeAnnualPostings,
  commitAnnualPostings,
} from '@/lib/bokslut/assets/depreciation-engine'
import { requireYearEndAccess, yearEndAccessDeniedResponse } from '@/lib/year-end/access'
import { createServiceClient } from '@/lib/supabase/server'

const CommitSchema = z.object({
  /** Optional whitelist — when supplied, only assets in this list are posted.
   *  Empty / omitted = post all proposed depreciations. */
  asset_ids: z.array(z.string().uuid()).optional(),
})

export const GET = withRouteContext(
  'period.depreciation_preview',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    try {
      const access = await requireYearEndAccess(
        createServiceClient(),
        companyId,
        user.id,
        id,
        {
          operation: 'period.depreciation_preview',
          requestId,
        },
      )
      if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)

      const proposal = await proposeAnnualPostings(supabase, companyId, id)
      return NextResponse.json({ data: proposal })
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      if (/not found/i.test(message)) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      }
      return errorResponse(err, log, { requestId })
    }
  },
  { allowRequestedCompany: true },
)

export const POST = withRouteContext(
  'period.depreciation_commit',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, CommitSchema)
    if (!validation.success) return validation.response

    try {
      const access = await requireYearEndAccess(
        createServiceClient(),
        companyId,
        user.id,
        id,
        {
          operation: 'period.depreciation_commit',
          requestId,
          requireWrite: true,
        },
      )
      if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)

      const { data: period, error: periodError } = await supabase
        .from('fiscal_periods')
        .select('is_closed, locked_at, closing_entry_id')
        .eq('id', id)
        .eq('company_id', companyId)
        .single()
      if (periodError || !period) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      }
      if (period.is_closed || period.closing_entry_id || period.locked_at) {
        return errorResponseFromCode('PERIOD_LOCKED', log, { requestId })
      }

      const result = await commitAnnualPostings(supabase, companyId, user.id, id, {
        assetIds: validation.data.asset_ids,
      })
      return NextResponse.json({ data: result })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { allowRequestedCompany: true },
)
