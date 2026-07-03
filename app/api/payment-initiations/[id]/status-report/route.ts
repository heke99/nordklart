import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { parsePain002 } from '@/lib/payments/pain002-parser'

ensureInitialized()

/**
 * POST /api/payment-initiations/[id]/status-report
 *
 * Upload the bank's pain.002 status report for a payment file. Updates the
 * initiation status (accepted / partially_accepted / rejected / settled /
 * pending) and per-payment statuses, keyed by OrgnlMsgId / OrgnlEndToEndId.
 *
 * Rejections carry the ISO reason code (AC01 wrong account, AM04 insufficient
 * funds, …) into the per-payment metadata so the UI can explain exactly which
 * leverantörsbetalning failed and why.
 */

const BodySchema = z.object({
  // Raw pain.002 XML content.
  content: z.string().min(20, 'Filinnehåll saknas'),
})

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'supplier_invoice.payment_initiation.status_report',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, BodySchema, {
      log,
      operation: 'supplier_invoice.payment_initiation.status_report',
    })
    if (!validation.success) return validation.response

    const { data: initiation, error: fetchErr } = await supabase
      .from('payment_initiations')
      .select('id, message_id, status, payments')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (fetchErr) {
      return errorResponse(fetchErr, log, { requestId })
    }
    if (!initiation) {
      return errorResponseFromCode('PAYMENT_INITIATION_NOT_FOUND', log, { requestId })
    }

    const report = parsePain002(validation.data.content)
    if (!report.originalMessageId) {
      return errorResponseFromCode('PAIN002_PARSE_FAILED', log, {
        requestId,
        details: { issues: report.issues },
      })
    }
    if (report.originalMessageId !== initiation.message_id) {
      return errorResponseFromCode('PAIN002_MESSAGE_ID_MISMATCH', log, {
        requestId,
        details: {
          expected: initiation.message_id,
          received: report.originalMessageId,
        },
      })
    }

    // Merge per-transaction statuses into the payments metadata.
    type PaymentMeta = {
      end_to_end_id: string
      [key: string]: unknown
    }
    const payments = ((initiation.payments ?? []) as PaymentMeta[]).map((p) => {
      const tx = report.transactions.find((t) => t.originalEndToEndId === p.end_to_end_id)
      if (!tx) return p
      return {
        ...p,
        status: tx.status,
        reason_code: tx.reasonCode,
        reason_text: tx.reasonText,
      }
    })

    const newStatus = report.groupStatus === 'unknown' ? initiation.status : report.groupStatus

    const { data: updated, error: updateErr } = await supabase
      .from('payment_initiations')
      .update({
        status: newStatus,
        payments,
        status_updated_at: new Date().toISOString(),
        error_message: report.groupStatus === 'rejected'
          ? report.transactions.find((t) => t.reasonText)?.reasonText ?? 'Betalfilen avvisades av banken'
          : null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('company_id', companyId)
      .select('id, status, payments, status_updated_at, error_message')
      .single()

    if (updateErr) {
      return errorResponse(updateErr, log, { requestId })
    }

    log.info('pain.002 status report applied', {
      initiationId: id,
      status: newStatus,
      transactionStatuses: report.transactions.length,
    })

    return NextResponse.json({
      data: {
        initiation: updated,
        report: {
          group_status: report.groupStatus,
          transactions: report.transactions,
          issues: report.issues,
        },
      },
    })
  },
  { requireWrite: true },
)
