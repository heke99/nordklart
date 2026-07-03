import { z } from 'zod'
import { paginated } from '@/lib/api/v1/response'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { WEBHOOK_EVENT_CATALOG } from '@/lib/webhooks/event-catalog'

const WebhookEvent = z.object({
  code: z.string(),
  delivered: z.boolean(),
  description: z.string(),
  status: z.string(),
})

registerEndpoint({
  operation: 'webhook_events.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/webhook-events',
  summary: 'List supported webhook events.',
  description:
    'Returns the canonical webhook event catalog (the same catalog the delivery handler and registration validation use). `delivered=true` events fan out today; `delivered=false` are subscribable but planned — subscriptions become active without re-registration when delivery ships.',
  useWhen: 'You need to configure or document webhook subscriptions.',
  doNotUseFor: 'Listing deliveries for a specific endpoint; use the webhooks deliveries endpoint.',
  pitfalls: [
    'Subscribe only to delivered=true events if you rely on receiving them today.',
    'Payload schemas can evolve with the v1 API version.',
  ],
  example: { response: { data: [{ code: 'invoice.paid', delivered: true, status: 'active' }], meta: { request_id: 'req_…', api_version: '2026-05-12' } } },
  scope: 'webhook_events:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: z.object({ events: z.array(WebhookEvent) }) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>('webhook_events.list', async (_request, ctx) => {
  const events = WEBHOOK_EVENT_CATALOG.map((e) => ({
    code: e.type,
    delivered: e.delivered,
    description: e.description_sv,
    status: e.delivered ? 'active' : 'planned',
  }))
  return paginated(events, { requestId: ctx.requestId })
})
