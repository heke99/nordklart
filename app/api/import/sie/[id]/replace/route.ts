import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { isSieFiscalPeriodAllowed } from '@/lib/import/access'

/**
 * Direct replace without a corrected file is disabled. The caller must upload
 * the new SIE file to /execute with onExistingPeriod=replace and the exact
 * replaceImportId; the database then reverses old and posts new atomically.
 */
export const POST = withRouteContext(
  'sie_import.replace',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, sieImportAccess, log, requestId } = ctx
    const { data, error } = await supabase
      .from('sie_imports')
      .select('id,fiscal_period_id,status')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (error) {
      return errorResponseFromCode('DATABASE_QUERY_FAILED', log, {
        requestId,
        reason: error.message,
      })
    }
    if (!data || !isSieFiscalPeriodAllowed(sieImportAccess, data.fiscal_period_id)) {
      return errorResponseFromCode('SIE_IMPORT_NOT_FOUND', log, { requestId })
    }

    return errorResponseFromCode('SIE_REPLACE_FILE_REQUIRED', log, {
      requestId,
      details: {
        replaceImportId: id,
        message: 'Ladda upp den korrigerade SIE-filen och ange detta import-ID i execute-steget.',
      },
    })
  },
  { requireWrite: true, accessPolicy: 'sie_import' },
)
