import { describe, it, expect, beforeEach } from 'vitest'
import {
  sandboxEInvoiceProvider,
  getPeppolReadiness,
  __resetSandboxEInvoiceDeliveries,
} from '../provider'

describe('sandboxEInvoiceProvider', () => {
  beforeEach(() => __resetSandboxEInvoiceDeliveries())

  it('validates BIS Billing 3 structure', async () => {
    const issues = await sandboxEInvoiceProvider.validateInvoice('<Invoice>not bis</Invoice>')
    expect(issues.length).toBeGreaterThan(0)

    const ok = await sandboxEInvoiceProvider.validateInvoice(
      '<Invoice>urn:fdc:peppol.eu:2017:poacc:billing:3.0 <cac:InvoiceLine></cac:InvoiceLine> <cac:LegalMonetaryTotal></cac:LegalMonetaryTotal></Invoice>',
    )
    expect(ok).toEqual([])
  })

  it('looks up participants — reserved id yields not found', async () => {
    const found = await sandboxEInvoiceProvider.lookupParticipant('0007:5566778899')
    expect(found.found).toBe(true)
    expect(found.capabilities?.length).toBeGreaterThan(0)

    const notFound = await sandboxEInvoiceProvider.lookupParticipant('0007:0000000000')
    expect(notFound.found).toBe(false)

    const malformed = await sandboxEInvoiceProvider.lookupParticipant('nonsense')
    expect(malformed.found).toBe(false)
  })

  it('send → sent, first status poll → delivered', async () => {
    const sent = await sandboxEInvoiceProvider.sendInvoice({
      ublXml: '<Invoice/>',
      participantId: '0007:5566778899',
      invoiceNumber: 'F-1',
    })
    expect(sent.status).toBe('sent')
    expect(sent.providerReference).toBeTruthy()

    const status = await sandboxEInvoiceProvider.getDeliveryStatus(sent.providerReference!)
    expect(status).toBe('delivered')
  })

  it('unknown provider reference reports rejected', async () => {
    expect(await sandboxEInvoiceProvider.getDeliveryStatus('nope')).toBe('rejected')
  })
})

describe('getPeppolReadiness', () => {
  it('honours PEPPOL_PROVIDER env', () => {
    const prev = process.env.PEPPOL_PROVIDER
    try {
      process.env.PEPPOL_PROVIDER = 'none'
      expect(getPeppolReadiness()).toBe('requires_agreement')
      process.env.PEPPOL_PROVIDER = 'sandbox'
      expect(getPeppolReadiness()).toBe('sandbox_ready')
    } finally {
      if (prev === undefined) delete process.env.PEPPOL_PROVIDER
      else process.env.PEPPOL_PROVIDER = prev
    }
  })
})
