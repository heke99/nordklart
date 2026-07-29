import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { uploadDocument, validateDocumentFile } from '@/lib/core/documents/document-service'
import { requireYearEndAccess, yearEndAccessDeniedResponse } from '@/lib/year-end/access'
import { createServiceClient } from '@/lib/supabase/server'

const CATEGORIES = new Set(['ar', 'ap', 'ar_item', 'ap_item', 'equity', 'tax', 'vat'])

export const POST = withRouteContext(
  'period.historical_support_evidence',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, companyId } = ctx
    const db = createServiceClient()
    const access = await requireYearEndAccess(db, companyId, user.id, id, {
      operation: 'period.historical_support_evidence',
      requestId: ctx.requestId,
      requireWrite: true,
    })
    if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)

    const form = await request.formData().catch(() => null)
    const file = form?.get('file')
    const category = String(form?.get('category') ?? '')
    const balanceRaw = String(form?.get('verified_balance') ?? '').replace(',', '.')
    const method = String(form?.get('verification_method') ?? '').trim()
    const comment = String(form?.get('comment') ?? '').trim()
    const isItemEvidence = category === 'ar_item' || category === 'ap_item'
    if (
      !form
      || !(file instanceof File)
      || !CATEGORIES.has(category)
      || (!isItemEvidence && !/^-?\d+(?:\.\d{1,2})?$/.test(balanceRaw))
      || (!isItemEvidence && method.length < 3)
      || (!isItemEvidence && comment.length < 3)
    ) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Underlag och verifieringsuppgifter krävs.' } },
        { status: 400 },
      )
    }
    const fileError = validateDocumentFile({ size: file.size, type: file.type })
    if (fileError) {
      return NextResponse.json(
        { error: { code: 'DOCUMENT_INVALID', message: fileError } },
        { status: 400 },
      )
    }

    let uploaded: Awaited<ReturnType<typeof uploadDocument>> | null = null
    let persisted = false
    try {
      uploaded = await uploadDocument(
        db,
        user.id,
        companyId,
        { name: file.name, buffer: await file.arrayBuffer(), type: file.type },
        { upload_source: 'file_upload' },
      )
      if (isItemEvidence) {
        const itemId = String(form.get('item_id') ?? '')
        const { error: linkError } = await db.rpc(
          'attach_migrated_open_item_document',
          {
            p_kind: category === 'ar_item' ? 'ar' : 'ap',
            p_company_id: companyId,
            p_fiscal_period_id: id,
            p_item_id: itemId,
            p_document_id: uploaded.id,
            p_user_id: user.id,
          },
        )
        if (linkError) throw linkError
        persisted = true
        return NextResponse.json(
          { data: { item_id: itemId, document_id: uploaded.id } },
          { status: 201 },
        )
      }
      const common = {
        p_company_id: companyId,
        p_fiscal_period_id: id,
        p_user_id: user.id,
        p_document_id: uploaded.id,
        p_verification_method: method,
        p_comment: comment,
        p_idempotency_key:
          request.headers.get('idempotency-key')?.slice(0, 128) ?? crypto.randomUUID(),
      }
      const result =
        category === 'ar' || category === 'ap'
          ? await db.rpc('record_external_open_item_reconciliation', {
              ...common,
              p_kind: category,
              p_external_legacy_balance: Number(balanceRaw),
            })
          : await db.rpc('record_historical_balance_reconciliation', {
              ...common,
              p_category: category,
              p_verified_balance: Number(balanceRaw),
              p_details:
                category === 'equity'
                  ? {
                      opening_equity: Number(form.get('opening_equity') ?? 0),
                      increases: Number(form.get('increases') ?? 0),
                      decreases: Number(form.get('decreases') ?? 0),
                      current_year_result: Number(form.get('current_year_result') ?? 0),
                    }
                  : {},
            })
      if (result.error) throw result.error
      persisted = true
      return NextResponse.json({ data: result.data }, { status: 201 })
    } catch (error) {
      if (uploaded && !persisted) {
        await db.from('document_attachments').delete().eq('id', uploaded.id)
        await db.storage.from('documents').remove([uploaded.storage_path])
      }
      const message = error instanceof Error ? error.message : 'Verifieringen misslyckades'
      ctx.log.error('historical support evidence failed', error as Error)
      return NextResponse.json(
        { error: { code: 'HISTORICAL_SUPPORT_EVIDENCE_FAILED', message } },
        { status: /DIFFERENCE|INVALID|CONFLICT|EXISTS/i.test(message) ? 409 : 500 },
      )
    }
  },
  { allowRequestedCompany: true },
)
