import { createHmac } from 'crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { amountToMinorUnits, getStripeTaxSettings, verifyStripeWebhookSignature } from '@/lib/billing/stripe'

const previousSecret = process.env.STRIPE_WEBHOOK_SECRET
const previousTaxEnabled = process.env.STRIPE_TAX_ENABLED
const previousTaxMode = process.env.STRIPE_TAX_MODE

afterEach(() => {
  if (previousSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET
  else process.env.STRIPE_WEBHOOK_SECRET = previousSecret
  if (previousTaxEnabled === undefined) delete process.env.STRIPE_TAX_ENABLED
  else process.env.STRIPE_TAX_ENABLED = previousTaxEnabled
  if (previousTaxMode === undefined) delete process.env.STRIPE_TAX_MODE
  else process.env.STRIPE_TAX_MODE = previousTaxMode
})

describe('Stripe signing and tax helpers', () => {
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

  it('fails closed until Stripe Tax is explicitly enabled', () => {
    delete process.env.STRIPE_TAX_ENABLED
    delete process.env.STRIPE_TAX_MODE
    expect(() => getStripeTaxSettings()).toThrow(/Moms är inte redo/i)

    process.env.STRIPE_TAX_ENABLED = 'true'
    process.env.STRIPE_TAX_MODE = 'automatic'
    expect(getStripeTaxSettings()).toEqual({
      automaticTax: { enabled: true },
      taxIdCollection: { enabled: true },
      customerUpdate: { address: 'auto', name: 'auto' },
    })
  })
})
