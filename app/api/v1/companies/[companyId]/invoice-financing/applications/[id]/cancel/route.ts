/**
 * POST /api/v1/companies/{companyId}/invoice-financing/applications/{id}/cancel
 *
 * Cancel an application that has not yet been accepted/paid out.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { cancelFinancingApplication } from '@/lib/invoice-financing/service'

registerEndpoint({
  operation: 'invoice_financing.applications.cancel',
  method: 'POST',
  path: '/api/v1/companies/:companyId/invoice-financing/applications/:id/cancel',
  summary: 'Cancel a financing application before acceptance.',
  description:
    'Cancels an application in status submitted / needs_more_info / offer_created. Open offers are declined. Accepted or paid-out applications cannot be cancelled (returns INVALID_STATE).',
  useWhen: 'The company no longer wants to finance the invoice.',
  doNotUseFor: 'Reversing a payout — contact the provider.',
  pitfalls: ['Cancellation is terminal — create a new application to try again.'],
  example: {
    response: {
      data: {
        application: { id: 'f1a2…', status: 'cancelled' },
        message_sv: 'Ansökan har avbrutits.',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'financing:write',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: {
    success: z.object({
      application: z.object({ id: z.string().uuid(), status: z.string() }).passthrough(),
      message_sv: z.string(),
    }),
  },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'invoice_financing.applications.cancel',
  async (_request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Ogiltigt UUID.' },
      })
    }

    const outcome = await cancelFinancingApplication(ctx.supabase, {
      companyId: ctx.companyId!,
      userId: ctx.userId,
      applicationId: idParse.data,
    })

    if (!outcome.ok) {
      if (outcome.code === 'NOT_FOUND') {
        return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
          requestId: ctx.requestId,
          details: { resource: 'invoice_financing_application' },
        })
      }
      return v1ErrorResponseFromCode('CONFLICT', ctx.log, {
        requestId: ctx.requestId,
        details: { code: outcome.code, message: outcome.message_sv },
      })
    }

    return ok(
      { application: outcome.application, message_sv: outcome.message_sv },
      { requestId: ctx.requestId },
    )
  },
)
