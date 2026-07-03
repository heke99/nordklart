import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'

ensureInitialized()

/**
 * GET /api/payment-initiations — list the company's outbound payment files
 * (supplier payments, salary, tax) with their bank statuses. `file_content`
 * is excluded from the list payload (can be large); fetch a single row for
 * re-download.
 */
export const GET = withRouteContext(
  'supplier_invoice.payment_initiations.list',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx
    const { searchParams } = new URL(request.url)
    const kind = searchParams.get('kind')

    let query = supabase
      .from('payment_initiations')
      .select('id, kind, method, message_id, status, payment_date, currency, total_amount, payment_count, file_name, supplier_invoice_ids, status_updated_at, error_message, created_at')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .limit(100)

    if (kind && ['supplier_payment', 'salary', 'tax'].includes(kind)) {
      query = query.eq('kind', kind)
    }

    const { data, error } = await query
    if (error) {
      log.error('payment_initiations list failed', error)
      return errorResponse(error, log, { requestId })
    }

    return NextResponse.json({ data })
  },
)
