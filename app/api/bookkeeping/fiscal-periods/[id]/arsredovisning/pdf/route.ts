import { renderToBuffer } from '@react-pdf/renderer'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { buildArsredovisningData } from '@/lib/bokslut/arsredovisning/build-data'
import { requireYearEndAccess, yearEndAccessDeniedResponse } from '@/lib/year-end/access'
import { ArsredovisningPDF } from '@/lib/bokslut/arsredovisning/arsredovisning-pdf'
import { ArsredovisningK3PDF } from '@/lib/bokslut/arsredovisning/arsredovisning-k3-pdf'
import { runAnnualReportPreflight } from '@/lib/bokslut/arsredovisning/preflight'
import {
  loadCurrentAnnualReportArtifact,
} from '@/lib/bokslut/arsredovisning/version-service'
import { annualReportFileSlug } from '@/lib/bokslut/arsredovisning/format'

export const GET = withRouteContext(
  'period.arsredovisning_pdf',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    try {
      const access = await requireYearEndAccess(supabase, companyId, user.id, id, {
        operation: 'period.arsredovisning_pdf',
        requestId,
      })
      if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)

      const url = new URL(request.url)
      const wantsFinal = url.searchParams.get('final') === 'true'
      if (wantsFinal) {
        const archived = await loadCurrentAnnualReportArtifact(supabase, companyId, id, 'pdf')
        if (!archived) {
          return errorResponseFromCode('VALIDATION_FAILED', log, {
            requestId,
            details: {
              code: 'ANNUAL_REPORT_FINAL_VERSION_NOT_FOUND',
              reason: 'Ingen låst slutversion finns. Använd Färdigställ årsredovisning först.',
            },
          })
        }
        return new Response(archived.bytes, {
          headers: {
            'Content-Type': archived.mime_type,
            'Content-Disposition': `inline; filename="${archived.file_name.replace(/["\r\n]/g, '_')}"`,
            'Cache-Control': 'private, no-store, no-cache, must-revalidate',
            Pragma: 'no-cache',
            ETag: `"${archived.sha256_hash}"`,
            'X-Annual-Report-Version': String(archived.version_number),
          },
        })
      }

      const [data, periodResult, projectResult] = await Promise.all([
        buildArsredovisningData(supabase, companyId, id),
        supabase
          .from('fiscal_periods')
          .select('is_closed, ledger_locked, closing_entry_id')
          .eq('id', id)
          .eq('company_id', companyId)
          .maybeSingle(),
        supabase
          .from('annual_report_projects')
          .select('annual_report_locked')
          .eq('company_id', companyId)
          .eq('fiscal_period_id', id)
          .maybeSingle(),
      ])
      if (!periodResult.data) return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })

      const preflight = runAnnualReportPreflight(data, {
        period_closed: Boolean(periodResult.data.is_closed),
        ledger_locked: Boolean(periodResult.data.ledger_locked),
        closing_entry_id: periodResult.data.closing_entry_id ?? null,
        annual_report_locked: Boolean(projectResult.data?.annual_report_locked),
      })
      const blockers = preflight.issues
        .filter((issue) => issue.severity === 'blocking')
        .map((issue) => issue.message)
      const PdfComponent = data.accounting_framework === 'k3' ? ArsredovisningK3PDF : ArsredovisningPDF
      const pdfBuffer = await renderToBuffer(
        PdfComponent({ data, isDraft: true, draftBlockers: blockers }),
      )
      const year = data.fiscal_period.period_end.slice(0, 4)
      const filename = `arsredovisning-${annualReportFileSlug(data.company.name)}-${year}-utkast.pdf`
      return new Response(new Uint8Array(pdfBuffer), {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="${filename}"`,
          'Cache-Control': 'private, no-store, no-cache, must-revalidate',
          Pragma: 'no-cache',
          'X-Annual-Report-Status': 'draft',
          'X-Annual-Report-Blocking-Issues': String(preflight.blocking_issue_count),
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
