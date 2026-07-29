import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { requireYearEndAccess, yearEndAccessDeniedResponse } from '@/lib/year-end/access'
import { createServiceClient } from '@/lib/supabase/server'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SIGNED_URL_TTL_SECONDS = 5 * 60

/** Short-lived, audited download of an accepted manual reconciliation file. */
export const GET = withRouteContext(
  'period.year_end_manual_cash_reconciliation_evidence',
  async (
    _request,
    ctx,
    {
      params,
    }: {
      params: Promise<{ id: string; reconciliationId: string }>
    },
  ) => {
    const { id, reconciliationId } = await params
    const { user, companyId, log, requestId } = ctx
    if (!UUID_RE.test(reconciliationId)) {
      return errorResponseFromCode('YEAR_END_MANUAL_RECONCILIATION_EVIDENCE_NOT_FOUND', log, {
        requestId,
      })
    }

    const serviceDb = createServiceClient()
    const access = await requireYearEndAccess(serviceDb, companyId, user.id, id, {
      operation: 'period.year_end_manual_cash_reconciliation_evidence',
      requestId,
    })
    if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)

    const { data: reconciliation, error: reconciliationError } = await serviceDb
      .from('year_end_manual_cash_reconciliations')
      .select('id, evidence_document_id, evidence_file_name, evidence_sha256')
      .eq('id', reconciliationId)
      .eq('company_id', companyId)
      .eq('fiscal_period_id', id)
      .maybeSingle()

    if (reconciliationError || !reconciliation) {
      return errorResponseFromCode('YEAR_END_MANUAL_RECONCILIATION_EVIDENCE_NOT_FOUND', log, {
        requestId,
      })
    }

    const { data: document, error: documentError } = await serviceDb
      .from('document_attachments')
      .select('id, storage_path')
      .eq('id', reconciliation.evidence_document_id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (documentError || !document) {
      return errorResponseFromCode('YEAR_END_MANUAL_RECONCILIATION_EVIDENCE_NOT_FOUND', log, {
        requestId,
      })
    }

    const { data: signed, error: signedError } = await serviceDb.storage
      .from('documents')
      .createSignedUrl(document.storage_path, SIGNED_URL_TTL_SECONDS, {
        download: reconciliation.evidence_file_name,
      })
    if (signedError || !signed?.signedUrl) {
      log.error('manual reconciliation evidence signing failed', signedError as Error)
      return errorResponseFromCode('YEAR_END_MANUAL_RECONCILIATION_FAILED', log, {
        requestId,
      })
    }

    const { error: auditError } = await serviceDb.from('audit_log').insert({
      user_id: user.id,
      actor_id: user.id,
      company_id: companyId,
      action: 'SECURITY_EVENT',
      table_name: 'year_end_manual_cash_reconciliations',
      record_id: reconciliation.id,
      description: 'Manuellt bokslutsavstämningsunderlag öppnades.',
      new_state: {
        company_id: companyId,
        fiscal_period_id: id,
        reconciliation_id: reconciliation.id,
        evidence_document_id: reconciliation.evidence_document_id,
        evidence_sha256: reconciliation.evidence_sha256,
        request_id: requestId,
      },
    })
    if (auditError) {
      log.error('manual reconciliation evidence audit failed', new Error(auditError.message))
      return errorResponseFromCode('YEAR_END_MANUAL_RECONCILIATION_FAILED', log, {
        requestId,
      })
    }

    return NextResponse.redirect(signed.signedUrl, 307)
  },
  { allowRequestedCompany: true },
)
