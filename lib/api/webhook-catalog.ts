import { WEBHOOK_EVENT_CATALOG } from '@/lib/webhooks/event-catalog'

/**
 * Back-compat export — the canonical catalog now lives in
 * lib/webhooks/event-catalog.ts (single source of truth for the delivery
 * handler, registration validation and the /webhook-events endpoint).
 */
export const NORDKLART_WEBHOOK_EVENTS: readonly string[] =
  WEBHOOK_EVENT_CATALOG.map((e) => e.type)
