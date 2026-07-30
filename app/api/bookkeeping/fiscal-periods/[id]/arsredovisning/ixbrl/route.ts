import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { buildIxbrlInput } from '@/lib/bokslut/ixbrl/build-input'
import { generateK2IxbrlDocument } from '@/lib/bokslut/ixbrl/document/k2-document'
import { runPreflightChecks } from '@/lib/bokslut/ixbrl/validate/rules'
import { requireYearEndAccess, yearEndAccessDeniedResponse } from '@/lib/year-end/access'

/**
 * GET /api/bookkeeping/fiscal-periods/:id/arsredovisning/ixbrl
 *
 * Generates the iXBRL (XHTML) årsredovisning for the period. The document IS
 * the presentation (per TILLAMPNINGSANVISNING) — the wizard renders it in an
 * iframe as the authoritative preview, and `?download=1` hands the same bytes
 * to the user for manual filing at bolagsverket.se (the self-hosted path).
 *
 * Query params:
 *   - download=1   → Content-Disposition: attachment
 *
 * Economic values are read exclusively from the approved, server-persisted
 * profit disposition. Query parameters can never override them.
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

      const input = await buildIxbrlInput(supabase, companyId, id)

      // Mandatory preflight (R13): download AND preview are blocked on
      // critical validation errors — the user gets the structured issue
      // list, never just a warning count in a header.
      const preflight = runPreflightChecks(input)
      if (!preflight.ok) {
        return errorResponseFromCode('VALIDATION_FAILED', log, {
          requestId,
          details: {
            reason: 'iXBRL-dokumentet klarade inte den obligatoriska förhandskontrollen',
            errors: preflight.errors,
            warnings: preflight.warnings,
          },
        })
      }

      const { xhtml, warnings } = generateK2IxbrlDocument(input)

      const safePeriodEnd = input.period.end.replace(/[^\w.-]/g, '_')
      const filename = `arsredovisning-${safePeriodEnd}.xhtml`
      return new Response(xhtml, {
        headers: {
          // Served as XHTML so iframe preview renders the inline XBRL
          // document exactly as Bolagsverket will present it.
          'Content-Type': 'application/xhtml+xml; charset=utf-8',
          'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${filename}"`,
          'Cache-Control': 'private, no-store, no-cache, must-revalidate',
          Pragma: 'no-cache',
          // Generation warnings surfaced without disturbing the body.
          'X-Ixbrl-Warning-Count': String(warnings.length),
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      if (/not found/i.test(message)) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      }
      // R12: K3 digital submission is explicitly unsupported — surface a
      // structured capability error, never a false "supported" state.
      if (/Digital inlämning stöds ännu inte för K3/i.test(message)) {
        return errorResponseFromCode('VALIDATION_FAILED', log, {
          requestId,
          details: {
            code: 'K3_DIGITAL_SUBMISSION_NOT_SUPPORTED',
            reason: message,
          },
        })
      }
      return errorResponse(err, log, { requestId })
    }
  },
  { allowRequestedCompany: true },
)
