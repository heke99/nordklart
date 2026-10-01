import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateJournalEntryLineSchema } from '@/lib/api/schemas'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { bookkeepingErrorResponse } from '@/lib/bookkeeping/errors'
import { requireYearEndAccess, yearEndAccessDeniedResponse } from '@/lib/year-end/access'
import {
  bookPriorPeriodCorrection,
  PriorPeriodCorrectionError,
  PRIOR_CORRECTION_ISSUE_TEXT,
} from '@/lib/core/bookkeeping/prior-period-correction'

const RequestSchema = z.object({
  method: z.enum(['current_year', 'equity_restatement']),
  fiscal_period_id: z.string().uuid(),
  entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().trim().min(3).max(200),
  reason: z.string().trim().min(20).max(1500),
  original_reference: z.string().trim().max(200).optional(),
  lines: z.array(CreateJournalEntryLineSchema).min(2).max(200),
})

/**
 * GET  — corrections booked for errors in this (closed) fiscal year.
 * POST — book a correction of an error in this closed year as a new
 *        verifikation in a later open year (see prior-period-correction.ts).
 */
export const GET = withRouteContext(
  'period.prior_period_correction_get',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    try {
      const access = await requireYearEndAccess(supabase, companyId, user.id, id, {
        operation: 'period.prior_period_correction_get',
        requestId,
      })
      if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)
      const { data, error } = await supabase
        .from('journal_entries')
        .select('id, voucher_series, voucher_number, entry_date, description, notes, status, fiscal_period_id, created_at')
        .eq('company_id', companyId)
        .eq('source_type', 'prior_period_correction')
        .eq('source_id', id)
        .order('entry_date', { ascending: true })
      if (error) throw error
      return NextResponse.json({ data: data ?? [] })
    } catch (error) {
      return errorResponse(error, log, { requestId })
    }
  },
)

export const POST = withRouteContext(
  'period.prior_period_correction_post',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, RequestSchema)
    if (!validation.success) return validation.response
    try {
      const access = await requireYearEndAccess(supabase, companyId, user.id, id, {
        operation: 'period.prior_period_correction_post',
        requestId,
        requireWrite: true,
      })
      if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)
      const entry = await bookPriorPeriodCorrection(supabase, companyId, user.id, id, validation.data)
      return NextResponse.json({ data: entry }, { status: 201 })
    } catch (error) {
      if (error instanceof PriorPeriodCorrectionError) {
        if (error.code === 'NOT_FOUND') return errorResponseFromCode('NOT_FOUND', log, { requestId })
        return errorResponseFromCode(error.code, log, {
          requestId,
          details: error.issues.length
            ? { issues: error.issues.map((issue) => ({ code: issue, message: PRIOR_CORRECTION_ISSUE_TEXT[issue] })) }
            : undefined,
        })
      }
      const typed = bookkeepingErrorResponse(error)
      if (typed) return typed
      return errorResponse(error, log, { requestId })
    }
  },
  { requireWrite: true },
)
