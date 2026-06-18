import { NextResponse } from 'next/server'
import { verifyStripeWebhookSignature } from '@/lib/billing/stripe'
import { createServiceClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type StripeObject = {
  id?: string
  customer?: string | null
  subscription?: string | null
  invoice?: string | null
  payment_status?: string | null
  amount_subtotal?: number | null
  amount_total?: number | null
  total_details?: { amount_tax?: number | null } | null
  currency?: string | null
  metadata?: Record<string, string | undefined>
  status?: string | null
  current_period_start?: number | null
  current_period_end?: number | null
  items?: { data?: Array<{ price?: { id?: string | null } | null }> }
  parent?: { subscription_details?: { subscription?: string | null } | null } | null
  amount_paid?: number | null
  hosted_invoice_url?: string | null
  invoice_pdf?: string | null
  created?: number | null
  cancel_at_period_end?: boolean | null
}

type StripeEvent = {
  id: string
  type: string
  livemode?: boolean
  api_version?: string | null
  data?: { object?: StripeObject }
}

function companyIdFromMetadata(metadata?: Record<string, string | undefined>) {
  const candidate = metadata?.nordklart_company_id || null
  return candidate && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)
    ? candidate
    : null
}

function toIso(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value * 1000).toISOString() : null
}

function subscriptionIdFromObject(object: StripeObject) {
  return object.subscription || object.parent?.subscription_details?.subscription || null
}

export async function POST(request: Request) {
  const rawBody = await request.text()
  if (!verifyStripeWebhookSignature(rawBody, request.headers.get('stripe-signature'))) {
    return NextResponse.json({ error: 'Invalid Stripe signature.' }, { status: 400 })
  }

  let event: StripeEvent
  try {
    event = JSON.parse(rawBody) as StripeEvent
  } catch {
    return NextResponse.json({ error: 'Invalid payload.' }, { status: 400 })
  }
  if (!event.id || !event.type) return NextResponse.json({ error: 'Invalid Stripe event.' }, { status: 400 })

  const service = createServiceClient()
  const object = event.data?.object || {}
  if (!object.id) return NextResponse.json({ error: 'Stripe event object is missing an id.' }, { status: 400 })
  const companyId = companyIdFromMetadata(object.metadata)

  const { data: existing, error: existingError } = await service
    .from('stripe_webhook_events')
    .select('id, status, attempt_count')
    .eq('stripe_event_id', event.id)
    .maybeSingle()
  if (existingError) return NextResponse.json({ error: 'Webhook storage unavailable.' }, { status: 500 })

  if (existing?.status === 'processed' || existing?.status === 'ignored') {
    return NextResponse.json({ received: true, duplicate: true })
  }

  if (existing) {
    const { error } = await service
      .from('stripe_webhook_events')
      .update({ status: 'received', processing_error: null, attempt_count: existing.attempt_count + 1, payload: event, company_id: companyId })
      .eq('id', existing.id)
    if (error) return NextResponse.json({ error: 'Webhook retry could not be recorded.' }, { status: 500 })
  } else {
    const { error } = await service.from('stripe_webhook_events').insert({
      stripe_event_id: event.id,
      event_type: event.type,
      livemode: event.livemode ?? null,
      stripe_api_version: event.api_version ?? null,
      company_id: companyId,
      payload: event,
    })
    if (error) return NextResponse.json({ error: 'Webhook could not be stored.' }, { status: 500 })
  }

  try {
    let ignored = false
    if (event.type === 'checkout.session.completed') {
      await service.rpc('stripe_finalize_checkout_v2', {
        p_stripe_event_id: event.id,
        p_stripe_checkout_session_id: object.id,
        p_stripe_customer_id: object.customer || null,
        p_stripe_subscription_id: subscriptionIdFromObject(object),
        p_payment_status: object.payment_status || null,
        p_amount_subtotal_minor: object.amount_subtotal ?? null,
        p_amount_tax_minor: object.total_details?.amount_tax ?? null,
        p_amount_total_minor: object.amount_total ?? null,
        p_currency: object.currency || null,
        p_stripe_invoice_id: typeof object.invoice === 'string' ? object.invoice : null,
      }).throwOnError()
    } else if (event.type === 'checkout.session.expired') {
      await service.rpc('stripe_mark_checkout_expired', {
        p_stripe_event_id: event.id,
        p_stripe_checkout_session_id: object.id,
      }).throwOnError()
    } else if (event.type.startsWith('customer.subscription.')) {
      const priceId = object.items?.data?.[0]?.price?.id || null
      await service.rpc('stripe_sync_subscription_v2', {
        p_stripe_event_id: event.id,
        p_stripe_subscription_id: object.id,
        p_stripe_customer_id: object.customer || null,
        p_stripe_status: object.status || 'paused',
        p_stripe_price_id: priceId,
        p_current_period_start: toIso(object.current_period_start),
        p_current_period_end: toIso(object.current_period_end),
        p_cancel_at_period_end: object.cancel_at_period_end === true,
      }).throwOnError()
    } else if (event.type.startsWith('invoice.')) {
      await service.rpc('stripe_record_invoice_event_v2', {
        p_stripe_event_id: event.id,
        p_stripe_invoice_id: object.id,
        p_stripe_customer_id: object.customer || null,
        p_stripe_subscription_id: subscriptionIdFromObject(object),
        p_invoice_status: object.status || event.type.replace('invoice.', ''),
        p_amount_subtotal_minor: object.amount_subtotal ?? null,
        p_amount_tax_minor: object.total_details?.amount_tax ?? null,
        p_amount_total_minor: object.amount_paid ?? object.amount_total ?? null,
        p_currency: object.currency || null,
        p_hosted_invoice_url: object.hosted_invoice_url || null,
        p_invoice_pdf_url: object.invoice_pdf || null,
        p_invoice_date: toIso(object.created),
      }).throwOnError()
    } else {
      ignored = true
    }

    const { error } = await service
      .from('stripe_webhook_events')
      .update({ status: ignored ? 'ignored' : 'processed', processed_at: new Date().toISOString(), processing_error: null })
      .eq('stripe_event_id', event.id)
    if (error) throw error

    return NextResponse.json({ received: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Webhook processing failed.'
    await service
      .from('stripe_webhook_events')
      .update({ status: 'failed', processing_error: message.slice(0, 1000) })
      .eq('stripe_event_id', event.id)
    return NextResponse.json({ error: 'Webhook processing failed.' }, { status: 500 })
  }
}
