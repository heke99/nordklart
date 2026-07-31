import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { buildArsredovisningData } from '@/lib/bokslut/arsredovisning/build-data'
import { runAnnualReportPreflight } from '@/lib/bokslut/arsredovisning/preflight'
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
      if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)

      const [data, periodResult, projectResult, versionsResult, reclassificationsResult] = await Promise.all([
        buildArsredovisningData(supabase, companyId, id),
        supabase
          .from('fiscal_periods')
          .select('is_closed, ledger_locked, closing_entry_id')
          .eq('id', id)
          .eq('company_id', companyId)
          .maybeSingle(),
        supabase
          .from('annual_report_projects')
          .select('id, status, annual_report_locked, preflight_status, blocking_issue_count, current_version_id, submission_blocked, invalidated_reason, invalidated_at, updated_at')
          .eq('company_id', companyId)
          .eq('fiscal_period_id', id)
          .maybeSingle(),
        supabase
          .from('annual_report_versions')
          .select('id, version_number, status, finalized_at, superseded_at, combined_sha256')
          .eq('company_id', companyId)
          .eq('fiscal_period_id', id)
          .order('version_number', { ascending: false }),
        supabase
          .from('annual_report_presentation_reclassifications')
          .select('id, account_number, original_presentation, target_presentation, amount, reason, created_at')
          .eq('company_id', companyId)
          .eq('fiscal_period_id', id)
          .is('revoked_at', null)
          .order('created_at', { ascending: true }),
      ])
      if (!periodResult.data) return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      if (projectResult.error) throw projectResult.error
      if (versionsResult.error) throw versionsResult.error
      if (reclassificationsResult.error) throw reclassificationsResult.error

      const preflight = runAnnualReportPreflight(data, {
        period_closed: Boolean(periodResult.data.is_closed),
        ledger_locked: Boolean(periodResult.data.ledger_locked),
        closing_entry_id: periodResult.data.closing_entry_id ?? null,
        annual_report_locked: Boolean(projectResult.data?.annual_report_locked),
      })
      return NextResponse.json({
        data,
        lifecycle: {
          ledger_locked: Boolean(periodResult.data.ledger_locked),
          annual_report_locked: Boolean(projectResult.data?.annual_report_locked),
          status: projectResult.data?.status ?? 'draft',
          project: projectResult.data,
          versions: versionsResult.data ?? [],
          presentation_reclassifications: reclassificationsResult.data ?? [],
          preflight,
          draft_pdf_url: `/api/bookkeeping/fiscal-periods/${id}/arsredovisning/pdf`,
          final_pdf_url:
            projectResult.data?.current_version_id
            && ['final', 'signed', 'filed', 'registered'].includes(projectResult.data.status)
              ? `/api/bookkeeping/fiscal-periods/${id}/arsredovisning/pdf?final=true`
              : null,
          draft_ixbrl_url: `/api/bookkeeping/fiscal-periods/${id}/arsredovisning/ixbrl`,
          final_ixbrl_url:
            projectResult.data?.current_version_id
            && ['final', 'signed', 'filed', 'registered'].includes(projectResult.data.status)
              ? `/api/bookkeeping/fiscal-periods/${id}/arsredovisning/ixbrl?final=true`
              : null,
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (/not found/i.test(message)) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      }
      return errorResponse(error, log, { requestId })
    }
  },
  { allowRequestedCompany: true },
)
