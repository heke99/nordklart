import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { buildIxbrlInput } from '@/lib/bokslut/ixbrl/build-input'
import { generateK2IxbrlDocument } from '@/lib/bokslut/ixbrl/document/k2-document'
import { runPreflightChecks } from '@/lib/bokslut/ixbrl/validate/rules'
import { requireYearEndAccess, yearEndAccessDeniedResponse } from '@/lib/year-end/access'
import { loadCurrentAnnualReportArtifact } from '@/lib/bokslut/arsredovisning/version-service'
import { annualReportFileSlug } from '@/lib/bokslut/arsredovisning/format'

/**
 * Live generation is always a marked draft. `?final=true` serves the exact
 * archived XHTML that belongs to the locked annual-report version; no query
 * parameter can turn a live render into a final document.
 */
export const GET = withRouteContext(
  'period.arsredovisning_ixbrl',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    try {
      const access = await requireYearEndAccess(supabase, companyId, user.id, id, {
        allowIxbrlFeature: true,
        operation: 'period.arsredovisning_ixbrl',
        requestId,
      })
      if (!access.allowed) return yearEndAccessDeniedResponse('year_end.ixbrl', access.reason)

      const url = new URL(request.url)
      const download = url.searchParams.get('download') === '1'
      const wantsFinal = url.searchParams.get('final') === 'true'
      if (wantsFinal) {
        const archived = await loadCurrentAnnualReportArtifact(supabase, companyId, id, 'ixbrl')
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
            'Content-Type': `${archived.mime_type}; charset=utf-8`,
            'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${archived.file_name.replace(/["\r\n]/g, '_')}"`,
            'Cache-Control': 'private, no-store, no-cache, must-revalidate',
            Pragma: 'no-cache',
            ETag: `"${archived.sha256_hash}"`,
            'X-Annual-Report-Version': String(archived.version_number),
          },
        })
      }

      const input = await buildIxbrlInput(supabase, companyId, id)
      const preflight = runPreflightChecks(input)
      const { xhtml, warnings } = generateK2IxbrlDocument(input, { isDraft: true })
      const year = input.period.end.slice(0, 4)
      const filename = `arsredovisning-${annualReportFileSlug(input.company.name)}-${year}-utkast.xhtml`
      return new Response(xhtml, {
        headers: {
          'Content-Type': 'application/xhtml+xml; charset=utf-8',
          'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${filename}"`,
          'Cache-Control': 'private, no-store, no-cache, must-revalidate',
          Pragma: 'no-cache',
          'X-Ixbrl-Error-Count': String(preflight.errors.length),
          'X-Ixbrl-Warning-Count': String(preflight.warnings.length + warnings.length),
          'X-Annual-Report-Status': 'draft',
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (/not found/i.test(message)) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      }
      if (/Digital inlämning stöds ännu inte för K3/i.test(message)) {
        return errorResponseFromCode('VALIDATION_FAILED', log, {
          requestId,
          details: {
            code: 'K3_DIGITAL_SUBMISSION_NOT_SUPPORTED',
            reason: message,
          },
        })
      }
      return errorResponse(error, log, { requestId })
    }
  },
  { allowRequestedCompany: true },
)
