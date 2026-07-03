import { describe, it, expect } from 'vitest'
import { camt052Format } from '../formats/camt052'
import { camt054Format } from '../formats/camt054'
import { camt053Format } from '../formats/camt053'
import { detectFileFormat, generateExternalId, parseBankFile } from '../parser'
import { generateMockCamt053Statement } from '../mock-statement'

function camt052Xml(entries: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.052.001.02">
  <BkToCstmrAcctRpt>
    <GrpHdr><MsgId>RPT-1</MsgId></GrpHdr>
    <Rpt>
      <Id>RPT-1</Id>
      <Acct><Id><IBAN>SE3550000000054910000003</IBAN></Id><Ccy>SEK</Ccy></Acct>
      ${entries}
    </Rpt>
  </BkToCstmrAcctRpt>
</Document>`
}

function camt054Xml(entries: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.054.001.02">
  <BkToCstmrDbtCdtNtfctn>
    <GrpHdr><MsgId>NTF-1</MsgId></GrpHdr>
    <Ntfctn>
      <Id>NTF-1</Id>
      <Acct><Id><IBAN>SE3550000000054910000003</IBAN></Id><Ccy>SEK</Ccy></Acct>
      ${entries}
    </Ntfctn>
  </BkToCstmrDbtCdtNtfctn>
</Document>`
}

const bookedEntry = `<Ntry>
  <NtryRef>REF-001</NtryRef>
  <Amt Ccy="SEK">1250.00</Amt>
  <CdtDbtInd>CRDT</CdtDbtInd>
  <Sts>BOOK</Sts>
  <BookgDt><Dt>2026-06-10</Dt></BookgDt>
  <NtryDtls><TxDtls><RmtInf><Strd><CdtrRefInf><Ref>20260015</Ref></CdtrRefInf></Strd></RmtInf></TxDtls></NtryDtls>
  <AddtlNtryInf>Inbetalning</AddtlNtryInf>
</Ntry>`

const pendingEntry = `<Ntry>
  <NtryRef>REF-002</NtryRef>
  <Amt Ccy="SEK">900.00</Amt>
  <CdtDbtInd>DBIT</CdtDbtInd>
  <Sts>PDNG</Sts>
  <BookgDt><Dt>2026-06-11</Dt></BookgDt>
  <AddtlNtryInf>Reserverat kortköp</AddtlNtryInf>
</Ntry>`

describe('camt.052 parser', () => {
  it('detects camt.052 XML by namespace/root', () => {
    const xml = camt052Xml(bookedEntry)
    expect(camt052Format.detect(xml, 'rapport.xml')).toBe(true)
    expect(camt053Format.detect(xml, 'rapport.xml')).toBe(false)
    expect(detectFileFormat(xml, 'rapport.xml')?.id).toBe('camt052')
  })

  it('parses booked entries with OCR reference', () => {
    const result = camt052Format.parse(camt052Xml(bookedEntry))
    expect(result.transactions).toHaveLength(1)
    expect(result.transactions[0]).toMatchObject({
      date: '2026-06-10',
      amount: 1250,
      reference: '20260015',
    })
  })

  it('skips pending (PDNG) entries with a warning — only booked entries book', () => {
    const result = camt052Format.parse(camt052Xml(bookedEntry + pendingEntry))
    expect(result.transactions).toHaveLength(1)
    expect(result.issues.some((i) => i.message.includes('PDNG'))).toBe(true)
    expect(result.stats.skipped_rows).toBe(1)
  })
})

describe('camt.054 parser', () => {
  it('detects camt.054 XML', () => {
    const xml = camt054Xml(bookedEntry)
    expect(camt054Format.detect(xml, 'avisering.xml')).toBe(true)
    expect(detectFileFormat(xml, 'avisering.xml')?.id).toBe('camt054')
  })

  it('parses debit/credit notifications', () => {
    const debitEntry = bookedEntry.replace('CRDT', 'DBIT')
    const result = camt054Format.parse(camt054Xml(debitEntry))
    expect(result.transactions).toHaveLength(1)
    expect(result.transactions[0].amount).toBe(-1250)
  })
})

describe('cross-format dedup', () => {
  it('same entry reference dedups across camt.052 and camt.053 (shared external_id namespace)', () => {
    const tx = { date: '2026-06-10', description: 'X', amount: 100, currency: 'SEK', raw_line: 'REF-001' }
    const id052 = generateExternalId(tx, 'camt052', 0)
    const id053 = generateExternalId(tx, 'camt053', 5)
    const id054 = generateExternalId(tx, 'camt054', 9)
    expect(id052).toBe(id053)
    expect(id053).toBe(id054)
    expect(id053).toBe('camt053_REF-001')
  })

  it('falls back to composite hash when no entry reference exists', () => {
    const tx = { date: '2026-06-10', description: 'X', amount: 100, currency: 'SEK', raw_line: 'camt052_entry_0' }
    const id = generateExternalId(tx, 'camt052', 0)
    expect(id.startsWith('camt052_')).toBe(true)
    expect(id).not.toBe('camt053_camt052_entry_0')
  })
})

describe('mock statement generator (sandbox provider)', () => {
  it('produces a camt.053 statement the real parser accepts', () => {
    const xml = generateMockCamt053Statement([
      { date: '2026-06-02', amount: 31250, description: 'Inbetalning', reference: '20260015' },
      { date: '2026-06-05', amount: -12500, description: 'Leverantörsbetalning', counterparty: 'IT AB' },
    ])
    const result = parseBankFile(xml, 'mock.xml')
    expect(result.format).toBe('camt053')
    expect(result.transactions).toHaveLength(2)
    expect(result.transactions[0].amount).toBe(31250)
    expect(result.transactions[0].reference).toBe('20260015')
    expect(result.transactions[1].amount).toBe(-12500)
  })

  it('is deterministic — same input yields identical entry references', () => {
    const txs = [{ date: '2026-06-02', amount: 100, description: 'A' }]
    const a = generateMockCamt053Statement(txs, { statementId: 'S1' })
    const b = generateMockCamt053Statement(txs, { statementId: 'S1' })
    // CreDtTm differs; entry refs must not.
    expect(a).toContain('S1-NTRY-0001')
    expect(b).toContain('S1-NTRY-0001')
  })
})
