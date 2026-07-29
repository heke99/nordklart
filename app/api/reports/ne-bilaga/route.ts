import { NextResponse } from 'next/server'
import JSZip from 'jszip'
import { generateNEDeclaration } from '@/lib/reports/ne-bilaga/ne-engine'
import {
  generateNESRUSubmission,
  getSRUFilename,
  validateNESRUSubmission,
} from '@/lib/reports/ne-bilaga/sru-generator'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { requireYearEndAccess, yearEndAccessDeniedResponse } from '@/lib/year-end/access'
import { recordTaxDeclarationExport, upsertTaxDeclarationProject } from '@/lib/tax-declaration/adjustments'

/**
 * GET /api/reports/ne-bilaga
 *
 * Query parameters:
 *   period_id: fiscal period id (required)
 *   format:    'json' (default) or 'sru' for SRU ZIP draft download
 *   allow_draft=1 permits NE export while R12–R48 are not complete.
 */
export const GET = withRouteContext(
  'report.ne_bilaga',
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
        operation: 'report.ne_bilaga',
        requestId,
      })
      if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)

      const declaration = await generateNEDeclaration(supabase, companyId!, periodId)
      const readiness = declaration.taxAnalysis
      if (readiness) {
        await upsertTaxDeclarationProject(
          supabase,
          companyId,
          periodId,
          'NE',
          user.id,
          readiness.status,
          readiness.readinessScore,
          readiness.issues.filter((item) => item.severity === 'blocker'),
          readiness.issues.filter((item) => item.severity === 'warning'),
        )
      }

      if (format === 'sru') {
        if (readiness?.blockerCount && searchParams.get('allow_draft') !== '1') {
          return NextResponse.json({
            error: 'NE_DECLARATION_NOT_READY',
            message: 'NE-deklarationen saknar fortfarande komplett R12–R48-/EF-underlag. Exportera endast som utkast med allow_draft=1.',
            blockers: readiness.issues.filter((item) => item.severity === 'blocker'),
          }, { status: 409 })
        }

        const submission = generateNESRUSubmission(declaration)
        const validation = validateNESRUSubmission(submission)
        if (!validation.isValid) {
          return NextResponse.json({
            error: 'SRU_VALIDATION_FAILED',
            message: 'NE SRU-paketet klarade inte lokal strukturvalidering.',
            validation,
          }, { status: 422 })
        }

        const zip = new JSZip()
        zip.file('INFO.SRU', encodeISO88591(submission.infoSru))
        zip.file('BLANKETTER.SRU', encodeISO88591(submission.blanketterSru))
        const zipArrayBuffer = await zip.generateAsync({ type: 'arraybuffer' })
        const filename = getSRUFilename(declaration)

        await recordTaxDeclarationExport(supabase, companyId, periodId, 'NE', user.id, {
          format: 'sru_zip_draft',
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
      opLog.error('ne-bilaga declaration generation failed', err as Error)
      return errorResponseFromCode('TAX_DECL_GENERATION_FAILED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? err.message : 'unknown' },
      })
    }
  },
  { allowRequestedCompany: true },
)

function encodeISO88591(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length)
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    bytes[i] = code <= 0xFF ? code : 0x3F
  }
  return bytes
}
