/**
 * Unified push notification send pipeline.
 *
 * Both event handlers and the cron scheduler call `sendNotificationToUser()`.
 * This module owns the full chain:
 *   settings check -> quiet hours -> duplicate check -> send -> log -> cleanup
 */

import webpush from 'web-push'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { NotificationSettings, NotificationType } from '@/types'

// ============================================================
// VAPID configuration
// ============================================================

const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY
const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:support@nordklart.se'

if (
  vapidPublicKey &&
  vapidPrivateKey &&
  !vapidPublicKey.startsWith('__')
) {
  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey)
}

// ============================================================
// Types
// ============================================================

export interface PushSubscriptionKeys {
  endpoint: string
  p256dh: string
  auth: string
}

export interface NotificationPayload {
  title: string
  body: string
  icon?: string
  badge?: string
  tag?: string
  data?: {
    url?: string
    type?: string
    id?: string
  }
  actions?: Array<{
    action: string
    title: string
    icon?: string
  }>
}

// ============================================================
// Public API
// ============================================================

/**
 * Get the public VAPID key for client-side subscription.
 */
export function getVapidPublicKey(): string | null {
  return vapidPublicKey || null
}

/**
 * Send a notification to a specific user.
 *
 * Performs the full pipeline:
 * 1. Check push_enabled in notification_settings
 * 2. Check quiet hours
 * 3. Check duplicate via notification_log
 * 4. Get user's push subscriptions
 * 5. Send via web-push
 * 6. Log to notification_log
 * 7. Disable gone subscriptions (410)
 *
 * Returns { sent: boolean, reason?: string }
 */
export async function sendNotificationToUser(
  supabase: SupabaseClient,
  userId: string,
  payload: NotificationPayload,
  notificationType: NotificationType,
  referenceId: string,
  daysBefore: number = 0
): Promise<{ sent: boolean; reason?: string }> {
  try {
    // 1. Check notification settings
    const settings = await getUserNotificationSettings(supabase, userId)

    if (settings && !settings.push_enabled) {
      return { sent: false, reason: 'push_disabled' }
    }

    // 2. Check quiet hours
    if (settings && isWithinQuietHours(settings)) {
      return { sent: false, reason: 'quiet_hours' }
    }

    // 3. Check duplicate
    const alreadySent = await wasNotificationSent(
      supabase,
      userId,
      notificationType,
      referenceId,
      daysBefore
    )
    if (alreadySent) {
      return { sent: false, reason: 'duplicate' }
    }

    // 4. Get subscriptions
    const subscriptions = await getUserSubscriptions(supabase, userId)
    if (subscriptions.length === 0) {
      return { sent: false, reason: 'no_subscriptions' }
    }

    // 5. Send
    const result = await sendPushToMultiple(subscriptions, payload)

    // 6. Log
    await logNotification(supabase, userId, notificationType, referenceId, daysBefore)

    // 7. Cleanup gone subscriptions
    if (result.goneSubscriptions.length > 0) {
      await disableGoneSubscriptions(supabase, result.goneSubscriptions)
    }

    return result.successful > 0
      ? { sent: true }
      : { sent: false, reason: 'send_failed' }
  } catch (error) {
    console.error(`[push-notifications] sendNotificationToUser failed for ${userId}:`, error)
    return { sent: false, reason: 'error' }
  }
}

// ============================================================
// Internal helpers
// ============================================================

async function sendPushNotification(
  subscription: PushSubscriptionKeys,
  payload: NotificationPayload
): Promise<{ success: boolean; error?: string }> {
  if (!vapidPublicKey || !vapidPrivateKey) {
    console.error('VAPID keys not configured')
    return { success: false, error: 'VAPID keys not configured' }
  }

  const pushSubscription = {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: subscription.p256dh,
      auth: subscription.auth,
    },
  }

  try {
    await webpush.sendNotification(pushSubscription, JSON.stringify(payload), {
      TTL: 86400,
      urgency: 'normal',
    })
    return { success: true }
  } catch (error: unknown) {
    const err = error as { statusCode?: number; message?: string }
    if (err.statusCode === 410) {
      return { success: false, error: 'subscription_gone' }
    }
    console.error('Push notification error:', err)
    return { success: false, error: err.message || 'Unknown error' }
  }
}

async function sendPushToMultiple(
  subscriptions: PushSubscriptionKeys[],
  payload: NotificationPayload
): Promise<{ successful: number; failed: number; goneSubscriptions: string[] }> {
  let successful = 0
  let failed = 0
  const goneSubscriptions: string[] = []

  const results = await Promise.allSettled(
    subscriptions.map((sub) => sendPushNotification(sub, payload))
  )

  results.forEach((result, index) => {
    if (result.status === 'fulfilled' && result.value.success) {
      successful++
    } else {
      failed++
      if (result.status === 'fulfilled' && result.value.error === 'subscription_gone') {
        goneSubscriptions.push(subscriptions[index].endpoint)
      }
    }
  })

  return { successful, failed, goneSubscriptions }
}

export function isWithinQuietHours(
  settings: NotificationSettings,
  now: Date = new Date()
): boolean {
  const swedenTime = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now)

  const [hours, minutes] = swedenTime.split(':').map(Number)
  const currentMinutes = hours * 60 + minutes

  const [startHours, startMinutes] = settings.quiet_start.split(':').map(Number)
  const [endHours, endMinutes] = settings.quiet_end.split(':').map(Number)

  const quietStartMinutes = startHours * 60 + startMinutes
  const quietEndMinutes = endHours * 60 + endMinutes

  if (quietStartMinutes > quietEndMinutes) {
    return currentMinutes >= quietStartMinutes || currentMinutes < quietEndMinutes
  }

  return currentMinutes >= quietStartMinutes && currentMinutes < quietEndMinutes
}

async function wasNotificationSent(
  supabase: SupabaseClient,
  userId: string,
  notificationType: NotificationType,
  referenceId: string,
  daysBefore: number
): Promise<boolean> {
  const { data } = await supabase
    .from('notification_log')
    .select('id')
    .eq('company_id', userId)
    .eq('notification_type', notificationType)
    .eq('reference_id', referenceId)
    .eq('days_before', daysBefore)
    .single()

  return !!data
}

async function logNotification(
  supabase: SupabaseClient,
  userId: string,
  notificationType: NotificationType,
  referenceId: string,
  daysBefore: number
): Promise<void> {
  await supabase.from('notification_log').insert({
    user_id: userId,
    notification_type: notificationType,
    reference_id: referenceId,
    days_before: daysBefore,
    delivery_status: 'sent',
  })
}

export async function getUserSubscriptions(
  supabase: SupabaseClient,
  userId: string
): Promise<PushSubscriptionKeys[]> {
  const { data } = await supabase
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth')
    .eq('company_id', userId)
    .eq('is_active', true)

  return data || []
}

export async function getUserNotificationSettings(
  supabase: SupabaseClient,
  userId: string
): Promise<NotificationSettings | null> {
  const { data } = await supabase
    .from('notification_settings')
    .select('*')
    .eq('company_id', userId)
    .single()

  return data
}

async function disableGoneSubscriptions(
  supabase: SupabaseClient,
  endpoints: string[]
): Promise<void> {
  if (endpoints.length === 0) return

  await supabase
    .from('push_subscriptions')
    .update({ is_active: false })
    .in('endpoint', endpoints)
}
