import { NextResponse } from 'next/server'
import { generateINK2Declaration } from '@/lib/reports/ink2/ink2-engine'
import {
  generateSRUSubmission,
  getZipFilename,
  validateSRUSubmission,
} from '@/lib/reports/ink2/sru-generator'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { requireYearEndAccess, yearEndAccessDeniedResponse } from '@/lib/year-end/access'
import { recordTaxDeclarationExport, upsertTaxDeclarationProject } from '@/lib/tax-declaration/adjustments'
import JSZip from 'jszip'

/**
 * GET /api/reports/ink2
 *
 * Query parameters:
 *   period_id: fiscal period id (required)
 *   format:    'json' (default) or 'sru' for SRU file download (ZIP with INFO.SRU + BLANKETTER.SRU)
 */
export const GET = withRouteContext(
  'report.ink2',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const { searchParams } = new URL(request.url)
    const periodId = searchParams.get('period_id')
    const format = searchParams.get('format') || 'json'

    if (!periodId) {
      return errorResponseFromCode('REPORT_PERIOD_REQUIRED', log, { requestId })
    }

    const opLog = log.child({ periodId, format })

    try {
      const access = await requireYearEndAccess(supabase, companyId, user.id, periodId, {
        operation: 'report.ink2',
        requestId,
      })
      if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)

      const declaration = await generateINK2Declaration(supabase, companyId!, periodId)
      const readiness = declaration.taxAnalysis
      if (readiness) {
        await upsertTaxDeclarationProject(
          supabase,
          companyId,
          periodId,
          'INK2',
          user.id,
          readiness.status,
          readiness.readinessScore,
          readiness.issues.filter((item) => item.severity === 'blocker'),
          readiness.issues.filter((item) => item.severity === 'warning'),
        )
      }

      if (format === 'sru') {
        if (readiness?.blockerCount && new URL(request.url).searchParams.get('allow_draft') !== '1') {
          return NextResponse.json({
            error: 'TAX_DECLARATION_NOT_READY',
            message: 'Deklarationen har blockerande kontroller. Åtgärda dem eller exportera uttryckligen som utkast med allow_draft=1.',
            blockers: readiness.issues.filter((item) => item.severity === 'blocker'),
          }, { status: 409 })
        }

        const submission = generateSRUSubmission(declaration)
        const validation = validateSRUSubmission(submission)
        if (!validation.isValid) {
          return NextResponse.json({
            error: 'SRU_VALIDATION_FAILED',
            message: 'SRU-paketet klarade inte lokal strukturvalidering.',
            validation,
          }, { status: 422 })
        }

        // Skatteverket requires ISO 8859-1 (Latin-1)
        const infoBytes = encodeISO88591(submission.infoSru)
        const blanketterBytes = encodeISO88591(submission.blanketterSru)

        const zip = new JSZip()
        zip.file('INFO.SRU', infoBytes)
        zip.file('BLANKETTER.SRU', blanketterBytes)

        const zipArrayBuffer = await zip.generateAsync({ type: 'arraybuffer' })
        const filename = getZipFilename(declaration)
        await recordTaxDeclarationExport(supabase, companyId, periodId, 'INK2', user.id, {
          format: 'sru_zip',
          filename,
          readinessScore: readiness?.readinessScore ?? 0,
          blockerCount: readiness?.blockerCount ?? 0,
          warningCount: validation.warnings.length + (readiness?.issues.filter((item) => item.severity === 'warning').length ?? 0),
          validation,
        })

        return new NextResponse(zipArrayBuffer, {
          status: 200,
          headers: {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'X-Request-Id': requestId,
          },
        })
      }

      return NextResponse.json({ data: declaration })
    } catch (err) {
      opLog.error('ink2 declaration generation failed', err as Error)
      return errorResponseFromCode('TAX_DECL_GENERATION_FAILED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? err.message : 'unknown' },
      })
    }
  },
)

/** Encode a string as ISO 8859-1 bytes; characters outside Latin-1 become '?'. */
function encodeISO88591(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length)
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    bytes[i] = code <= 0xFF ? code : 0x3F
  }
  return bytes
}
