import { renderToBuffer } from '@react-pdf/renderer'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { buildArsredovisningData } from '@/lib/bokslut/arsredovisning/build-data'
import { requireYearEndAccess, yearEndAccessDeniedResponse } from '@/lib/year-end/access'
import { ArsredovisningPDF } from '@/lib/bokslut/arsredovisning/arsredovisning-pdf'
import { ArsredovisningK3PDF } from '@/lib/bokslut/arsredovisning/arsredovisning-k3-pdf'

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
      if (!access.allowed) return yearEndAccessDeniedResponse()

      // Narrative edits come from arsredovisning_narratives now, loaded
      // inside buildArsredovisningData. The URL stays clean — no narrative
      // text in query params, access logs, or browser history.
      const data = await buildArsredovisningData(supabase, companyId, id)

      // Draft vs final (R11): the document is a DRAFT — with a visible
      // watermark — until (a) the period is closed, (b) no flerårsöversikt
      // row is missing data, and (c) no förvaltningsberättelse field rests
      // on unconfirmed boilerplate (R10). `?final=true` requests the final
      // document and is BLOCKED with the outstanding checks until they pass.
      const { data: periodRow } = await supabase
        .from('fiscal_periods')
        .select('is_closed')
        .eq('id', id)
        .eq('company_id', companyId)
        .maybeSingle()
      const blockers: string[] = []
      if (!periodRow?.is_closed) {
        blockers.push('Räkenskapsåret är inte stängt (bokslut saknas).')
      }
      if (data.forvaltningsberattelse.flerarsoversikt.some((r) => r.data_missing)) {
        blockers.push('Flerårsöversikten saknar underlag för ett eller flera år.')
      }
      if (data.unconfirmed_defaults.length > 0) {
        blockers.push(
          `Obekräftade standardtexter i förvaltningsberättelsen: ${data.unconfirmed_defaults.join(', ')}.`,
        )
      }
      if (data.signatures.length === 0) {
        blockers.push('Inga undertecknare är registrerade.')
      }

      const url = new URL(request.url)
      const wantsFinal = url.searchParams.get('final') === 'true'
      if (wantsFinal && blockers.length > 0) {
        return errorResponseFromCode('VALIDATION_FAILED', log, {
          requestId,
          details: {
            reason: 'Slutlig årsredovisning kan inte genereras ännu',
            blockers,
          },
        })
      }
      const isDraft = !wantsFinal || blockers.length > 0

      // Dispatch on the framework recorded in the data. K3 documents need
      // the additional kassaflöde + equity-changes pages + richer noter
      // that ArsredovisningK3PDF renders.
      const PdfComponent =
        data.accounting_framework === 'k3'
          ? ArsredovisningK3PDF
          : ArsredovisningPDF
      const pdfBuffer = await renderToBuffer(
        PdfComponent({ data, isDraft, draftBlockers: blockers }),
      )
      // Sanitize the dynamic segment so a stray quote / newline in the date
      // (defensive — unlikely to ever happen) can't break the header.
      const safePeriodEnd = data.fiscal_period.period_end.replace(/[^\w.-]/g, '_')
      const filename = `arsredovisning-${safePeriodEnd}${isDraft ? '-utkast' : ''}.pdf`
      return new Response(new Uint8Array(pdfBuffer), {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="${filename}"`,
          // ÅR contains company financials + officer names — don't let any
          // intermediary cache the document.
          'Cache-Control': 'private, no-store, no-cache, must-revalidate',
          'Pragma': 'no-cache',
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      if (/not found/i.test(message)) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      }
      return errorResponse(err, log, { requestId })
    }
  },
)
