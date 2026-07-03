/**
 * pain.001 (ISO 20022 CustomerCreditTransferInitiation) generator for
 * supplier payments (leverantörsbetalningar).
 *
 * Generalizes the salary pain.001 generator: creditors may be identified by
 * Bankgiro number (BGNR proprietary scheme — the normal Swedish AP case),
 * Plusgiro (PGNR) or IBAN. Remittance carries the OCR/payment reference so
 * the supplier's reconciliation matches automatically.
 *
 * The generated file is uploaded to the bank's corporate portal (all major
 * Swedish banks accept pain.001.001.03 for leverantörsbetalningar). The bank
 * answers with pain.002 — parsed by lib/payments/pain002-parser.ts, which
 * updates the payment_initiations row.
 *
 * Per BFL 7 kap: the generated file is räkenskapsinformation and is stored
 * on the payment_initiations row (7-year retention, no hard deletes).
 */

import { roundOre } from '@/lib/money'

export interface SupplierPaymentCompany {
  name: string
  orgNumber: string
  /** Debtor account: IBAN (SE + 22 digits). */
  iban: string
  bic: string
}

export interface SupplierPaymentItem {
  /** End-to-end id — ties the pain.002 status back to this payment. */
  endToEndId: string
  creditorName: string
  /** Exactly one of bankgiro / plusgiro / iban must be set. */
  bankgiro?: string | null
  plusgiro?: string | null
  iban?: string | null
  /** OCR or free-text payment reference printed in RmtInf. */
  reference?: string | null
  amount: number
  supplierInvoiceId?: string
}

export interface SupplierPaymentOptions {
  messageId: string
  paymentDate: string // YYYY-MM-DD
}

export interface SupplierPain001Result {
  xml: string
  totalAmount: number
  paymentCount: number
  filename: string
}

export function generateSupplierPain001(
  company: SupplierPaymentCompany,
  payments: SupplierPaymentItem[],
  options: SupplierPaymentOptions,
): SupplierPain001Result {
  if (payments.length === 0) {
    throw new Error('Inga betalningar att inkludera i betalfilen.')
  }
  for (const p of payments) {
    if (p.amount <= 0) {
      throw new Error(`Ogiltigt belopp för ${p.creditorName}: beloppet måste vara större än 0.`)
    }
    if (!p.bankgiro && !p.plusgiro && !p.iban) {
      throw new Error(
        `Leverantören ${p.creditorName} saknar betalningsuppgifter (bankgiro, plusgiro eller IBAN).`
      )
    }
  }

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const totalAmount = roundOre(payments.reduce((sum, p) => sum + p.amount, 0))

  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"')
  lines.push('  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">')
  lines.push('  <CstmrCdtTrfInitn>')

  // ─── Group Header ───
  lines.push('    <GrpHdr>')
  lines.push(`      <MsgId>${escapeXml(options.messageId)}</MsgId>`)
  lines.push(`      <CreDtTm>${now}</CreDtTm>`)
  lines.push(`      <NbOfTxs>${payments.length}</NbOfTxs>`)
  lines.push(`      <CtrlSum>${formatDecimal(totalAmount)}</CtrlSum>`)
  lines.push('      <InitgPty>')
  lines.push(`        <Nm>${escapeXml(company.name)}</Nm>`)
  lines.push('        <Id>')
  lines.push('          <OrgId>')
  lines.push(`            <Othr><Id>${escapeXml(company.orgNumber.replace('-', ''))}</Id></Othr>`)
  lines.push('          </OrgId>')
  lines.push('        </Id>')
  lines.push('      </InitgPty>')
  lines.push('    </GrpHdr>')

  // ─── Payment Information ───
  lines.push('    <PmtInf>')
  lines.push(`      <PmtInfId>${escapeXml(options.messageId)}-PMT</PmtInfId>`)
  lines.push('      <PmtMtd>TRF</PmtMtd>')
  lines.push('      <BtchBookg>true</BtchBookg>')
  lines.push(`      <NbOfTxs>${payments.length}</NbOfTxs>`)
  lines.push(`      <CtrlSum>${formatDecimal(totalAmount)}</CtrlSum>`)
  lines.push('      <PmtTpInf>')
  lines.push('        <CtgyPurp><Cd>SUPP</Cd></CtgyPurp>')  // Supplier payment
  lines.push('      </PmtTpInf>')
  lines.push(`      <ReqdExctnDt>${options.paymentDate}</ReqdExctnDt>`)

  // Debtor (company)
  lines.push('      <Dbtr>')
  lines.push(`        <Nm>${escapeXml(company.name)}</Nm>`)
  lines.push('      </Dbtr>')
  lines.push('      <DbtrAcct>')
  lines.push('        <Id>')
  lines.push(`          <IBAN>${escapeXml(company.iban)}</IBAN>`)
  lines.push('        </Id>')
  lines.push('        <Ccy>SEK</Ccy>')
  lines.push('      </DbtrAcct>')
  lines.push('      <DbtrAgt>')
  lines.push('        <FinInstnId>')
  lines.push(`          <BIC>${escapeXml(company.bic)}</BIC>`)
  lines.push('        </FinInstnId>')
  lines.push('      </DbtrAgt>')

  // ─── Per-supplier credit transfers ───
  for (const p of payments) {
    lines.push('      <CdtTrfTxInf>')
    lines.push('        <PmtId>')
    lines.push(`          <InstrId>${escapeXml(p.endToEndId)}</InstrId>`)
    lines.push(`          <EndToEndId>${escapeXml(p.endToEndId)}</EndToEndId>`)
    lines.push('        </PmtId>')
    lines.push('        <Amt>')
    lines.push(`          <InstdAmt Ccy="SEK">${formatDecimal(p.amount)}</InstdAmt>`)
    lines.push('        </Amt>')
    lines.push('        <Cdtr>')
    lines.push(`          <Nm>${escapeXml(p.creditorName)}</Nm>`)
    lines.push('        </Cdtr>')
    lines.push('        <CdtrAcct>')
    lines.push('          <Id>')
    if (p.iban) {
      lines.push(`            <IBAN>${escapeXml(p.iban)}</IBAN>`)
    } else if (p.bankgiro) {
      const bg = p.bankgiro.replace(/[-\s]/g, '')
      lines.push('            <Othr>')
      lines.push(`              <Id>${escapeXml(bg)}</Id>`)
      lines.push('              <SchmeNm><Prtry>BGNR</Prtry></SchmeNm>')
      lines.push('            </Othr>')
    } else {
      const pg = (p.plusgiro ?? '').replace(/[-\s]/g, '')
      lines.push('            <Othr>')
      lines.push(`              <Id>${escapeXml(pg)}</Id>`)
      lines.push('              <SchmeNm><Prtry>PGNR</Prtry></SchmeNm>')
      lines.push('            </Othr>')
    }
    lines.push('          </Id>')
    lines.push('        </CdtrAcct>')
    lines.push('        <RmtInf>')
    if (p.reference && /^\d{2,25}$/.test(p.reference.replace(/\s/g, ''))) {
      // Structured OCR reference (SCOR) — the supplier's bank matches it
      // automatically against their reskontra.
      lines.push('          <Strd>')
      lines.push('            <CdtrRefInf>')
      lines.push('              <Tp><CdOrPrtry><Cd>SCOR</Cd></CdOrPrtry></Tp>')
      lines.push(`              <Ref>${escapeXml(p.reference.replace(/\s/g, ''))}</Ref>`)
      lines.push('            </CdtrRefInf>')
      lines.push('          </Strd>')
    } else {
      lines.push(`          <Ustrd>${escapeXml(p.reference || p.endToEndId)}</Ustrd>`)
    }
    lines.push('        </RmtInf>')
    lines.push('      </CdtTrfTxInf>')
  }

  lines.push('    </PmtInf>')
  lines.push('  </CstmrCdtTrfInitn>')
  lines.push('</Document>')

  return {
    xml: lines.join('\n'),
    totalAmount,
    paymentCount: payments.length,
    filename: `leverantorsbetalningar-${options.paymentDate}-${options.messageId}.xml`,
  }
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function formatDecimal(amount: number): string {
  return roundOre(amount).toFixed(2)
}
