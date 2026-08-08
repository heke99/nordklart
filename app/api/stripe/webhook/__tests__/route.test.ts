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
vi.mock('@/lib/billing/stripe', () => ({
  verifyStripeWebhookSignature: (...args: unknown[]) => verifySignatureMock(...args),
}))

let existingEventRow: Record<string, unknown> | null = null
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = []
const eventWrites: Array<Record<string, unknown>> = []

const mockService = {
  from: (table: string) => {
    const chain: Record<string, unknown> = {}
    chain.select = () => chain
    chain.eq = () => chain
    chain.maybeSingle = async () => ({ data: table === 'stripe_webhook_events' ? existingEventRow : null, error: null })
    chain.insert = (row: Record<string, unknown>) => {
      eventWrites.push({ table, kind: 'insert', ...row })
      return Promise.resolve({ data: null, error: null })
    }
    chain.update = (row: Record<string, unknown>) => {
      eventWrites.push({ table, kind: 'update', ...row })
      return { eq: async () => ({ data: null, error: null }) }
    }
    return chain
  },
  rpc: (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args })
    return { throwOnError: async () => ({ data: null, error: null }) }
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
    expect(rpcCalls).toHaveLength(1)
    expect(rpcCalls[0].fn).toBe('stripe_finalize_checkout_v2')
    expect(rpcCalls[0].args).toMatchObject({
      p_stripe_event_id: 'evt_1',
      p_stripe_checkout_session_id: 'cs_1',
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
    expect(rpcCalls).toHaveLength(1)
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

  it('routes subscription events through stripe_sync_subscription_v2', async () => {
    const response = await POST(webhookRequest({
      id: 'evt_3',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_1', customer: 'cus_1', status: 'incomplete' } },
    }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(rpcCalls[0].fn).toBe('stripe_sync_subscription_v2')
    expect(rpcCalls[0].args).toMatchObject({ p_stripe_status: 'incomplete' })
  })
})
