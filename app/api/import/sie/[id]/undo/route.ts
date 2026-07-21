import { NextResponse } from 'next/server'
import { undoSIEImport } from '@/lib/import/sie-import'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { isSieFiscalPeriodAllowed } from '@/lib/import/access'

/** DELETE /api/import/sie/[id]/undo — reversal-only undo. */
export const DELETE = withRouteContext(
  'sie_import.undo',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, sieImportAccess, log, requestId } = ctx
    const opLog = log.child({ sieImportId: id })

    const { data: importRecord, error: readError } = await supabase
      .from('sie_imports')
      .select('id,fiscal_period_id')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (readError) {
      return errorResponseFromCode('DATABASE_QUERY_FAILED', opLog, {
        requestId,
        reason: readError.message,
      })
    }
    if (!importRecord || !isSieFiscalPeriodAllowed(sieImportAccess, importRecord.fiscal_period_id)) {
      return errorResponseFromCode('SIE_IMPORT_NOT_FOUND', opLog, { requestId })
    }

    const result = await undoSIEImport(supabase, companyId, id, user.id)
    if (!result.success) {
      return errorResponseFromCode('SIE_UNDO_FAILED', opLog, {
        requestId,
        details: { reason: result.error },
      })
    }

    return NextResponse.json({ success: true, reversedEntries: result.reversedEntries })
  },
  { requireWrite: true, accessPolicy: 'sie_import' },
)
