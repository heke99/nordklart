/**
 * GET /api/v1/companies/{companyId}/invoice-financing/applications/{id}
 *
 * Application detail with offers, events and settlements.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'

registerEndpoint({
  operation: 'invoice_financing.applications.get',
  method: 'GET',
  path: '/api/v1/companies/:companyId/invoice-financing/applications/:id',
  summary: 'Get a financing application with offers, events and settlements.',
  description:
    'Full detail: the application row, all offers (open/accepted/declined/expired), the append-only event trail, and settlements incl. the journal entry that booked the payout.',
  useWhen: 'Inspecting the state of one application (why rejected, offer terms, payout booking).',
  doNotUseFor: 'Listing — use the collection endpoint.',
  pitfalls: ['events are append-only — the trail is the audit log for the application.'],
  example: {
    response: {
      data: {
        application: { id: 'f1a2…', status: 'paid_out' },
        offers: [{ id: 'o1…', status: 'accepted', payout_amount: 12125 }],
        events: [{ event_type: 'paid_out', status_to: 'paid_out' }],
        settlements: [{ payout_amount: 12125, journal_entry_id: 'j1…' }],
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'financing:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: {
    success: z.object({
      application: z.object({ id: z.string().uuid(), status: z.string() }).passthrough(),
      offers: z.array(z.object({}).passthrough()),
      events: z.array(z.object({}).passthrough()),
      settlements: z.array(z.object({}).passthrough()),
    }),
  },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'invoice_financing.applications.get',
  async (_request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Ogiltigt UUID.' },
      })
    }

    const { data: application, error } = await ctx.supabase
      .from('invoice_financing_applications')
      .select('*')
      .eq('company_id', ctx.companyId!)
      .eq('id', idParse.data)
      .maybeSingle()

    if (error) return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    if (!application) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'invoice_financing_application' },
      })
    }

    const [{ data: offers }, { data: events }, { data: settlements }] = await Promise.all([
      ctx.supabase
        .from('invoice_financing_offers')
        .select('*')
        .eq('application_id', idParse.data)
        .order('created_at', { ascending: true }),
      ctx.supabase
        .from('invoice_financing_events')
        .select('*')
        .eq('application_id', idParse.data)
        .order('created_at', { ascending: true }),
      ctx.supabase
        .from('invoice_financing_settlements')
        .select('*')
        .eq('application_id', idParse.data)
        .order('created_at', { ascending: true }),
    ])

    return ok(
      {
        application,
        offers: offers ?? [],
        events: events ?? [],
        settlements: settlements ?? [],
      },
      { requestId: ctx.requestId },
    )
  },
)
