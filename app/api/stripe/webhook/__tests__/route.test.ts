/**
 * Stripe webhook: signature enforcement + event-id idempotency. A duplicate
 * delivery of a processed event must be acknowledged without re-running any
 * finalization RPC (no duplicate purchases/subscription writes).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  parseJsonResponse,
  supabaseServerMock,
} from '@/tests/helpers'

const verifySignatureMock = vi.fn()
const retrieveSubscriptionMock = vi.fn()
const cancelSubscriptionMock = vi.fn()
vi.mock('@/lib/billing/stripe', async () => {
  const actual = await vi.importActual<typeof import('@/lib/billing/stripe')>('@/lib/billing/stripe')
  return {
    verifyStripeWebhookSignature: (...args: unknown[]) => verifySignatureMock(...args),
    retrieveStripeSubscription: (...args: unknown[]) => retrieveSubscriptionMock(...args),
    cancelStripeSubscription: (...args: unknown[]) => cancelSubscriptionMock(...args),
    isStripeLiveMode: actual.isStripeLiveMode,
    stripeSubscriptionPeriod: actual.stripeSubscriptionPeriod,
  }
})

let existingEventRow: Record<string, unknown> | null = null
let claimSucceeds = true
let liveBaseSubscriptions: Array<{ external_subscription_id: string }> = []
let rpcResult: unknown = null
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = []
const eventWrites: Array<Record<string, unknown>> = []

const mockService = {
  from: (table: string) => {
    const chain: Record<string, unknown> = {}
    chain.select = () => chain
    chain.eq = () => chain
    chain.in = async () => ({ data: table === 'company_subscriptions' ? liveBaseSubscriptions : [], error: null })
    chain.maybeSingle = async () => ({ data: table === 'stripe_webhook_events' ? existingEventRow : null, error: null })
    chain.insert = (row: Record<string, unknown>) => {
      eventWrites.push({ table, kind: 'insert', ...row })
      return Promise.resolve({ data: null, error: null })
    }
    chain.update = (row: Record<string, unknown>) => {
      eventWrites.push({ table, kind: 'update', ...row })
      const updateChain: Record<string, unknown> = {}
      updateChain.eq = () => updateChain
      updateChain.or = () => updateChain
      updateChain.select = () => updateChain
      updateChain.maybeSingle = async () => ({ data: claimSucceeds ? { id: 'row-1' } : null, error: null })
      updateChain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
      return updateChain
    }
    return chain
  },
  rpc: (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args })
    return { throwOnError: async () => ({ data: rpcResult, error: null }) }
  },
}

vi.mock('@/lib/supabase/server', () => supabaseServerMock({ serviceClient: () => mockService }))

import { POST } from '../route'

function webhookRequest(event: Record<string, unknown>) {
  return new Request('http://localhost:3000/api/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 't=1,v1=abc', 'content-type': 'application/json' },
    body: JSON.stringify(event),
  })
}

const completedEvent = {
  id: 'evt_1',
  type: 'checkout.session.completed',
  data: { object: { id: 'cs_1', customer: 'cus_1', payment_status: 'paid', metadata: { nordklart_company_id: '33333333-3333-4333-8333-333333333333' } } },
}

describe('POST /api/stripe/webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    existingEventRow = null
    claimSucceeds = true
    liveBaseSubscriptions = []
    rpcResult = null
    retrieveSubscriptionMock.mockRejectedValue(new Error('offline'))
    cancelSubscriptionMock.mockResolvedValue({})
    rpcCalls.length = 0
    eventWrites.length = 0
    verifySignatureMock.mockReturnValue(true)
  })

  it('rejects requests with an invalid signature', async () => {
    verifySignatureMock.mockReturnValue(false)
    const response = await POST(webhookRequest(completedEvent))
    expect(response.status).toBe(400)
    expect(rpcCalls).toHaveLength(0)
  })

  it('finalizes a completed checkout exactly once', async () => {
    const response = await POST(webhookRequest(completedEvent))
    const { status, body } = await parseJsonResponse<{ received: boolean }>(response)

    expect(status).toBe(200)
    expect(body.received).toBe(true)
    // A completed checkout runs finalization and then the one-time purchase
    // lifecycle, each exactly once and in that order.
    expect(rpcCalls.map((call) => call.fn)).toEqual([
      'stripe_finalize_checkout_v2',
      'stripe_apply_one_time_purchase_event',
    ])
    expect(rpcCalls[0].args).toMatchObject({
      p_stripe_event_id: 'evt_1',
      p_stripe_checkout_session_id: 'cs_1',
      p_payment_status: 'paid',
    })
    expect(rpcCalls[1].args).toMatchObject({
      p_stripe_event_id: 'evt_1',
      p_event_type: 'checkout.session.completed',
      p_checkout_session_id: 'cs_1',
      p_payment_status: 'paid',
    })
  })

  it('acknowledges a duplicate processed event WITHOUT re-running finalization', async () => {
    existingEventRow = { id: 'row-1', status: 'processed', attempt_count: 1 }

    const response = await POST(webhookRequest(completedEvent))
    const { status, body } = await parseJsonResponse<{ duplicate?: boolean }>(response)

    expect(status).toBe(200)
    expect(body.duplicate).toBe(true)
    expect(rpcCalls).toHaveLength(0)
    expect(eventWrites).toHaveLength(0)
  })

  it('retries a previously failed event (attempt count bumped, RPC re-run)', async () => {
    existingEventRow = { id: 'row-1', status: 'failed', attempt_count: 1 }

    const response = await POST(webhookRequest(completedEvent))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(rpcCalls.map((call) => call.fn)).toEqual([
      'stripe_finalize_checkout_v2',
      'stripe_apply_one_time_purchase_event',
    ])
    const retryWrite = eventWrites.find((w) => w.kind === 'update' && w.attempt_count === 2)
    expect(retryWrite).toBeTruthy()
  })

  it('marks unknown event types as ignored without side effects', async () => {
    const response = await POST(webhookRequest({ id: 'evt_2', type: 'charge.refund.updated', data: { object: { id: 'ch_1' } } }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(rpcCalls).toHaveLength(0)
    const finalWrite = eventWrites.find((w) => w.kind === 'update' && w.status === 'ignored')
    expect(finalWrite).toBeTruthy()
  })

  it('routes subscription events through stripe_sync_subscription_v3 with the event time', async () => {
    rpcResult = { applied: true }
    const response = await POST(webhookRequest({
      id: 'evt_3',
      type: 'customer.subscription.updated',
      created: 1790000000,
      data: { object: { id: 'sub_1', customer: 'cus_1', status: 'incomplete' } },
    }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(rpcCalls[0].fn).toBe('stripe_sync_subscription_v3')
    expect(rpcCalls[0].args).toMatchObject({
      p_stripe_status: 'incomplete',
      p_event_created_at: new Date(1790000000 * 1000).toISOString(),
    })
  })

  it('syncs the subscription as Stripe has it now, with the post-basil period shape', async () => {
    rpcResult = { applied: true }
    retrieveSubscriptionMock.mockResolvedValue({
      id: 'sub_1', customer: 'cus_1', status: 'active', cancel_at_period_end: false,
      items: { data: [{ id: 'si_1', price: { id: 'price_1' }, current_period_start: 1790000000, current_period_end: 1792592000 }] },
    })
    await POST(webhookRequest({
      id: 'evt_4', type: 'customer.subscription.updated', created: 1790000000,
      data: { object: { id: 'sub_1', customer: 'cus_1', status: 'past_due' } },
    }))
    expect(rpcCalls[0].args).toMatchObject({
      p_stripe_status: 'active',
      p_stripe_price_id: 'price_1',
      p_current_period_end: new Date(1792592000 * 1000).toISOString(),
    })
  })

  it('fails (so Stripe retries) when a Nordklart subscription is not recorded yet', async () => {
    rpcResult = { applied: false, reason: 'subscription_not_found' }
    const response = await POST(webhookRequest({
      id: 'evt_5', type: 'customer.subscription.created',
      data: { object: { id: 'sub_9', status: 'active', metadata: { nordklart_company_id: '33333333-3333-4333-8333-333333333333' } } },
    }))
    expect(response.status).toBe(500)
  })

  it('ignores a subscription Nordklart never sold', async () => {
    rpcResult = { applied: false, reason: 'subscription_not_found' }
    const response = await POST(webhookRequest({
      id: 'evt_6', type: 'customer.subscription.created',
      data: { object: { id: 'sub_9', status: 'active' } },
    }))
    expect(response.status).toBe(200)
    expect(eventWrites.find((w) => w.kind === 'update' && w.status === 'ignored')).toBeTruthy()
  })

  it('answers 409 while another delivery of the same event is in flight', async () => {
    existingEventRow = { id: 'row-1', status: 'received', attempt_count: 1, updated_at: new Date().toISOString() }
    claimSucceeds = false
    const response = await POST(webhookRequest(completedEvent))
    expect(response.status).toBe(409)
    expect(rpcCalls).toHaveLength(0)
  })

  it('ignores events from the other Stripe mode', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_live_x')
    const response = await POST(webhookRequest({ ...completedEvent, livemode: false }))
    vi.unstubAllEnvs()
    expect(response.status).toBe(200)
    expect(rpcCalls).toHaveLength(0)
  })

  it('cancels a superseded base subscription in Stripe after a new base checkout', async () => {
    liveBaseSubscriptions = [{ external_subscription_id: 'sub_old' }]
    await POST(webhookRequest({
      id: 'evt_7', type: 'checkout.session.completed',
      data: { object: {
        id: 'cs_2', customer: 'cus_1', payment_status: 'paid', subscription: 'sub_new',
        metadata: { nordklart_company_id: '33333333-3333-4333-8333-333333333333', nordklart_checkout_kind: 'subscription' },
      } },
    }))
    expect(cancelSubscriptionMock).toHaveBeenCalledWith(expect.objectContaining({ subscriptionId: 'sub_old' }))
    expect(cancelSubscriptionMock).not.toHaveBeenCalledWith(expect.objectContaining({ subscriptionId: 'sub_new' }))
  })
})
