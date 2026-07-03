import { describe, it, expect, beforeEach } from 'vitest'
import {
  sandboxFinancingProvider,
  getFinancingReadiness,
  getFinancingProvider,
  __resetSandboxFinancingApplications,
} from '../provider'
import type { FinancingApplicationInput } from '../types'

function input(overrides?: Partial<FinancingApplicationInput['customer']>): FinancingApplicationInput {
  return {
    applicationId: 'app-1',
    companyId: 'co-1',
    invoice: {
      id: 'inv-1',
      invoice_number: 'F-1001',
      total: 12500,
      currency: 'SEK',
      due_date: '2026-07-30',
    },
    customer: { name: 'Kund AB', org_number: '5566778899', ...overrides },
    requestedAmount: 12500,
    recourse: false,
  }
}

describe('sandboxFinancingProvider', () => {
  beforeEach(() => __resetSandboxFinancingApplications())

  it('creates a deterministic 3% offer', async () => {
    const result = await sandboxFinancingProvider.submitApplication(input())
    expect(result.status).toBe('offer_created')
    if (result.status !== 'offer_created') throw new Error('unreachable')
    expect(result.offer.feePercent).toBe(3)
    expect(result.offer.feeAmount).toBe(375)
    expect(result.offer.payoutAmount).toBe(12125)
    expect(result.offer.providerReference).toMatch(/^sandbox-fin-/)
    expect(result.offer.validUntil).toBeTruthy()
  })

  it('org number ending in 00 triggers needs_more_info', async () => {
    const result = await sandboxFinancingProvider.submitApplication(
      input({ org_number: '5566778800' }),
    )
    expect(result.status).toBe('needs_more_info')
    if (result.status !== 'needs_more_info') throw new Error('unreachable')
    expect(result.message_sv).toMatch(/kompletterande/i)
  })

  it('customer name containing "avslag" triggers rejection', async () => {
    const result = await sandboxFinancingProvider.submitApplication(
      input({ name: 'Avslag Test AB' }),
    )
    expect(result.status).toBe('rejected')
  })

  it('accept pays out the offered terms', async () => {
    const submitted = await sandboxFinancingProvider.submitApplication(input())
    if (submitted.status !== 'offer_created') throw new Error('expected offer')

    const payout = await sandboxFinancingProvider.acceptOffer(submitted.offer.providerReference)
    expect(payout.status).toBe('paid_out')
    expect(payout.payoutAmount).toBe(12125)
    expect(payout.feeAmount).toBe(375)
    expect(payout.payoutDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('accept of unknown or already-accepted reference throws', async () => {
    await expect(sandboxFinancingProvider.acceptOffer('nope')).rejects.toThrow()

    const submitted = await sandboxFinancingProvider.submitApplication(input())
    if (submitted.status !== 'offer_created') throw new Error('expected offer')
    await sandboxFinancingProvider.acceptOffer(submitted.offer.providerReference)
    await expect(
      sandboxFinancingProvider.acceptOffer(submitted.offer.providerReference),
    ).rejects.toThrow()
  })

  it('cancel of accepted application throws, cancel of open succeeds', async () => {
    const submitted = await sandboxFinancingProvider.submitApplication(input())
    if (submitted.status !== 'offer_created') throw new Error('expected offer')

    await expect(
      sandboxFinancingProvider.cancelApplication(submitted.offer.providerReference),
    ).resolves.toBeUndefined()

    const second = await sandboxFinancingProvider.submitApplication(input())
    if (second.status !== 'offer_created') throw new Error('expected offer')
    await sandboxFinancingProvider.acceptOffer(second.offer.providerReference)
    await expect(
      sandboxFinancingProvider.cancelApplication(second.offer.providerReference),
    ).rejects.toThrow(/accepterad/)
  })
})

describe('getFinancingReadiness / getFinancingProvider', () => {
  it('honours INVOICE_FINANCING_PROVIDER env', () => {
    const prev = process.env.INVOICE_FINANCING_PROVIDER
    try {
      process.env.INVOICE_FINANCING_PROVIDER = 'none'
      expect(getFinancingReadiness()).toBe('requires_agreement')
      expect(getFinancingProvider('sandbox')).toBeNull()

      process.env.INVOICE_FINANCING_PROVIDER = 'sandbox'
      expect(getFinancingReadiness()).toBe('sandbox_ready')
      expect(getFinancingProvider('sandbox')).toBe(sandboxFinancingProvider)
      expect(getFinancingProvider('unknown')).toBeNull()
    } finally {
      if (prev === undefined) delete process.env.INVOICE_FINANCING_PROVIDER
      else process.env.INVOICE_FINANCING_PROVIDER = prev
    }
  })
})
