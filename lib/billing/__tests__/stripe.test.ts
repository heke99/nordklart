import { createHmac } from 'crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { amountToMinorUnits, verifyStripeWebhookSignature } from '@/lib/billing/stripe'

const previousSecret = process.env.STRIPE_WEBHOOK_SECRET

afterEach(() => {
  if (previousSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET
  else process.env.STRIPE_WEBHOOK_SECRET = previousSecret
})

describe('Stripe signing helpers', () => {
  it('accepts a valid signed raw webhook payload', () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret'
    const timestamp = String(Math.floor(Date.now() / 1000))
    const rawBody = '{"id":"evt_test","type":"checkout.session.completed"}'
    const signature = createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET)
      .update(`${timestamp}.${rawBody}`, 'utf8')
      .digest('hex')

    expect(verifyStripeWebhookSignature(rawBody, `t=${timestamp},v1=${signature}`)).toBe(true)
  })

  it('rejects a changed payload and expired signature', () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret'
    const timestamp = String(Math.floor(Date.now() / 1000) - 301)
    const rawBody = '{"id":"evt_test"}'
    const signature = createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET)
      .update(`${timestamp}.${rawBody}`, 'utf8')
      .digest('hex')

    expect(verifyStripeWebhookSignature('{"id":"evt_changed"}', `t=${timestamp},v1=${signature}`)).toBe(false)
  })

  it('converts Swedish price values to Stripe minor units deterministically', () => {
    expect(amountToMinorUnits(299)).toBe(29900)
    expect(amountToMinorUnits('2495.50')).toBe(249550)
  })
})
