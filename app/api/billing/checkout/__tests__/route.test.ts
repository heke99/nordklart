/**
 * Year-end one-time checkout guards: fiscal period required, period must
 * belong to the active company, duplicate/pending purchases blocked, open
 * checkout sessions block a parallel start.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockUserSupabase } = createQueuedMockSupabase()
const { supabase: mockServiceSupabase, enqueue: enqueueService, reset: resetService } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockUserSupabase),
  createServiceClient: () => mockServiceSupabase,
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const canManageBillingMock = vi.fn()
vi.mock('@/lib/billing/access', () => ({
  canManageCompanyBilling: (...args: unknown[]) => canManageBillingMock(...args),
}))

vi.mock('@/lib/billing/stripe', () => ({
  isStripeConfigured: () => true,
  createStripeCustomer: vi.fn().mockResolvedValue({ id: 'cus_1', email: 'a@b.se', name: 'Acme' }),
  createStripeCheckoutSession: vi.fn().mockResolvedValue({ id: 'cs_1', url: 'https://stripe.test/session' }),
  StripeRequestError: class StripeRequestError extends Error {
    status = 502
  },
}))

import { POST } from '../route'

const VERSION_ID = '11111111-1111-4111-8111-111111111111'
const PERIOD_ID = '22222222-2222-4222-8222-222222222222'

const version = { id: VERSION_ID, plan_id: 'plan-1', status: 'active', price_excl_vat: 990, currency: 'SEK', billing_interval: 'one_time', stripe_price_id: 'price_1' }
const plan = { id: 'plan-1', code: 'year_end_one_time', name: 'Bokslut', product_id: 'prod-1', status: 'active' }
const product = { id: 'prod-1', code: 'year_end', product_type: 'one_time', status: 'active', stripe_tax_code: 'txcd_x' }

function checkoutRequest(body: Record<string, unknown>) {
  return createMockRequest('/api/billing/checkout', { method: 'POST', body })
}

describe('POST /api/billing/checkout — year-end one-time', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetService()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1', email: 'a@b.se' }, supabase: mockUserSupabase })
    canManageBillingMock.mockResolvedValue(true)
  })

  it('requires fiscalPeriodId for the year-end product', async () => {
    enqueueService({ data: version, error: null })
    enqueueService({ data: plan, error: null })
    enqueueService({ data: product, error: null })

    const response = await POST(checkoutRequest({ planVersionId: VERSION_ID }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(422)
    expect(body.error).toContain('räkenskapsår')
  })

  it('rejects a fiscal period that belongs to another company', async () => {
    enqueueService({ data: version, error: null })
    enqueueService({ data: plan, error: null })
    enqueueService({ data: product, error: null })
    enqueueService({ data: null, error: null }) // period lookup scoped to company-1 → not found

    const response = await POST(checkoutRequest({ planVersionId: VERSION_ID, fiscalPeriodId: PERIOD_ID }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(403)
    expect(body.error).toContain('tillhör inte företaget')
  })

  it('blocks a duplicate purchase for the same fiscal period', async () => {
    enqueueService({ data: version, error: null })
    enqueueService({ data: plan, error: null })
    enqueueService({ data: product, error: null })
    enqueueService({ data: { id: PERIOD_ID }, error: null }) // period ok
    enqueueService({ data: { id: 'purchase-1' }, error: null }) // existing purchase

    const response = await POST(checkoutRequest({ planVersionId: VERSION_ID, fiscalPeriodId: PERIOD_ID }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(409)
    expect(body.error).toContain('redan ett pågående eller aktivt bokslutsköp')
  })

  it('blocks a parallel checkout while a session is still open', async () => {
    enqueueService({ data: version, error: null })
    enqueueService({ data: plan, error: null })
    enqueueService({ data: product, error: null })
    enqueueService({ data: { id: PERIOD_ID }, error: null }) // period ok
    enqueueService({ data: null, error: null }) // no existing purchase
    enqueueService({ data: { stripe_customer_id: 'cus_1' }, error: null }) // billing profile
    enqueueService({ data: { id: 'checkout-open' }, error: null }) // open checkout exists

    const response = await POST(checkoutRequest({ planVersionId: VERSION_ID, fiscalPeriodId: PERIOD_ID }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(409)
    expect(body.error).toContain('pågående betalning')
  })

  it('rejects non-billing-admins', async () => {
    canManageBillingMock.mockResolvedValue(false)
    const response = await POST(checkoutRequest({ planVersionId: VERSION_ID, fiscalPeriodId: PERIOD_ID }))
    const { status } = await parseJsonResponse(response)
    expect(status).toBe(403)
  })

  it('creates the checkout session with the fiscal period bound in metadata', async () => {
    const { createStripeCheckoutSession } = await import('@/lib/billing/stripe')
    enqueueService({ data: version, error: null })
    enqueueService({ data: plan, error: null })
    enqueueService({ data: product, error: null })
    enqueueService({ data: { id: PERIOD_ID }, error: null }) // period ok
    enqueueService({ data: null, error: null }) // no existing purchase
    enqueueService({ data: { stripe_customer_id: 'cus_1' }, error: null }) // billing profile
    enqueueService({ data: null, error: null }) // no open checkout
    enqueueService({ data: null, error: null }) // insert checkout session
    enqueueService({ data: null, error: null }) // update with stripe session id

    const response = await POST(checkoutRequest({ planVersionId: VERSION_ID, fiscalPeriodId: PERIOD_ID }))
    const { status, body } = await parseJsonResponse<{ url: string }>(response)

    expect(status).toBe(200)
    expect(body.url).toBe('https://stripe.test/session')
    expect(vi.mocked(createStripeCheckoutSession)).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'payment',
        metadata: expect.objectContaining({
          nordklart_company_id: 'company-1',
          nordklart_fiscal_period_id: PERIOD_ID,
          nordklart_checkout_kind: 'one_time',
        }),
      }),
    )
    // Cancel URL must carry the local checkout id so the return trip can
    // release the open-session guard.
    const args = vi.mocked(createStripeCheckoutSession).mock.calls[0][0] as { cancelUrl: string }
    expect(args.cancelUrl).toContain('checkout=cancelled')
    expect(args.cancelUrl).toContain('checkout_id=')
  })
})
