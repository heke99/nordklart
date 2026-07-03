/**
 * GET /api/v1/companies/{companyId}/events
 *
 * Poll the ephemeral event log (event_log, 30-day TTL) — the webhook
 * fallback for integrators who cannot receive inbound HTTP. Sequence-based
 * cursor: pass ?after=<sequence> to fetch events emitted after that point.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'

const EventRow = z.object({
  sequence: z.number(),
  event_type: z.string(),
  entity_id: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
  created_at: z.string(),
})

registerEndpoint({
  operation: 'events.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/events',
  summary: 'Poll the event feed (webhook fallback).',
  description:
    'Returns events for the company ordered by sequence. Pass ?after=<sequence> (from the previous page\'s last row) to poll incrementally, and ?event_type= to filter. Events expire after 30 days — this is a delivery feed, not the compliance audit trail (use /audit-logs for that).',
  useWhen:
    'Your integration cannot receive webhooks (no public HTTPS endpoint) and needs to poll for invoice/transaction/booking events.',
  doNotUseFor:
    'Compliance auditing (30-day TTL — use /audit-logs). Real-time delivery (webhooks are pushed within seconds).',
  pitfalls: [
    'Persist the highest `sequence` you have processed and pass it as ?after on the next poll — sequences are strictly increasing.',
    'Events older than 30 days are deleted by the retention cron.',
  ],
  example: {
    response: {
      data: {
        events: [
          {
            sequence: 12345,
            event_type: 'invoice.paid',
            entity_id: 'aa11…',
            data: { invoice_number: 'F-2026-0042' },
            created_at: '2026-07-01T10:00:00Z',
          },
        ],
        last_sequence: 12345,
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'events:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: {
    success: z.object({
      events: z.array(EventRow),
      last_sequence: z.number().nullable(),
    }),
  },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'events.list',
  async (request, ctx) => {
    const url = new URL(request.url)
    const Filters = z.object({
      after: z.coerce.number().int().nonnegative().optional(),
      event_type: z.string().max(100).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    })
    const parsed = Filters.safeParse({
      after: url.searchParams.get('after') ?? undefined,
      event_type: url.searchParams.get('event_type') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
    })
    if (!parsed.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        },
      })
    }
    const f = parsed.data
    const limit = f.limit ?? 100

    let query = ctx.supabase
      .from('event_log')
      .select('sequence, event_type, entity_id, data, created_at')
      .eq('company_id', ctx.companyId!)
      .order('sequence', { ascending: true })
      .limit(limit)

    if (f.after != null) query = query.gt('sequence', f.after)
    if (f.event_type) query = query.eq('event_type', f.event_type)

    const { data, error } = await query
    if (error) return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })

    const rows = (data ?? []) as Array<{ sequence: number }>
    const lastSequence = rows.length > 0 ? rows[rows.length - 1].sequence : null

    return ok({ events: data ?? [], last_sequence: lastSequence }, { requestId: ctx.requestId })
  },
)
