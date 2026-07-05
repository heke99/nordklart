/**
 * Webhook event-bus handler.
 *
 * Subscribes to every CoreEventType the v1 API surface emits and converts
 * each emission into N rows in `webhook_deliveries` — one per active webhook
 * subscribed to (company_id, event_type). The dispatcher cron picks them
 * up at next-minute boundary and POSTs to the receiver.
 *
 * Wired from lib/init.ts via registerWebhookHandler() so every API route
 * that calls ensureInitialized() gets the subscription wired exactly once.
 *
 * Design notes:
 *   - We do NOT block the emitting route on delivery insert: the handler
 *     runs inside Promise.allSettled in the bus (see lib/events/bus.ts), so
 *     a DB insert failure is logged but doesn't crash the emitter.
 *   - We capture `previous_attributes` only for events whose payload carries
 *     both a prior and current shape. Phase 6 PR-1 emits null for everything
 *     — adding the diff is a follow-up that requires touching each route's
 *     emit() call site to capture the prior row.
 *   - Service-role client because this code runs from the bus, outside any
 *     authenticated Supabase context.
 */

import { eventBus } from '@/lib/events/bus'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createLogger } from '@/lib/logger'
import { API_V1_VERSION } from '@/lib/api/v1/version'
import { DELIVERED_WEBHOOK_EVENTS } from '@/lib/webhooks/event-catalog'

const log = createLogger('webhooks/handler')

/**
 * The set of event types the v1 webhook surface delivers now derives from
 * the SINGLE catalog in lib/webhooks/event-catalog.ts (delivered=true
 * entries) — the registration route and the /webhook-events endpoint read
 * the same catalog, so the three surfaces can never drift again.
 *
 * Adding a new event type to the catalog is a public-API change — bump
 * API_V1_VERSION + add to the changelog when you do.
 */
const PUBLIC_WEBHOOK_EVENTS = DELIVERED_WEBHOOK_EVENTS

let registered = false

/**
 * Subscribe the webhook handler to every event in PUBLIC_WEBHOOK_EVENTS.
 * Idempotent — safe to call from ensureInitialized() across hot reloads.
 */
export function registerWebhookHandler(): void {
  if (registered) return
  registered = true

  for (const eventType of PUBLIC_WEBHOOK_EVENTS) {
    eventBus.on(eventType, async (payload) => {
      // payload type depends on eventType but every variant carries
      // companyId — the only field we structurally need here.
      const companyId = (payload as { companyId?: string }).companyId
      if (!companyId) {
        // Surface as an error: every CoreEvent payload variant types
        // companyId as required, so a missing value indicates an emit-site
        // bug that silently breaks webhook delivery for that event. Logging
        // at error level ensures it shows up in monitoring rather than
        // disappearing into routine warn-noise.
        log.error('event missing companyId — webhook fanout skipped', new Error('missing companyId'), { eventType })
        return
      }

      try {
        // Emit sites that mutate an existing resource may attach a
        // Stripe-style `previousAttributes` diff (see lib/webhooks/diff.ts).
        // It is delivered in the delivery row's previous_attributes column,
        // not inside the payload body.
        const previousAttributes =
          (payload as { previousAttributes?: Record<string, unknown> | null }).previousAttributes ?? null

        await fanOutToWebhooks({
          eventType,
          companyId,
          payload: minimisePayload(payload as Record<string, unknown>),
          previousAttributes,
        })
      } catch (err) {
        log.error('webhook fanout failed', err as Error, { eventType, companyId })
      }
    })
  }

  log.info('webhook handler registered', { eventCount: PUBLIC_WEBHOOK_EVENTS.size })
}

/**
 * Drop fields from the in-process event payload that have no value to an
 * external webhook receiver. Currently strips:
 *   - userId: an internal Supabase auth.users.id UUID — no value to the
 *     receiver, identifies the nordklart-side actor not the resource. The
 *     companyId stays (it's the tenant scope, useful for multi-tenant
 *     receivers).
 *
 * Centralising the projection here means a future tightening (e.g.
 * stripping personnummer fields from payroll payloads) lands in one
 * place rather than per-emit-site. GDPR Art.5(1)(c) data minimisation.
 */
export function minimisePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'userId') continue
    // Delivered separately in the delivery row's previous_attributes column —
    // never duplicated inside the payload body.
    if (key === 'previousAttributes') continue
    // Batch events (transaction.synced) carry the full row array in-process;
    // externally we deliver a summary (count + ids) — receivers fetch details
    // via GET /transactions. Keeps webhook bodies bounded.
    if (key === 'transactions' && Array.isArray(value)) {
      projected.transaction_count = value.length
      projected.transaction_ids = value
        .map((t) => (t as { id?: string }).id)
        .filter(Boolean)
        .slice(0, 100)
      continue
    }
    projected[key] = value
  }
  return projected
}

/**
 * Look up active webhooks for (companyId, eventType) and insert one
 * webhook_deliveries row per match. Pending rows are picked up by the
 * dispatcher cron at next-minute boundary.
 */
async function fanOutToWebhooks(args: {
  eventType: string
  companyId: string
  payload: Record<string, unknown>
  previousAttributes?: Record<string, unknown> | null
}): Promise<void> {
  const supabase = createServiceClientNoCookies()

  const { data: webhooks, error: fetchErr } = await supabase
    .from('webhooks')
    .select('id, secret, api_version_pinned')
    .eq('company_id', args.companyId)
    .eq('event_type', args.eventType)
    .eq('active', true)
    .is('disabled_at', null)

  if (fetchErr) {
    log.error('webhook lookup failed', fetchErr as Error, {
      companyId: args.companyId,
      eventType: args.eventType,
    })
    return
  }
  if (!webhooks || webhooks.length === 0) return

  // Synthesise a correlation id for the fanout batch. The event bus is
  // async — by the time we reach here the originating route's request
  // context is gone, so we can't recover the live request_id. A fresh
  // 'whfan_<uuid>' keeps the BFNAR 2013:2 kap 8 § behandlingshistorik
  // requirement satisfied (the column is never NULL on a fresh insert)
  // and lets a per-fanout audit query group the rows that came from the
  // same emission. Threading the originating request_id into the event
  // payload itself is a future-direction improvement.
  const fanoutId = `whfan_${crypto.randomUUID()}`

  const rows = webhooks.map((w) => ({
    webhook_id: (w as { id: string }).id,
    company_id: args.companyId,
    event_type: args.eventType,
    payload: args.payload,
    api_version: (w as { api_version_pinned: string }).api_version_pinned ?? API_V1_VERSION,
    // Populated when the emit site attached a previousAttributes diff
    // (update-style events); null for pure "created" events.
    previous_attributes: args.previousAttributes ?? null,
    request_id: fanoutId,
  }))

  const { error: insertErr } = await supabase.from('webhook_deliveries').insert(rows)
  if (insertErr) {
    log.error('webhook_deliveries insert failed', insertErr as Error, {
      companyId: args.companyId,
      eventType: args.eventType,
      webhookCount: rows.length,
    })
  }
}
