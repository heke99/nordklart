/**
 * Mock bank-statement generator (sandbox/test provider).
 *
 * Produces a deterministic ISO 20022 camt.053 statement with Swedish-style
 * transactions. Used by:
 *   - unit tests (feeds the real camt parser — no fixtures drift)
 *   - sandbox/demo companies (import a realistic statement without a live
 *     PSD2 consent, exercising the full ingest → matching → automation flow)
 *
 * Deterministic: same seed → same statement, so dedup behaviour is testable.
 */

export interface MockStatementTransaction {
  date: string // YYYY-MM-DD
  amount: number // positive = inbetalning, negative = utbetalning
  description: string
  counterparty?: string
  /** OCR reference for inbetalningar. */
  reference?: string
}

export interface MockStatementOptions {
  iban?: string
  currency?: string
  /** Statement id — also seeds entry references. */
  statementId?: string
}

/** Render transactions as a camt.053 XML statement. */
export function generateMockCamt053Statement(
  transactions: MockStatementTransaction[],
  options: MockStatementOptions = {},
): string {
  const iban = options.iban ?? 'SE3550000000054910000003'
  const currency = options.currency ?? 'SEK'
  const stmtId = options.statementId ?? 'MOCK-STMT-1'

  const entries = transactions.map((tx, i) => {
    const isCredit = tx.amount >= 0
    const abs = Math.abs(tx.amount).toFixed(2)
    const entryRef = `${stmtId}-NTRY-${String(i + 1).padStart(4, '0')}`
    return [
      '      <Ntry>',
      `        <NtryRef>${entryRef}</NtryRef>`,
      `        <Amt Ccy="${currency}">${abs}</Amt>`,
      `        <CdtDbtInd>${isCredit ? 'CRDT' : 'DBIT'}</CdtDbtInd>`,
      '        <Sts>BOOK</Sts>',
      `        <BookgDt><Dt>${tx.date}</Dt></BookgDt>`,
      `        <ValDt><Dt>${tx.date}</Dt></ValDt>`,
      `        <AcctSvcrRef>${entryRef}</AcctSvcrRef>`,
      '        <NtryDtls>',
      '          <TxDtls>',
      '            <RltdPties>',
      isCredit
        ? `              <Dbtr><Nm>${escapeXml(tx.counterparty ?? 'Kund AB')}</Nm></Dbtr>`
        : `              <Cdtr><Nm>${escapeXml(tx.counterparty ?? 'Leverantör AB')}</Nm></Cdtr>`,
      '            </RltdPties>',
      '            <RmtInf>',
      tx.reference
        ? `              <Strd><CdtrRefInf><Tp><CdOrPrtry><Cd>SCOR</Cd></CdOrPrtry></Tp><Ref>${escapeXml(tx.reference)}</Ref></CdtrRefInf></Strd>`
        : `              <Ustrd>${escapeXml(tx.description)}</Ustrd>`,
      '            </RmtInf>',
      '          </TxDtls>',
      '        </NtryDtls>',
      `        <AddtlNtryInf>${escapeXml(tx.description)}</AddtlNtryInf>`,
      '      </Ntry>',
    ].join('\n')
  })

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">',
    '  <BkToCstmrStmt>',
    '    <GrpHdr>',
    `      <MsgId>${stmtId}</MsgId>`,
    `      <CreDtTm>${new Date().toISOString()}</CreDtTm>`,
    '    </GrpHdr>',
    '    <Stmt>',
    `      <Id>${stmtId}</Id>`,
    '      <Acct>',
    `        <Id><IBAN>${iban}</IBAN></Id>`,
    `        <Ccy>${currency}</Ccy>`,
    '      </Acct>',
    ...entries,
    '    </Stmt>',
    '  </BkToCstmrStmt>',
    '</Document>',
  ].join('\n')
}

/**
 * A realistic demo month for sandbox companies: customer payments with OCR,
 * supplier payments, bank fee, salary batch and a Skatteverket payment.
 */
export function buildDemoStatementTransactions(monthIso: string): MockStatementTransaction[] {
  const d = (day: number) => `${monthIso}-${String(day).padStart(2, '0')}`
  return [
    { date: d(2), amount: 31250, description: 'Inbetalning BG 123-4567', counterparty: 'Kund Alfa AB', reference: '20260015' },
    { date: d(5), amount: -12500, description: 'Leverantörsbetalning', counterparty: 'IT-Grossisten AB' },
    { date: d(8), amount: -1990, description: 'Programvara månadsavgift', counterparty: 'SaaS Nordic AB' },
    { date: d(12), amount: 18750, description: 'Inbetalning BG 123-4567', counterparty: 'Kund Beta HB', reference: '20260023' },
    { date: d(15), amount: -85, description: 'Bankavgift', counterparty: 'Banken' },
    { date: d(25), amount: -32000, description: 'Löner', counterparty: 'Lönebatch' },
    { date: d(26), amount: -14380, description: 'Skatteverket skattekonto', counterparty: 'Skatteverket' },
  ]
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
