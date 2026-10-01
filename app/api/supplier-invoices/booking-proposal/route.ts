import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { suggestAccountsForSupplier } from '@/lib/supplier-invoices/booking-proposal'

const QuerySchema = z.object({ supplier_id: z.string().uuid() })

/**
 * GET /api/supplier-invoices/booking-proposal?supplier_id=…
 *
 * Expense accounts to propose for a supplier's invoice, learned from how the
 * company booked that supplier before (falling back to the supplier's
 * default account). Read-only, through the user's RLS client.
 */
export const GET = withRouteContext(
  'supplier_invoice.booking_proposal',
  async (request, { supabase, companyId, log, requestId }) => {
    const query = validateQuery(request, QuerySchema)
    if (!query.success) return query.response
    try {
      const suggestion = await suggestAccountsForSupplier(supabase, companyId, query.data.supplier_id)
      return NextResponse.json({ data: suggestion })
    } catch (error) {
      return errorResponse(error, log, { requestId })
    }
  },
)
