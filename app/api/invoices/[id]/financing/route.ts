import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { checkFinancingEligibility } from '@/lib/invoice-financing/eligibility'
import { createFinancingApplication } from '@/lib/invoice-financing/service'
import { getFinancingReadiness } from '@/lib/invoice-financing/provider'
import { FINANCING_REQUIRES_AGREEMENT_MESSAGE_SV } from '@/lib/invoice-financing/types'
import type { Customer, Invoice } from '@/types'

ensureInitialized()

/**
 * /api/invoices/[id]/financing — dashboard-facing invoice financing.
 *
 * GET  — eligibility preview + the latest application (with offers) for the
 *        invoice, so the UI can render the correct state.
 * POST — "Erbjud fakturafinansiering": create an application and (sandbox)
 *        receive the offer synchronously.
 */

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.financing_status',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx

    try {
      const readiness = getFinancingReadiness()

      const { data: invoiceRow } = await supabase
        .from('invoices')
        .select('*, customer:customers(*)')
        .eq('id', id)
        .eq('company_id', companyId!)
        .maybeSingle()

      if (!invoiceRow) {
        return NextResponse.json({ error: 'Fakturan kunde inte hittas.' }, { status: 404 })
      }
      const invoice = invoiceRow as unknown as Invoice & { customer: Customer | null }

      const { data: providerRow } = await supabase
        .from('invoice_financing_providers')
        .select('slug, name, status, min_amount, max_amount, fee_percent_default')
        .eq('slug', 'sandbox')
        .maybeSingle()

      const issues =
        providerRow != null
          ? checkFinancingEligibility({
              invoice,
              customer: invoice.customer,
              provider: {
                min_amount: Number(providerRow.min_amount),
                max_amount: providerRow.max_amount == null ? null : Number(providerRow.max_amount),
              },
            })
          : []

      const { data: application } = await supabase
        .from('invoice_financing_applications')
        .select('*, offers:invoice_financing_offers(*)')
        .eq('invoice_id', id)
        .eq('company_id', companyId!)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      return NextResponse.json({
        data: {
          readiness,
          readiness_message_sv:
            readiness === 'requires_agreement' ? FINANCING_REQUIRES_AGREEMENT_MESSAGE_SV : null,
          provider: providerRow,
          eligible: issues.length === 0,
          issues,
          application,
        },
      })
    } catch (err) {
      log.error('financing status failed', err as Error, { invoiceId: id })
      return errorResponse(err, log, { requestId })
    }
  },
)

const CreateBody = z.object({
  recourse: z.boolean().optional(),
  consent_id: z.string().uuid().optional(),
})

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.financing_apply',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    try {
      let body: z.infer<typeof CreateBody> = {}
      try {
        const raw = await request.json()
        const parsed = CreateBody.safeParse(raw)
        if (parsed.success) body = parsed.data
      } catch {
        // Empty body is fine — defaults apply.
      }

      const outcome = await createFinancingApplication(supabase, {
        companyId: companyId!,
        userId: user.id,
        invoiceId: id,
        recourse: body.recourse,
        consentId: body.consent_id ?? null,
      })

      if (!outcome.ok) {
        const status =
          outcome.code === 'NOT_FOUND' ? 404 : outcome.code === 'ALREADY_ACTIVE' ? 409 : 422
        return NextResponse.json(
          {
            error: outcome.message_sv,
            code: outcome.code,
            issues: outcome.code === 'NOT_ELIGIBLE' ? outcome.issues : undefined,
          },
          { status },
        )
      }

      return NextResponse.json({
        data: {
          application: outcome.application,
          offer: outcome.offer,
          message_sv: outcome.message_sv,
        },
      })
    } catch (err) {
      log.error('financing apply failed', err as Error, { invoiceId: id })
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
