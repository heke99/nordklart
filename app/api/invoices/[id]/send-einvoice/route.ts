import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { sendInvoiceAsEInvoice } from '@/lib/peppol/service'
import { errorResponse } from '@/lib/errors/get-structured-error'

ensureInitialized()

/**
 * POST /api/invoices/[id]/send-einvoice
 *
 * "Skicka som e-faktura" — sends the invoice as Peppol BIS Billing 3 via
 * the configured access-point provider. Non-blocking outcomes (validation
 * failed, participant not found, provider not configured) return 200 with a
 * status + Swedish message so the UI can offer the PDF/email fallback.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.send_einvoice',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    try {
      const outcome = await sendInvoiceAsEInvoice(supabase, {
        companyId: companyId!,
        userId: user.id,
        invoiceId: id,
      })
      return NextResponse.json({ data: outcome })
    } catch (err) {
      log.error('send-einvoice failed', err as Error, { invoiceId: id })
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
