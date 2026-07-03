import { describe, it, expect } from 'vitest'
import { generateSupplierPain001 } from '../supplier-pain001'

const company = {
  name: 'Testbolaget AB',
  orgNumber: '556123-4567',
  iban: 'SE3550000000054910000003',
  bic: 'ESSESESS',
}

describe('generateSupplierPain001', () => {
  it('generates a pain.001 with BGNR creditor scheme for bankgiro suppliers', () => {
    const result = generateSupplierPain001(
      company,
      [{
        endToEndId: 'MSG-TX0001',
        creditorName: 'IT-Grossisten AB',
        bankgiro: '123-4567',
        reference: '20260015',
        amount: 12500,
      }],
      { messageId: 'MSG1', paymentDate: '2026-07-15' },
    )

    expect(result.xml).toContain('pain.001.001.03')
    expect(result.xml).toContain('<Prtry>BGNR</Prtry>')
    expect(result.xml).toContain('<Id>1234567</Id>') // dash stripped
    expect(result.xml).toContain('<Cd>SUPP</Cd>')
    expect(result.xml).toContain('<ReqdExctnDt>2026-07-15</ReqdExctnDt>')
    // SCOR structured OCR remittance
    expect(result.xml).toContain('<Cd>SCOR</Cd>')
    expect(result.xml).toContain('<Ref>20260015</Ref>')
    expect(result.totalAmount).toBe(12500)
    expect(result.paymentCount).toBe(1)
  })

  it('uses IBAN when the supplier has one', () => {
    const result = generateSupplierPain001(
      company,
      [{
        endToEndId: 'MSG-TX0001',
        creditorName: 'Utländsk AB',
        iban: 'SE1250000000058398257466',
        amount: 900,
      }],
      { messageId: 'MSG2', paymentDate: '2026-07-15' },
    )
    expect(result.xml).toContain('<IBAN>SE1250000000058398257466</IBAN>')
    expect(result.xml).not.toContain('BGNR')
  })

  it('falls back to unstructured remittance for non-OCR references', () => {
    const result = generateSupplierPain001(
      company,
      [{
        endToEndId: 'MSG-TX0001',
        creditorName: 'Lokal Firma',
        plusgiro: '12345-6',
        reference: 'Faktura F-2026-01',
        amount: 500,
      }],
      { messageId: 'MSG3', paymentDate: '2026-07-15' },
    )
    expect(result.xml).toContain('<Ustrd>Faktura F-2026-01</Ustrd>')
    expect(result.xml).toContain('<Prtry>PGNR</Prtry>')
  })

  it('sums CtrlSum over all payments', () => {
    const result = generateSupplierPain001(
      company,
      [
        { endToEndId: 'TX1', creditorName: 'A', bankgiro: '123-4567', amount: 100.5 },
        { endToEndId: 'TX2', creditorName: 'B', bankgiro: '991-2346', amount: 200.25 },
      ],
      { messageId: 'MSG4', paymentDate: '2026-07-15' },
    )
    expect(result.xml).toContain('<CtrlSum>300.75</CtrlSum>')
    expect(result.xml).toContain('<NbOfTxs>2</NbOfTxs>')
  })

  it('rejects suppliers without payment details', () => {
    expect(() =>
      generateSupplierPain001(
        company,
        [{ endToEndId: 'TX1', creditorName: 'Bankuppgiftslös AB', amount: 100 }],
        { messageId: 'MSG5', paymentDate: '2026-07-15' },
      ),
    ).toThrow(/saknar betalningsuppgifter/)
  })

  it('rejects non-positive amounts', () => {
    expect(() =>
      generateSupplierPain001(
        company,
        [{ endToEndId: 'TX1', creditorName: 'A', bankgiro: '123-4567', amount: 0 }],
        { messageId: 'MSG6', paymentDate: '2026-07-15' },
      ),
    ).toThrow(/beloppet/)
  })

  it('escapes XML in names and references', () => {
    const result = generateSupplierPain001(
      company,
      [{ endToEndId: 'TX1', creditorName: 'A & B <AB>', bankgiro: '123-4567', reference: 'Ref & Co', amount: 10 }],
      { messageId: 'MSG7', paymentDate: '2026-07-15' },
    )
    expect(result.xml).toContain('A &amp; B &lt;AB&gt;')
    expect(result.xml).not.toContain('A & B <AB>')
  })
})
