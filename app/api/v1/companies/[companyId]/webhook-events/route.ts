import { z } from 'zod'
import { paginated } from '@/lib/api/v1/response'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse } from '@/lib/api/v1/errors'

const WebhookEvent = z.object({
  code: z.string(),
  category: z.string(),
  description: z.string(),
  status: z.string(),
})

registerEndpoint({
  operation: 'webhook_events.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/webhook-events',
  summary: 'List supported webhook events.',
  description: 'Returns Nordklart webhook event catalog for API clients.',
  useWhen: 'You need to configure or document webhook subscriptions.',
  doNotUseFor: 'Listing deliveries for a specific endpoint; use the webhooks deliveries endpoint.',
  pitfalls: ['The event catalog is global, but access is still authenticated and tenant-scoped through the API key.', 'Payload schemas can evolve with the v1 API version.'],
  example: { response: { data: [{ code: 'year_end.started', category: 'year_end', status: 'active' }], meta: { request_id: 'req_…', api_version: '2026-05-12' } } },
  scope: 'webhook_events:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: z.object({ events: z.array(WebhookEvent) }) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>('webhook_events.list', async (_request, ctx) => {
  const { data, error } = await ctx.supabase
    .from('webhook_events')
    .select('code,category,description,status')
    .eq('status', 'active')
    .order('category')
    .order('code')
  if (error) return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
  return paginated(data ?? [], { requestId: ctx.requestId })
})
