/**
 * POST /api/v1/companies/{companyId}/invoice-financing/applications/{id}/accept
 *
 * Accept the open offer: the provider pays out, the receivable is booked
 * (sold non-recourse or pledged recourse) and a settlement is recorded.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { acceptFinancingOffer } from '@/lib/invoice-financing/service'
import { ensureInitialized } from '@/lib/init'

registerEndpoint({
  operation: 'invoice_financing.applications.accept',
  method: 'POST',
  path: '/api/v1/companies/:companyId/invoice-financing/applications/:id/accept',
  summary: 'Accept an open financing offer (triggers payout + booking).',
  description:
    'Accepts the open offer on an application in status offer_created. The provider pays out; Nordklart books the payout (non-recourse: Dr 1930/6064, Cr 1510 — recourse: reclass 1510→1512 + Cr 2330) and writes a settlement row. Emits invoice_financing.paid_out.',
  useWhen: 'The company accepts the offered terms.',
  doNotUseFor: 'Applications without an open offer — returns INVALID_STATE.',
  pitfalls: [
    'Offers expire — an expired offer returns OFFER_EXPIRED and is closed.',
    'If no open fiscal period covers the payout date the payout still advances but booking must be redone manually (message_sv contains the warning).',
  ],
  example: {
    response: {
      data: {
        application: { id: 'f1a2…', status: 'paid_out' },
        journal_entry_id: 'j1…',
        message_sv: 'Utbetalning genomförd: 12 125 kr utbetalt och bokfört.',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'financing:write',
  risk: 'high',
  idempotent: false,
  reversible: false,
  dryRunSupported: false,
  response: {
    success: z.object({
      application: z.object({ id: z.string().uuid(), status: z.string() }).passthrough(),
      journal_entry_id: z.string().uuid().nullable(),
      message_sv: z.string(),
    }),
  },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'invoice_financing.applications.accept',
  async (_request, ctx, params) => {
    await ensureInitialized()

    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Ogiltigt UUID.' },
      })
    }

    const outcome = await acceptFinancingOffer(ctx.supabase, {
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
      {
        application: outcome.application,
        journal_entry_id: outcome.journalEntryId,
        message_sv: outcome.message_sv,
      },
      { requestId: ctx.requestId },
    )
  },
)
