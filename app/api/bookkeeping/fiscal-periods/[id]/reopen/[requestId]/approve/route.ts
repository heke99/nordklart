import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { requireYearEndAccess, yearEndAccessDeniedResponse } from '@/lib/year-end/access'
import { stripAnnualReportControlCharacters } from '@/lib/bokslut/arsredovisning/format'

const ApprovalSchema = z.object({
  approval_note: z
    .string()
    .trim()
    .min(5)
    .max(2000)
    .transform(stripAnnualReportControlCharacters),
})

export const POST = withRouteContext(
  'period.reopen_request_approve',
  async (
    request,
    ctx,
    { params }: { params: Promise<{ id: string; requestId: string }> },
  ) => {
    const { id, requestId: reopenRequestId } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, ApprovalSchema)
    if (!validation.success) return validation.response
    try {
      const access = await requireYearEndAccess(supabase, companyId, user.id, id, {
        operation: 'period.reopen_request_approve',
        requestId,
        requireWrite: true,
      })
      if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)
      const { data: reopenRequest } = await supabase
        .from('fiscal_period_reopen_requests')
        .select('id, company_id, fiscal_period_id, status')
        .eq('id', reopenRequestId)
        .eq('company_id', companyId)
        .eq('fiscal_period_id', id)
        .maybeSingle()
      if (!reopenRequest) return errorResponseFromCode('NOT_FOUND', log, { requestId })
      if (reopenRequest.status !== 'requested') {
        return errorResponseFromCode('VALIDATION_FAILED', log, {
          requestId,
          details: { code: 'YEAR_END_REOPEN_REQUEST_NOT_PENDING' },
        })
      }
      const { data, error } = await supabase.rpc('approve_fiscal_period_reopen', {
        p_request_id: reopenRequestId,
        p_actor_user_id: user.id,
        p_approval_note: validation.data.approval_note,
      })
      if (error) throw error
      const result = data as {
        status?: string
        error_code?: string
        error_message?: string
      } | null
      if (result?.status === 'blocked' || result?.status === 'failed') {
        return NextResponse.json({ data: result }, { status: 409 })
      }
      return NextResponse.json({ data: result })
    } catch (error) {
      return errorResponse(error, log, { requestId })
    }
  },
  { allowRequestedCompany: true, requireWrite: true },
)
