import { describe, it, expect } from 'vitest'
import { generateUblInvoice, validateForPeppol, type UblInvoiceInput } from '../ubl-generator'
import { isValidPeppolId, peppolIdFromOrgNumber } from '../types'

function baseInput(overrides: Partial<UblInvoiceInput> = {}): UblInvoiceInput {
  return {
    invoiceNumber: 'F-2026-0042',
    issueDate: '2026-07-01',
    dueDate: '2026-07-31',
    currency: 'SEK',
    typeCode: 380,
    buyerReference: 'PO-123',
    ocrReference: '2026004201',
    note: null,
    seller: {
      name: 'Testbolaget AB',
      orgNumber: '556123-4567',
      vatNumber: 'SE556123456701',
      fSkatt: true,
      addressLine1: 'Storgatan 1',
      postalCode: '111 22',
      city: 'Stockholm',
      countryCode: 'SE',
      bankgiro: '123-4567',
      plusgiro: null,
      iban: null,
      bic: null,
    },
    buyer: {
      name: 'Kommunen',
      peppolId: '0007:2120001355',
      orgNumber: '212000-1355',
      vatNumber: null,
      addressLine1: 'Rådhuset',
      postalCode: '111 22',
      city: 'Stockholm',
      countryCode: 'SE',
    },
    lines: [
      {
        description: 'Konsulttjänst',
        quantity: 10,
        unit: 'tim',
        unitPriceExclVat: 1200,
        lineTotalExclVat: 12000,
        vatRatePercent: 25,
        vatCategory: 'S',
      },
    ],
    ...overrides,
  }
}

describe('isValidPeppolId / peppolIdFromOrgNumber', () => {
  it('accepts scheme:value format', () => {
    expect(isValidPeppolId('0007:5566778899')).toBe(true)
    expect(isValidPeppolId('0088:7300010000001')).toBe(true)
  })
  it('rejects malformed ids', () => {
    expect(isValidPeppolId('5566778899')).toBe(false)
    expect(isValidPeppolId('07:x')).toBe(false)
    expect(isValidPeppolId('')).toBe(false)
  })
  it('builds the 0007 id from an org number', () => {
    expect(peppolIdFromOrgNumber('556677-8899')).toBe('0007:5566778899')
    expect(peppolIdFromOrgNumber('12345')).toBeNull()
  })
})

describe('validateForPeppol', () => {
  it('passes a complete Swedish invoice', () => {
    expect(validateForPeppol(baseInput())).toEqual([])
  })

  it('flags a missing buyer Peppol address', () => {
    const issues = validateForPeppol(baseInput({
      buyer: { ...baseInput().buyer, peppolId: '' },
    }))
    expect(issues.some((i) => i.rule === 'BT-49')).toBe(true)
  })

  it('flags missing payment means (SE-R-011)', () => {
    const issues = validateForPeppol(baseInput({
      seller: { ...baseInput().seller, bankgiro: null, plusgiro: null, iban: null },
    }))
    expect(issues.some((i) => i.rule === 'SE-R-011')).toBe(true)
  })

  it('flags incomplete seller address (ML 17 kap 24 §)', () => {
    const issues = validateForPeppol(baseInput({
      seller: { ...baseInput().seller, postalCode: null },
    }))
    expect(issues.some((i) => i.rule === 'BG-5')).toBe(true)
  })

  it('flags VAT category inconsistencies', () => {
    const input = baseInput()
    input.lines[0].vatCategory = 'S'
    input.lines[0].vatRatePercent = 0
    expect(validateForPeppol(input).some((i) => i.rule === 'BR-S-05')).toBe(true)

    input.lines[0].vatCategory = 'AE'
    input.lines[0].vatRatePercent = 25
    expect(validateForPeppol(input).some((i) => i.rule === 'BR-*-05')).toBe(true)
  })

  it('every message is Swedish', () => {
    const issues = validateForPeppol(baseInput({
      invoiceNumber: '',
      lines: [],
      seller: { ...baseInput().seller, name: '', orgNumber: '', bankgiro: null },
      buyer: { ...baseInput().buyer, name: '', peppolId: 'fel' },
    }))
    expect(issues.length).toBeGreaterThan(3)
    for (const issue of issues) {
      expect(issue.message_sv).toMatch(/saknas|saknar|ogiltig|fel|Betalningsuppgifter|ofullständig/i)
    }
  })
})

describe('generateUblInvoice', () => {
  it('produces a BIS Billing 3 document with the mandatory identifiers', () => {
    const xml = generateUblInvoice(baseInput())
    expect(xml).toContain('urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0')
    expect(xml).toContain('urn:fdc:peppol.eu:2017:poacc:billing:01:1.0')
    expect(xml).toContain('<cbc:ID>F-2026-0042</cbc:ID>')
    expect(xml).toContain('<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>')
    expect(xml).toContain('<cbc:DocumentCurrencyCode>SEK</cbc:DocumentCurrencyCode>')
  })

  it('includes the SE-R-005 F-skatt statement for F-skatt sellers', () => {
    const xml = generateUblInvoice(baseInput())
    expect(xml).toContain('<cbc:CompanyLegalForm>Godkänd för F-skatt</cbc:CompanyLegalForm>')
    expect(xml).toContain('<cbc:Note>Godkänd för F-skatt</cbc:Note>')

    const noFskatt = generateUblInvoice(baseInput({
      seller: { ...baseInput().seller, fSkatt: false },
    }))
    expect(noFskatt).not.toContain('Godkänd för F-skatt')
  })

  it('carries the Bankgiro payment means with the SE:BANKGIRO scheme (SE-R-011)', () => {
    const xml = generateUblInvoice(baseInput())
    expect(xml).toContain('<cbc:PaymentMeansCode>30</cbc:PaymentMeansCode>')
    expect(xml).toContain('<cbc:ID>1234567</cbc:ID>')
    expect(xml).toContain('SE:BANKGIRO')
    expect(xml).toContain('<cbc:PaymentID>2026004201</cbc:PaymentID>')
  })

  it('computes tax subtotals + monetary totals per rate', () => {
    const input = baseInput({
      lines: [
        { description: 'Tjänst', quantity: 1, unit: 'st', unitPriceExclVat: 1000, lineTotalExclVat: 1000, vatRatePercent: 25, vatCategory: 'S' },
        { description: 'Bok', quantity: 2, unit: 'st', unitPriceExclVat: 100, lineTotalExclVat: 200, vatRatePercent: 6, vatCategory: 'S' },
      ],
    })
    const xml = generateUblInvoice(input)
    // 25%: 250 kr; 6%: 12 kr; total 262 kr; incl 1462 kr
    expect(xml).toContain('<cbc:TaxAmount currencyID="SEK">262.00</cbc:TaxAmount>')
    expect(xml).toContain('<cbc:TaxableAmount currencyID="SEK">1000.00</cbc:TaxableAmount>')
    expect(xml).toContain('<cbc:TaxableAmount currencyID="SEK">200.00</cbc:TaxableAmount>')
    expect(xml).toContain('<cbc:TaxInclusiveAmount currencyID="SEK">1462.00</cbc:TaxInclusiveAmount>')
    expect(xml).toContain('<cbc:PayableAmount currencyID="SEK">1462.00</cbc:PayableAmount>')
  })

  it('adds exemption reasons for reverse charge / intra-community / export', () => {
    const rc = generateUblInvoice(baseInput({
      lines: [{ description: 'Tjänst EU', quantity: 1, unit: 'st', unitPriceExclVat: 1000, lineTotalExclVat: 1000, vatRatePercent: 0, vatCategory: 'AE' }],
    }))
    expect(rc).toContain('Omvänd betalningsskyldighet')

    const ic = generateUblInvoice(baseInput({
      lines: [{ description: 'Varor EU', quantity: 1, unit: 'st', unitPriceExclVat: 1000, lineTotalExclVat: 1000, vatRatePercent: 0, vatCategory: 'K' }],
    }))
    expect(ic).toContain('artikel 138')
  })

  it('maps Swedish units to UN/ECE codes', () => {
    const xml = generateUblInvoice(baseInput())
    expect(xml).toContain('unitCode="HUR"')
  })

  it('escapes XML special characters', () => {
    const xml = generateUblInvoice(baseInput({
      buyer: { ...baseInput().buyer, name: 'A & B <AB>' },
    }))
    expect(xml).toContain('A &amp; B &lt;AB&gt;')
  })

  it('uses type code 381 for credit notes', () => {
    const xml = generateUblInvoice(baseInput({ typeCode: 381 }))
    expect(xml).toContain('<cbc:InvoiceTypeCode>381</cbc:InvoiceTypeCode>')
  })
})
