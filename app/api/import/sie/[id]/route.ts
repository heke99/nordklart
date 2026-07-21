import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { isSieFiscalPeriodAllowed } from '@/lib/import/access'

async function loadImport(
  supabase: SupabaseClient,
  companyId: string,
  importId: string,
) {
  return supabase
    .from('sie_imports')
    .select('*')
    .eq('id', importId)
    .eq('company_id', companyId)
    .maybeSingle()
}

/** GET /api/import/sie/[id] */
export const GET = withRouteContext(
  'sie_import.get',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, sieImportAccess, log, requestId } = ctx
    const { data, error } = await loadImport(supabase, companyId, id)

    if (error) {
      return errorResponseFromCode('DATABASE_QUERY_FAILED', log, {
        requestId,
        reason: error.message,
        details: { operation: 'get_sie_import', import_id: id },
      })
    }
    if (!data || !isSieFiscalPeriodAllowed(sieImportAccess, data.fiscal_period_id)) {
      return errorResponseFromCode('SIE_IMPORT_NOT_FOUND', log, { requestId })
    }
    return NextResponse.json({ data })
  },
  { accessPolicy: 'sie_import' },
)

/**
 * DELETE /api/import/sie/[id]
 * Only non-posted import metadata may be removed. Completed/partial/replaced
 * imports must stay in the audit trail and use reversal-based undo/replace.
 */
export const DELETE = withRouteContext(
  'sie_import.delete',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, sieImportAccess, log, requestId } = ctx
    const { data: importRecord, error: readError } = await loadImport(supabase, companyId, id)

    if (readError) {
      return errorResponseFromCode('DATABASE_QUERY_FAILED', log, {
        requestId,
        reason: readError.message,
        details: { operation: 'read_sie_import_before_delete', import_id: id },
      })
    }
    if (!importRecord || !isSieFiscalPeriodAllowed(sieImportAccess, importRecord.fiscal_period_id)) {
      return errorResponseFromCode('SIE_IMPORT_NOT_FOUND', log, { requestId })
    }

    if (['completed', 'partial', 'replaced', 'undone'].includes(importRecord.status)) {
      return errorResponseFromCode('SIE_DELETE_POSTED_FORBIDDEN', log, {
        requestId,
        details: { status: importRecord.status },
      })
    }

    const { error } = await supabase
      .from('sie_imports')
      .delete()
      .eq('id', id)
      .eq('company_id', companyId)

    if (error) {
      return errorResponseFromCode('DATABASE_QUERY_FAILED', log, {
        requestId,
        reason: error.message,
        details: { operation: 'delete_sie_import', import_id: id },
      })
    }
    return NextResponse.json({ success: true })
  },
  { requireWrite: true, accessPolicy: 'sie_import' },
)
