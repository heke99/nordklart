import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { generateWebhookSecret } from '@/lib/webhooks/signing'
import { validateWebhookUrl } from '@/lib/webhooks/url-guard'
import { SUBSCRIBABLE_WEBHOOK_EVENTS, WEBHOOK_EVENT_CATALOG } from '@/lib/webhooks/event-catalog'
import { API_V1_VERSION } from '@/lib/api/v1/version'

ensureInitialized()

/**
 * Dashboard webhook management (Settings → Webhooks).
 *
 * GET  — list the company's webhooks (secret NEVER included) + the 25 most
 *        recent deliveries + the event catalog.
 * POST — create a webhook. The signing secret is returned EXACTLY ONCE in
 *        the response; store it in your receiver.
 *
 * Mirrors the v1 API surface (same validation, same SSRF guard) so
 * dashboard-created and API-created webhooks behave identically.
 */

const CreateSchema = z.object({
  name: z.string().min(1).max(120),
  event_type: z.string().refine((v) => SUBSCRIBABLE_WEBHOOK_EVENTS.includes(v), {
    message: 'Okänd händelsetyp',
  }),
  webhook_url: z
    .string()
    .url()
    .max(2048)
    .refine((u) => u.startsWith('https://'), { message: 'Webhook-URL måste använda https://' }),
})

export const GET = withRouteContext(
  'webhook.manage.list',
  async (_request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const [{ data: webhooks, error: whErr }, { data: deliveries, error: delErr }] = await Promise.all([
      supabase
        .from('webhooks')
        .select('id, name, event_type, webhook_url, active, disabled_at, disabled_reason, api_version_pinned, created_at')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
        .limit(100),
      supabase
        .from('webhook_deliveries')
        .select('id, webhook_id, event_type, status, attempts, next_attempt_at, response_status, error, created_at, delivered_at')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
        .limit(25),
    ])

    if (whErr) return errorResponse(whErr, log, { requestId })
    if (delErr) return errorResponse(delErr, log, { requestId })

    return NextResponse.json({
      data: {
        webhooks: webhooks ?? [],
        deliveries: deliveries ?? [],
        catalog: WEBHOOK_EVENT_CATALOG.map((e) => ({
          type: e.type,
          delivered: e.delivered,
          description: e.description_sv,
        })),
      },
    })
  },
)

export const POST = withRouteContext(
  'webhook.manage.create',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, CreateSchema, {
      log,
      operation: 'webhook.manage.create',
    })
    if (!validation.success) return validation.response
    const body = validation.data

    // SSRF guard: same DNS + private-IP rejection as the v1 API.
    const urlCheck = await validateWebhookUrl(body.webhook_url)
    if (!urlCheck.ok) {
      return NextResponse.json(
        { error: `Webhook-URL:en avvisades: ${urlCheck.reason}` },
        { status: 400 },
      )
    }

    const secret = generateWebhookSecret()
    const { data: webhook, error } = await supabase
      .from('webhooks')
      .insert({
        company_id: companyId,
        name: body.name,
        event_type: body.event_type,
        webhook_url: body.webhook_url,
        secret,
        api_version_pinned: API_V1_VERSION,
        active: true,
      })
      .select('id, name, event_type, webhook_url, active, created_at')
      .single()

    if (error) {
      log.error('webhook create failed', error)
      return errorResponse(error, log, { requestId })
    }

    await supabase.from('audit_log').insert({
      user_id: user.id,
      company_id: companyId,
      action: 'INSERT',
      table_name: 'webhooks',
      record_id: (webhook as { id: string }).id,
      actor_id: user.id,
      description: `Webhook skapad via inställningar: ${body.name} (${body.event_type})`,
      new_state: { event_type: body.event_type, webhook_url: body.webhook_url },
    })

    return NextResponse.json({
      data: {
        webhook,
        // Returned exactly once — never stored readable again.
        secret,
      },
    })
  },
  { requireWrite: true },
)
