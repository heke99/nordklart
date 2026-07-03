import { roundOre } from '@/lib/money'
import type { EInvoiceValidationIssue } from './types'
import { isValidPeppolId } from './types'

/**
 * UBL 2.1 / Peppol BIS Billing 3.0 invoice generator.
 *
 * Produces a BIS-Billing-3-compliant <Invoice> document with the Swedish
 * CIUS specifics:
 *   SE-R-005 — a seller approved for F-skatt states "Godkänd för F-skatt"
 *   SE-R-011 — domestic payment means carry Bankgiro/Plusgiro account ids
 *
 * The generator is PURE: it takes plain data (no Supabase types) so it can
 * be unit-tested byte for byte. The caller (lib/peppol/service.ts) maps
 * Invoice/Customer/CompanySettings rows into these shapes.
 */

export interface UblSeller {
  name: string
  orgNumber: string
  vatNumber: string | null
  fSkatt: boolean
  addressLine1: string | null
  postalCode: string | null
  city: string | null
  countryCode: string // 'SE'
  /** Payment means. */
  bankgiro: string | null
  plusgiro: string | null
  iban: string | null
  bic: string | null
}

export interface UblBuyer {
  name: string
  peppolId: string
  orgNumber: string | null
  vatNumber: string | null
  addressLine1: string | null
  postalCode: string | null
  city: string | null
  countryCode: string
}

export interface UblLine {
  description: string
  quantity: number
  unit: string
  unitPriceExclVat: number
  lineTotalExclVat: number
  vatRatePercent: number
  /** BIS VAT category: S (standard), E (exempt), Z (zero), AE (reverse charge), K (intra-community), G (export). */
  vatCategory: 'S' | 'E' | 'Z' | 'AE' | 'K' | 'G'
}

export interface UblInvoiceInput {
  invoiceNumber: string
  issueDate: string // YYYY-MM-DD
  dueDate: string
  currency: string
  /** 380 invoice, 381 credit note. */
  typeCode: 380 | 381
  buyerReference: string | null
  ocrReference: string | null
  note: string | null
  seller: UblSeller
  buyer: UblBuyer
  lines: UblLine[]
}

/** Map Swedish units to UN/ECE Recommendation 20 codes. */
const UNIT_CODES: Record<string, string> = {
  st: 'EA',
  tim: 'HUR',
  timmar: 'HUR',
  dag: 'DAY',
  mån: 'MON',
  kg: 'KGM',
  m: 'MTR',
  km: 'KMT',
  l: 'LTR',
  frp: 'PK',
}

function unitCode(unit: string): string {
  return UNIT_CODES[unit.trim().toLowerCase()] ?? 'C62'
}

function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function amount(n: number): string {
  return roundOre(n).toFixed(2)
}

/**
 * Pre-flight validation against the BIS Billing 3 mandatory fields + the
 * Sweden CIUS rules we can check locally. Returns Swedish, actionable
 * messages. Empty array = ready to generate/send.
 */
export function validateForPeppol(input: UblInvoiceInput): EInvoiceValidationIssue[] {
  const issues: EInvoiceValidationIssue[] = []

  if (!input.invoiceNumber?.trim()) {
    issues.push({ rule: 'BT-1', message_sv: 'Fakturanummer saknas.' })
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.issueDate)) {
    issues.push({ rule: 'BT-2', message_sv: 'Fakturadatum saknas eller har fel format.' })
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) {
    issues.push({ rule: 'BT-9', message_sv: 'Förfallodatum saknas eller har fel format.' })
  }
  if (!input.currency?.trim()) {
    issues.push({ rule: 'BT-5', message_sv: 'Valuta saknas.' })
  }
  if (!input.seller.name?.trim()) {
    issues.push({ rule: 'BT-27', message_sv: 'Säljarens namn saknas — komplettera företagsinställningarna.' })
  }
  if (!input.seller.orgNumber?.replace(/\D/g, '')) {
    issues.push({ rule: 'BT-30', message_sv: 'Säljarens organisationsnummer saknas — komplettera företagsinställningarna.' })
  }
  if (!input.seller.addressLine1?.trim() || !input.seller.postalCode?.trim() || !input.seller.city?.trim()) {
    issues.push({ rule: 'BG-5', message_sv: 'Säljarens adress är ofullständig (gatuadress, postnummer och ort krävs, ML 17 kap 24 §).' })
  }
  if (!input.buyer.name?.trim()) {
    issues.push({ rule: 'BT-44', message_sv: 'Köparens namn saknas.' })
  }
  if (!input.buyer.peppolId?.trim()) {
    issues.push({ rule: 'BT-49', message_sv: 'Köparens Peppol-adress (elektronisk adress) saknas — ange den på kundkortet.' })
  } else if (!isValidPeppolId(input.buyer.peppolId)) {
    issues.push({ rule: 'BT-49', message_sv: `Köparens Peppol-adress har fel format: "${input.buyer.peppolId}". Förväntat format är t.ex. 0007:5566778899.` })
  }
  if (input.lines.length === 0) {
    issues.push({ rule: 'BG-25', message_sv: 'Fakturan saknar rader.' })
  }
  for (const [i, line] of input.lines.entries()) {
    if (!line.description?.trim()) {
      issues.push({ rule: 'BT-153', message_sv: `Rad ${i + 1} saknar beskrivning.` })
    }
    if (!(line.quantity > 0)) {
      issues.push({ rule: 'BT-129', message_sv: `Rad ${i + 1} har ogiltigt antal.` })
    }
  }
  // Sweden CIUS SE-R-011 — a Swedish invoice must carry a usable payment
  // means (Bankgiro/Plusgiro/IBAN).
  if (!input.seller.bankgiro?.trim() && !input.seller.plusgiro?.trim() && !input.seller.iban?.trim()) {
    issues.push({ rule: 'SE-R-011', message_sv: 'Betalningsuppgifter saknas — ange bankgiro, plusgiro eller IBAN i företagsinställningarna.' })
  }
  // VAT category consistency: S requires a positive rate; AE/K/E/Z/G require 0.
  for (const [i, line] of input.lines.entries()) {
    if (line.vatCategory === 'S' && !(line.vatRatePercent > 0)) {
      issues.push({ rule: 'BR-S-05', message_sv: `Rad ${i + 1}: momskategori S kräver en momssats över 0 %.` })
    }
    if (line.vatCategory !== 'S' && line.vatRatePercent !== 0) {
      issues.push({ rule: 'BR-*-05', message_sv: `Rad ${i + 1}: momskategori ${line.vatCategory} kräver momssats 0 %.` })
    }
  }

  return issues
}

/** Group lines per (category, rate) for the TaxTotal breakdown. */
function taxSubtotals(lines: UblLine[]): Array<{ category: string; rate: number; taxable: number; tax: number }> {
  const map = new Map<string, { category: string; rate: number; taxable: number; tax: number }>()
  for (const line of lines) {
    const key = `${line.vatCategory}:${line.vatRatePercent}`
    const entry = map.get(key) ?? { category: line.vatCategory, rate: line.vatRatePercent, taxable: 0, tax: 0 }
    entry.taxable = roundOre(entry.taxable + line.lineTotalExclVat)
    entry.tax = roundOre(entry.tax + (line.lineTotalExclVat * line.vatRatePercent) / 100)
    map.set(key, entry)
  }
  return Array.from(map.values())
}

/** Exemption reason per category (BR-E-10/AE-10/G-10 require one). */
function exemptionReason(category: string): string | null {
  switch (category) {
    case 'AE': return 'Omvänd betalningsskyldighet'
    case 'K': return 'Unionsintern leverans, artikel 138 mervärdesskattedirektivet'
    case 'G': return 'Export, 0 % moms'
    case 'E': return 'Undantaget från mervärdesskatt'
    case 'Z': return null
    default: return null
  }
}

/**
 * Render the UBL 2.1 BIS Billing 3 XML. Call validateForPeppol first —
 * generation throws on structurally impossible input (no lines).
 */
export function generateUblInvoice(input: UblInvoiceInput): string {
  if (input.lines.length === 0) {
    throw new Error('Fakturan saknar rader — kan inte generera UBL.')
  }

  const subtotals = taxSubtotals(input.lines)
  const lineExtension = roundOre(input.lines.reduce((s, l) => s + l.lineTotalExclVat, 0))
  const taxTotal = roundOre(subtotals.reduce((s, t) => s + t.tax, 0))
  const taxInclusive = roundOre(lineExtension + taxTotal)

  const sellerEndpoint = input.seller.orgNumber.replace(/\D/g, '')
  const [buyerScheme, ...buyerRest] = input.buyer.peppolId.split(':')
  const buyerEndpoint = buyerRest.join(':')

  const xml: string[] = []
  xml.push('<?xml version="1.0" encoding="UTF-8"?>')
  xml.push('<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"')
  xml.push('  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"')
  xml.push('  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">')
  xml.push('  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID>')
  xml.push('  <cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>')
  xml.push(`  <cbc:ID>${esc(input.invoiceNumber)}</cbc:ID>`)
  xml.push(`  <cbc:IssueDate>${input.issueDate}</cbc:IssueDate>`)
  xml.push(`  <cbc:DueDate>${input.dueDate}</cbc:DueDate>`)
  xml.push(`  <cbc:InvoiceTypeCode>${input.typeCode}</cbc:InvoiceTypeCode>`)
  const notes: string[] = []
  if (input.note) notes.push(input.note)
  // SE-R-005: seller approved for F-skatt states it on the invoice.
  if (input.seller.fSkatt) notes.push('Godkänd för F-skatt')
  for (const n of notes) {
    xml.push(`  <cbc:Note>${esc(n)}</cbc:Note>`)
  }
  xml.push(`  <cbc:DocumentCurrencyCode>${esc(input.currency)}</cbc:DocumentCurrencyCode>`)
  if (input.buyerReference) {
    xml.push(`  <cbc:BuyerReference>${esc(input.buyerReference)}</cbc:BuyerReference>`)
  }

  // ── Seller ──
  xml.push('  <cac:AccountingSupplierParty>')
  xml.push('    <cac:Party>')
  xml.push(`      <cbc:EndpointID schemeID="0007">${esc(sellerEndpoint)}</cbc:EndpointID>`)
  xml.push('      <cac:PartyName>')
  xml.push(`        <cbc:Name>${esc(input.seller.name)}</cbc:Name>`)
  xml.push('      </cac:PartyName>')
  xml.push('      <cac:PostalAddress>')
  if (input.seller.addressLine1) xml.push(`        <cbc:StreetName>${esc(input.seller.addressLine1)}</cbc:StreetName>`)
  if (input.seller.city) xml.push(`        <cbc:CityName>${esc(input.seller.city)}</cbc:CityName>`)
  if (input.seller.postalCode) xml.push(`        <cbc:PostalZone>${esc(input.seller.postalCode)}</cbc:PostalZone>`)
  xml.push('        <cac:Country>')
  xml.push(`          <cbc:IdentificationCode>${esc(input.seller.countryCode)}</cbc:IdentificationCode>`)
  xml.push('        </cac:Country>')
  xml.push('      </cac:PostalAddress>')
  if (input.seller.vatNumber) {
    xml.push('      <cac:PartyTaxScheme>')
    xml.push(`        <cbc:CompanyID>${esc(input.seller.vatNumber)}</cbc:CompanyID>`)
    xml.push('        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>')
    xml.push('      </cac:PartyTaxScheme>')
  }
  xml.push('      <cac:PartyLegalEntity>')
  xml.push(`        <cbc:RegistrationName>${esc(input.seller.name)}</cbc:RegistrationName>`)
  xml.push(`        <cbc:CompanyID schemeID="0007">${esc(sellerEndpoint)}</cbc:CompanyID>`)
  if (input.seller.fSkatt) {
    xml.push('        <cbc:CompanyLegalForm>Godkänd för F-skatt</cbc:CompanyLegalForm>')
  }
  xml.push('      </cac:PartyLegalEntity>')
  xml.push('    </cac:Party>')
  xml.push('  </cac:AccountingSupplierParty>')

  // ── Buyer ──
  xml.push('  <cac:AccountingCustomerParty>')
  xml.push('    <cac:Party>')
  xml.push(`      <cbc:EndpointID schemeID="${esc(buyerScheme)}">${esc(buyerEndpoint)}</cbc:EndpointID>`)
  xml.push('      <cac:PartyName>')
  xml.push(`        <cbc:Name>${esc(input.buyer.name)}</cbc:Name>`)
  xml.push('      </cac:PartyName>')
  xml.push('      <cac:PostalAddress>')
  if (input.buyer.addressLine1) xml.push(`        <cbc:StreetName>${esc(input.buyer.addressLine1)}</cbc:StreetName>`)
  if (input.buyer.city) xml.push(`        <cbc:CityName>${esc(input.buyer.city)}</cbc:CityName>`)
  if (input.buyer.postalCode) xml.push(`        <cbc:PostalZone>${esc(input.buyer.postalCode)}</cbc:PostalZone>`)
  xml.push('        <cac:Country>')
  xml.push(`          <cbc:IdentificationCode>${esc(input.buyer.countryCode)}</cbc:IdentificationCode>`)
  xml.push('        </cac:Country>')
  xml.push('      </cac:PostalAddress>')
  if (input.buyer.vatNumber) {
    xml.push('      <cac:PartyTaxScheme>')
    xml.push(`        <cbc:CompanyID>${esc(input.buyer.vatNumber)}</cbc:CompanyID>`)
    xml.push('        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>')
    xml.push('      </cac:PartyTaxScheme>')
  }
  xml.push('      <cac:PartyLegalEntity>')
  xml.push(`        <cbc:RegistrationName>${esc(input.buyer.name)}</cbc:RegistrationName>`)
  if (input.buyer.orgNumber) {
    xml.push(`        <cbc:CompanyID schemeID="0007">${esc(input.buyer.orgNumber.replace(/\D/g, ''))}</cbc:CompanyID>`)
  }
  xml.push('      </cac:PartyLegalEntity>')
  xml.push('    </cac:Party>')
  xml.push('  </cac:AccountingCustomerParty>')

  // ── Payment means (SE-R-011: Bankgiro > Plusgiro > IBAN preference) ──
  xml.push('  <cac:PaymentMeans>')
  xml.push('    <cbc:PaymentMeansCode>30</cbc:PaymentMeansCode>')
  if (input.ocrReference) {
    xml.push(`    <cbc:PaymentID>${esc(input.ocrReference)}</cbc:PaymentID>`)
  }
  if (input.seller.bankgiro) {
    xml.push('    <cac:PayeeFinancialAccount>')
    xml.push(`      <cbc:ID>${esc(input.seller.bankgiro.replace(/[-\s]/g, ''))}</cbc:ID>`)
    xml.push('      <cbc:Name>Bankgiro</cbc:Name>')
    xml.push('      <cac:FinancialInstitutionBranch><cbc:ID>SE:BANKGIRO</cbc:ID></cac:FinancialInstitutionBranch>')
    xml.push('    </cac:PayeeFinancialAccount>')
  } else if (input.seller.plusgiro) {
    xml.push('    <cac:PayeeFinancialAccount>')
    xml.push(`      <cbc:ID>${esc(input.seller.plusgiro.replace(/[-\s]/g, ''))}</cbc:ID>`)
    xml.push('      <cbc:Name>Plusgiro</cbc:Name>')
    xml.push('      <cac:FinancialInstitutionBranch><cbc:ID>SE:PLUSGIRO</cbc:ID></cac:FinancialInstitutionBranch>')
    xml.push('    </cac:PayeeFinancialAccount>')
  } else if (input.seller.iban) {
    xml.push('    <cac:PayeeFinancialAccount>')
    xml.push(`      <cbc:ID>${esc(input.seller.iban)}</cbc:ID>`)
    if (input.seller.bic) {
      xml.push(`      <cac:FinancialInstitutionBranch><cbc:ID>${esc(input.seller.bic)}</cbc:ID></cac:FinancialInstitutionBranch>`)
    }
    xml.push('    </cac:PayeeFinancialAccount>')
  }
  xml.push('  </cac:PaymentMeans>')

  // ── Tax total ──
  xml.push('  <cac:TaxTotal>')
  xml.push(`    <cbc:TaxAmount currencyID="${esc(input.currency)}">${amount(taxTotal)}</cbc:TaxAmount>`)
  for (const st of subtotals) {
    xml.push('    <cac:TaxSubtotal>')
    xml.push(`      <cbc:TaxableAmount currencyID="${esc(input.currency)}">${amount(st.taxable)}</cbc:TaxableAmount>`)
    xml.push(`      <cbc:TaxAmount currencyID="${esc(input.currency)}">${amount(st.tax)}</cbc:TaxAmount>`)
    xml.push('      <cac:TaxCategory>')
    xml.push(`        <cbc:ID>${st.category}</cbc:ID>`)
    xml.push(`        <cbc:Percent>${st.rate.toFixed(2)}</cbc:Percent>`)
    const reason = exemptionReason(st.category)
    if (reason) {
      xml.push(`        <cbc:TaxExemptionReason>${esc(reason)}</cbc:TaxExemptionReason>`)
    }
    xml.push('        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>')
    xml.push('      </cac:TaxCategory>')
    xml.push('    </cac:TaxSubtotal>')
  }
  xml.push('  </cac:TaxTotal>')

  // ── Monetary totals ──
  xml.push('  <cac:LegalMonetaryTotal>')
  xml.push(`    <cbc:LineExtensionAmount currencyID="${esc(input.currency)}">${amount(lineExtension)}</cbc:LineExtensionAmount>`)
  xml.push(`    <cbc:TaxExclusiveAmount currencyID="${esc(input.currency)}">${amount(lineExtension)}</cbc:TaxExclusiveAmount>`)
  xml.push(`    <cbc:TaxInclusiveAmount currencyID="${esc(input.currency)}">${amount(taxInclusive)}</cbc:TaxInclusiveAmount>`)
  xml.push(`    <cbc:PayableAmount currencyID="${esc(input.currency)}">${amount(taxInclusive)}</cbc:PayableAmount>`)
  xml.push('  </cac:LegalMonetaryTotal>')

  // ── Lines ──
  input.lines.forEach((line, i) => {
    xml.push('  <cac:InvoiceLine>')
    xml.push(`    <cbc:ID>${i + 1}</cbc:ID>`)
    xml.push(`    <cbc:InvoicedQuantity unitCode="${unitCode(line.unit)}">${line.quantity}</cbc:InvoicedQuantity>`)
    xml.push(`    <cbc:LineExtensionAmount currencyID="${esc(input.currency)}">${amount(line.lineTotalExclVat)}</cbc:LineExtensionAmount>`)
    xml.push('    <cac:Item>')
    xml.push(`      <cbc:Name>${esc(line.description)}</cbc:Name>`)
    xml.push('      <cac:ClassifiedTaxCategory>')
    xml.push(`        <cbc:ID>${line.vatCategory}</cbc:ID>`)
    xml.push(`        <cbc:Percent>${line.vatRatePercent.toFixed(2)}</cbc:Percent>`)
    xml.push('        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>')
    xml.push('      </cac:ClassifiedTaxCategory>')
    xml.push('    </cac:Item>')
    xml.push('    <cac:Price>')
    xml.push(`      <cbc:PriceAmount currencyID="${esc(input.currency)}">${amount(line.unitPriceExclVat)}</cbc:PriceAmount>`)
    xml.push('    </cac:Price>')
    xml.push('  </cac:InvoiceLine>')
  })

  xml.push('</Invoice>')
  return xml.join('\n')
}
