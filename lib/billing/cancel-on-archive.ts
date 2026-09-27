import type { SupabaseClient } from '@supabase/supabase-js'
import { isStripeConfigured, scheduleStripeSubscriptionCancellation } from '@/lib/billing/stripe'
import { createLogger } from '@/lib/logger'

const log = createLogger('billing/cancel-on-archive')

const LIVE_STATUSES = ['trialing', 'active', 'past_due', 'paused']

/**
 * Stop Stripe from renewing the subscriptions of a company that was archived.
 * Cancellation takes effect at period end: the customer keeps what they
 * already paid for. Failures are recorded as billing events for the platform
 * team instead of blocking the archive. `service` must be a service-role client.
 */
export async function cancelStripeBillingForArchivedCompany(
  service: SupabaseClient,
  companyId: string,
  actorUserId: string,
): Promise<{ scheduled: string[]; failed: string[] }> {
  const result = { scheduled: [] as string[], failed: [] as string[] }
  if (!isStripeConfigured()) return result

  const [{ data: bases }, { data: items }] = await Promise.all([
    service
      .from('company_subscriptions')
      .select('external_subscription_id')
      .eq('company_id', companyId)
      .eq('external_provider', 'stripe')
      .eq('cancel_at_period_end', false)
      .in('status', LIVE_STATUSES),
    service
      .from('company_subscription_items')
      .select('external_subscription_item_id')
      .eq('company_id', companyId)
      .eq('external_provider', 'stripe')
      .eq('cancel_at_period_end', false)
      .in('status', LIVE_STATUSES),
  ])

  const ids = new Set<string>([
    ...(bases ?? []).map((row) => row.external_subscription_id as string | null),
    ...(items ?? []).map((row) => row.external_subscription_item_id as string | null),
  ].filter((id): id is string => Boolean(id)))

  for (const subscriptionId of ids) {
    try {
      await scheduleStripeSubscriptionCancellation({
        subscriptionId,
        metadata: { nordklart_company_id: companyId, nordklart_cancel_reason: 'company_archived' },
        idempotencyKey: `nordklart-archive-cancel-${companyId}-${subscriptionId}`,
      })
      result.scheduled.push(subscriptionId)
    } catch (error) {
      result.failed.push(subscriptionId)
      log.error('could not schedule Stripe cancellation for archived company', {
        companyId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (ids.size > 0) {
    await service.from('billing_events').insert({
      company_id: companyId,
      event_type: result.failed.length ? 'stripe.archive_cancel_failed' : 'stripe.archive_cancel_scheduled',
      source_table: 'companies',
      currency: 'SEK',
      metadata: { scheduled: result.scheduled, failed: result.failed, actor_user_id: actorUserId },
    }).then(() => undefined, () => undefined)
  }

  return result
}
