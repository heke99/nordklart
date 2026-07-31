import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { requireYearEndAccess, yearEndAccessDeniedResponse } from '@/lib/year-end/access'

const CreateDraftSchema = z.object({
  reason: z.string().trim().min(10).max(1000),
})

export const GET = withRouteContext(
  'period.arsredovisning_versions_get',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    try {
      const access = await requireYearEndAccess(supabase, companyId, user.id, id, {
        operation: 'period.arsredovisning_versions_get',
        requestId,
      })
      if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)
      const { data, error } = await supabase
        .from('annual_report_versions')
        .select('id, version_number, status, finalized_at, signed_at, filed_at, registered_at, superseded_at, combined_sha256, pdf_document_id, ixbrl_document_id, validation_report')
        .eq('company_id', companyId)
        .eq('fiscal_period_id', id)
        .order('version_number', { ascending: false })
      if (error) throw error
      return NextResponse.json({ data: data ?? [] })
    } catch (error) {
      return errorResponse(error, log, { requestId })
    }
  },
  { allowRequestedCompany: true },
)

export const POST = withRouteContext(
  'period.arsredovisning_versions_post',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, CreateDraftSchema)
    if (!validation.success) return validation.response
    try {
      const access = await requireYearEndAccess(supabase, companyId, user.id, id, {
        operation: 'period.arsredovisning_versions_post',
        requestId,
        requireWrite: true,
      })
      if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)
      const { data, error } = await supabase.rpc('create_new_annual_report_draft', {
        p_company_id: companyId,
        p_fiscal_period_id: id,
        p_actor_user_id: user.id,
        p_reason: validation.data.reason,
      } as never)
      if (error) {
        if (/FILED_CORRECTION_FLOW_REQUIRED/i.test(error.message)) {
          return errorResponseFromCode('VALIDATION_FAILED', log, {
            requestId,
            details: {
              code: 'ANNUAL_REPORT_FILED_CORRECTION_FLOW_REQUIRED',
              reason: 'Registrerad årsredovisning kräver ett särskilt rättelseflöde.',
            },
          })
        }
        throw error
      }
      return NextResponse.json({ data }, { status: 201 })
    } catch (error) {
      return errorResponse(error, log, { requestId })
    }
  },
  { allowRequestedCompany: true },
)
