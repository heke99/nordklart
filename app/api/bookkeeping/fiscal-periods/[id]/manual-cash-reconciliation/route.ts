import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import {
  uploadDocument,
  validateDocumentFile,
} from '@/lib/core/documents/document-service'
import { requireYearEndAccess, yearEndAccessDeniedResponse } from '@/lib/year-end/access'
import { createServiceClient } from '@/lib/supabase/server'
import {
  loadYearEndCashReconciliationStatus,
  type YearEndCashReconciliationStatus,
} from '@/lib/bokslut/manual-cash-reconciliation'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

async function loadStatus(
  companyId: string,
  fiscalPeriodId: string,
): Promise<YearEndCashReconciliationStatus[]> {
  const serviceDb = createServiceClient()
  return loadYearEndCashReconciliationStatus(serviceDb, companyId, fiscalPeriodId)
}

/** Canonical per-account status used by the manual year-end reconciliation UI. */
export const GET = withRouteContext(
  'period.year_end_manual_cash_reconciliation_status',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, companyId, log, requestId } = ctx
    const serviceDb = createServiceClient()
    const access = await requireYearEndAccess(serviceDb, companyId, user.id, id, {
      operation: 'period.year_end_manual_cash_reconciliation_status',
      requestId,
    })
    if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)

    try {
      const status = await loadStatus(companyId, id)
      return NextResponse.json({ data: status })
    } catch (error) {
      log.error('manual cash reconciliation status failed', error as Error)
      return errorResponseFromCode('YEAR_END_PREVIEW_FAILED', log, {
        requestId,
        details: { reason: error instanceof Error ? error.message : 'unknown' },
      })
    }
  },
  { allowRequestedCompany: true },
)

/**
 * Archive evidence and record a server-verified zero-difference reconciliation.
 *
 * multipart/form-data:
 *   statement_balance  required, maximum two decimal places
 *   cash_account_id    required when the company has an enabled cash account
 *   file               PDF/JPG/PNG/WebP balance-date evidence
 */
export const POST = withRouteContext(
  'period.year_end_manual_cash_reconciliation_create',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, companyId, log, requestId } = ctx
    const serviceDb = createServiceClient()
    const access = await requireYearEndAccess(serviceDb, companyId, user.id, id, {
      operation: 'period.year_end_manual_cash_reconciliation_create',
      requestId,
      requireWrite: true,
    })
    if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)

    let formData: FormData
    try {
      formData = await request.formData()
    } catch {
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        details: { field: 'body', reason: 'multipart/form-data required' },
      })
    }

    const filePart = formData.get('file')
    if (!(filePart instanceof File)) {
      return errorResponseFromCode('YEAR_END_MANUAL_RECONCILIATION_EVIDENCE_REQUIRED', log, {
        requestId,
      })
    }
    const fileError = validateDocumentFile({ size: filePart.size, type: filePart.type })
    if (fileError) {
      return errorResponseFromCode(
        /storlek|stor|MB|tom/i.test(fileError)
          ? 'DOC_UPLOAD_TOO_LARGE'
          : 'DOC_UPLOAD_UNSUPPORTED_TYPE',
        log,
        {
          requestId,
          details: { reason: fileError, sizeBytes: filePart.size, mimeType: filePart.type },
        },
      )
    }

    const balanceRaw = String(formData.get('statement_balance') ?? '').trim().replace(',', '.')
    if (!/^-?\d+(?:\.\d{1,2})?$/.test(balanceRaw)) {
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        details: {
          field: 'statement_balance',
          reason: 'Beloppet måste vara ett tal med högst två decimaler.',
        },
      })
    }
    const statementBalance = Number(balanceRaw)
    if (!Number.isFinite(statementBalance) || Math.abs(statementBalance) > 999_999_999_999_999) {
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        details: { field: 'statement_balance', reason: 'Beloppet ligger utanför tillåtet intervall.' },
      })
    }

    const cashAccountRaw = String(formData.get('cash_account_id') ?? '').trim()
    const cashAccountId = cashAccountRaw || null
    if (cashAccountId && !UUID_RE.test(cashAccountId)) {
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        details: { field: 'cash_account_id', reason: 'Ogiltigt konto-id.' },
      })
    }

    const headerKey = request.headers.get('idempotency-key')?.trim()
    const formKey = String(formData.get('idempotency_key') ?? '').trim()
    const idempotencyKey = (headerKey || formKey || crypto.randomUUID()).slice(0, 128)
    if (idempotencyKey.length < 8) {
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        details: { field: 'idempotency_key', reason: 'Idempotensnyckeln är för kort.' },
      })
    }

    let uploaded: Awaited<ReturnType<typeof uploadDocument>> | null = null
    let reconciliationPersisted = false
    try {
      uploaded = await uploadDocument(
        serviceDb,
        user.id,
        companyId,
        {
          name: filePart.name,
          buffer: await filePart.arrayBuffer(),
          type: filePart.type,
        },
        { upload_source: 'file_upload' },
      )

      const { data, error } = await serviceDb.rpc(
        'record_year_end_manual_cash_reconciliation',
        {
          p_company_id: companyId,
          p_fiscal_period_id: id,
          p_user_id: user.id,
          p_cash_account_id: cashAccountId,
          p_statement_balance: statementBalance,
          p_evidence_document_id: uploaded.id,
          p_idempotency_key: idempotencyKey,
        },
      )
      if (error) throw new Error(error.message)
      reconciliationPersisted = true

      let status: YearEndCashReconciliationStatus[] | null = null
      try {
        status = await loadStatus(companyId, id)
      } catch (statusError) {
        // The reconciliation is already committed and its evidence is now
        // retention-protected. A transient status-read failure must therefore
        // never enter the orphan cleanup path and delete the underlying file.
        log.warn('manual cash reconciliation committed but status refresh failed', {
          error: statusError instanceof Error ? statusError.message : 'unknown',
        })
      }

      return NextResponse.json(
        {
          data: {
            reconciliation: data,
            status,
          },
        },
        { status: 201 },
      )
    } catch (error) {
      // The document becomes retention-protected only after the RPC references
      // it. If validation/commit fails, remove the unlinked upload so retries
      // do not leave orphaned evidence objects.
      if (uploaded && !reconciliationPersisted) {
        await serviceDb.from('document_attachments').delete().eq('id', uploaded.id)
        await serviceDb.storage.from('documents').remove([uploaded.storage_path])
      }

      const message = error instanceof Error ? error.message : ''
      if (/YEAR_END_MANUAL_RECONCILIATION_DIFFERENCE/i.test(message)) {
        return errorResponseFromCode('YEAR_END_MANUAL_RECONCILIATION_DIFFERENCE', log, {
          requestId,
        })
      }
      if (/BANK_FEED_PRESENT|BANK_TRANSACTIONS_PRESENT/i.test(message)) {
        return errorResponseFromCode('YEAR_END_MANUAL_RECONCILIATION_BANK_FEED_PRESENT', log, {
          requestId,
        })
      }
      if (/IDEMPOTENCY_CONFLICT/i.test(message)) {
        return errorResponseFromCode('IDEMPOTENCY_KEY_REUSE', log, { requestId })
      }
      if (/PERIOD_(?:NOT_FOUND|CLOSED)|ACCOUNT_(?:NOT_FOUND|REQUIRED)/i.test(message)) {
        return errorResponseFromCode(
          /PERIOD_CLOSED/i.test(message) ? 'PERIOD_LOCKED' : 'VALIDATION_ERROR',
          log,
          { requestId },
        )
      }
      log.error('manual cash reconciliation create failed', error as Error)
      return errorResponseFromCode('YEAR_END_MANUAL_RECONCILIATION_FAILED', log, {
        requestId,
      })
    }
  },
  { allowRequestedCompany: true },
)
