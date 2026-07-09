/**
 * Security + payment-correctness tests for the invoice email templates:
 *
 *  - HTML escaping of every user-influenced string (XSS)
 *  - CSS injection guard on branding colors
 *  - payment details (bankgiro/plusgiro/OCR) present on real invoices and
 *    hidden on proforma / delivery note / credit note
 */
import { describe, it, expect } from 'vitest'
import {
  generateInvoiceEmailHtml,
  generateInvoiceEmailText,
} from '../invoice-templates'
import { generateOcrReference } from '@/lib/bankgiro/luhn'
import { makeCustomer, makeInvoice, makeCompanySettings } from '@/tests/helpers'

const paymentCompany = makeCompanySettings({
  company_name: 'Acme AB',
  bankgiro: '5402-9681',
  plusgiro: '12 34 56-7',
  bank_name: 'SEB',
  clearing_number: '5000',
  account_number: '1234567',
  iban: 'SE45 5000 0000 0583 9825 7466',
  bic: 'ESSESESS',
  org_number: '556677-8899',
})

const svCustomer = makeCustomer({ name: 'Erik Andersson', email: 'erik@example.se', language: 'sv' })
const invoice = makeInvoice({ invoice_number: 'F2026042', total: 12500, currency: 'SEK' })

describe('invoice email HTML escaping', () => {
  it('escapes script tags in customer and company names', () => {
    const html = generateInvoiceEmailHtml({
      invoice,
      customer: makeCustomer({ name: '<script>alert(1)</script> Andersson', language: 'sv' }),
      company: makeCompanySettings({ company_name: '<img src=x onerror=alert(2)> AB' }),
    })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('<img src=x onerror=alert(2)>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('escapes bank/payment fields', () => {
    const html = generateInvoiceEmailHtml({
      invoice,
      customer: svCustomer,
      company: makeCompanySettings({
        bankgiro: '5402-9681"><script>x()</script>',
        bank_name: '<b onmouseover=steal()>SEB</b>',
      }),
    })
    expect(html).not.toContain('<script>x()</script>')
    expect(html).not.toContain('<b onmouseover=steal()>')
  })

  it('escapes the invoice number', () => {
    const html = generateInvoiceEmailHtml({
      invoice: makeInvoice({ invoice_number: '<iframe src=evil>' }),
      customer: svCustomer,
      company: paymentCompany,
    })
    expect(html).not.toContain('<iframe src=evil>')
  })

  it('rejects malformed branding colors (CSS injection)', () => {
    const html = generateInvoiceEmailHtml({
      invoice,
      customer: svCustomer,
      company: makeCompanySettings({
        invoice_primary_color: 'red;}body{background:url(https://evil.example/x)}',
      }),
    })
    expect(html).not.toContain('evil.example')
    expect(html).toContain('#111111')
  })
})

describe('invoice email payment details', () => {
  it('shows bankgiro, plusgiro and the Luhn OCR for a Swedish real invoice', () => {
    const html = generateInvoiceEmailHtml({ invoice, customer: svCustomer, company: paymentCompany })
    const text = generateInvoiceEmailText({ invoice, customer: svCustomer, company: paymentCompany })
    const expectedOcr = generateOcrReference('F2026042')

    for (const output of [html, text]) {
      expect(output).toContain('Bankgiro:')
      expect(output).toContain('5402-9681')
      expect(output).toContain('Plusgiro:')
      expect(output).toContain('OCR/Referens:')
      expect(output).toContain(expectedOcr)
    }
  })

  it('honours the show flags for bankgiro/plusgiro', () => {
    const company = makeCompanySettings({
      ...paymentCompany,
      invoice_show_bankgiro: false,
      invoice_show_plusgiro: false,
    })
    const html = generateInvoiceEmailHtml({ invoice, customer: svCustomer, company })
    expect(html).not.toContain('Bankgiro:')
    expect(html).not.toContain('Plusgiro:')
  })

  it('falls back to the invoice number when OCR display is disabled', () => {
    const company = makeCompanySettings({ ...paymentCompany, invoice_show_ocr: false })
    const html = generateInvoiceEmailHtml({ invoice, customer: svCustomer, company })
    expect(html).not.toContain('OCR/Referens:')
    expect(html).toContain('Meddelande:')
    expect(html).toContain('F2026042')
  })

  it('uses the invoice number as reference for English recipients (no OCR)', () => {
    const enCustomer = makeCustomer({ name: 'John Smith', language: 'en' })
    const html = generateInvoiceEmailHtml({ invoice, customer: enCustomer, company: paymentCompany })
    expect(html).not.toContain('OCR/Referens:')
    expect(html).toContain('Reference:')
    expect(html).toContain('F2026042')
  })

  it.each([
    ['proforma', makeInvoice({ document_type: 'proforma', invoice_number: 'P-1' })],
    ['delivery_note', makeInvoice({ document_type: 'delivery_note', invoice_number: 'FS-1' })],
    ['credit note', makeInvoice({ invoice_number: 'KR-F2026042', credited_invoice_id: 'inv-original' })],
  ])('hides all payment instructions on %s', (_label, doc) => {
    const html = generateInvoiceEmailHtml({ invoice: doc, customer: svCustomer, company: paymentCompany })
    const text = generateInvoiceEmailText({ invoice: doc, customer: svCustomer, company: paymentCompany })
    for (const output of [html, text]) {
      expect(output).not.toContain('Betalningsinformation')
      expect(output).not.toContain('Bankgiro:')
      expect(output).not.toContain('OCR/Referens:')
      expect(output).not.toContain('IBAN:')
    }
  })
})
