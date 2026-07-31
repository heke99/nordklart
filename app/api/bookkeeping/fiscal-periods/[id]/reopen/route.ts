import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { requireYearEndAccess, yearEndAccessDeniedResponse } from '@/lib/year-end/access'
import { stripAnnualReportControlCharacters } from '@/lib/bokslut/arsredovisning/format'

const RequestSchema = z.object({
  reason: z.string().trim().min(10).max(2000).transform(stripAnnualReportControlCharacters),
  requested_changes: z
    .array(z.string().trim().min(3).max(300).transform(stripAnnualReportControlCharacters))
    .min(1)
    .max(50),
  annual_report_already_filed: z.boolean(),
  tax_return_already_filed: z.boolean(),
  designated_approver_name: z
    .string()
    .trim()
    .min(2)
    .max(200)
    .transform(stripAnnualReportControlCharacters),
})

export const GET = withRouteContext(
  'period.reopen_requests_get',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    try {
      const access = await requireYearEndAccess(supabase, companyId, user.id, id, {
        operation: 'period.reopen_requests_get',
        requestId,
      })
      if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)
      const { data, error } = await supabase
        .from('fiscal_period_reopen_requests')
        .select(
          'id, reason, requested_changes, annual_report_already_filed, tax_return_already_filed, designated_approver_name, approval_note, requested_by, approved_by, status, closing_entry_id, closing_reversal_entry_id, opening_balance_entry_id, opening_balance_reversal_entry_id, error_code, error_message, requested_at, approved_at, reopened_at, updated_at',
        )
        .eq('company_id', companyId)
        .eq('fiscal_period_id', id)
        .order('requested_at', { ascending: false })
      if (error) throw error
      return NextResponse.json({ data: data ?? [] })
    } catch (error) {
      return errorResponse(error, log, { requestId })
    }
  },
  { allowRequestedCompany: true },
)

export const POST = withRouteContext(
  'period.reopen_requests_post',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, RequestSchema)
    if (!validation.success) return validation.response
    try {
      const access = await requireYearEndAccess(supabase, companyId, user.id, id, {
        operation: 'period.reopen_requests_post',
        requestId,
        requireWrite: true,
      })
      if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)

      const { data, error } = await supabase.rpc('request_fiscal_period_reopen', {
        p_company_id: companyId,
        p_fiscal_period_id: id,
        p_actor_user_id: user.id,
        p_reason: validation.data.reason,
        p_requested_changes: validation.data.requested_changes,
        p_annual_report_already_filed: validation.data.annual_report_already_filed,
        p_tax_return_already_filed: validation.data.tax_return_already_filed,
        p_designated_approver_name: validation.data.designated_approver_name,
      } as never)
      if (error) throw error
      const result = data as unknown as { status?: string } | null
      return NextResponse.json({ data }, { status: result?.status === 'blocked' ? 409 : 201 })
    } catch (error) {
      return errorResponse(error, log, { requestId })
    }
  },
  { allowRequestedCompany: true, requireWrite: true },
)
