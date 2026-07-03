import { describe, it, expect } from 'vitest'
import { parsePain002, isPain002 } from '../pain002-parser'

function pain002Xml(args: {
  originalMsgId?: string
  grpSts?: string
  transactions?: Array<{ endToEndId: string; status: string; reasonCode?: string; reasonText?: string }>
}): string {
  const txBlocks = (args.transactions ?? []).map((tx) => `
      <TxInfAndSts>
        <OrgnlEndToEndId>${tx.endToEndId}</OrgnlEndToEndId>
        <TxSts>${tx.status}</TxSts>
        ${tx.reasonCode ? `<StsRsnInf><Rsn><Cd>${tx.reasonCode}</Cd></Rsn>${tx.reasonText ? `<AddtlInf>${tx.reasonText}</AddtlInf>` : ''}</StsRsnInf>` : ''}
      </TxInfAndSts>`).join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.002.001.03">
  <CstmrPmtStsRpt>
    <GrpHdr><MsgId>BANK-RESP-1</MsgId></GrpHdr>
    <OrgnlGrpInfAndSts>
      <OrgnlMsgId>${args.originalMsgId ?? 'NKAP123'}</OrgnlMsgId>
      <OrgnlMsgNmId>pain.001.001.03</OrgnlMsgNmId>
      ${args.grpSts ? `<GrpSts>${args.grpSts}</GrpSts>` : ''}
    </OrgnlGrpInfAndSts>
    <OrgnlPmtInfAndSts>
      <OrgnlPmtInfId>NKAP123-PMT</OrgnlPmtInfId>
      ${txBlocks}
    </OrgnlPmtInfAndSts>
  </CstmrPmtStsRpt>
</Document>`
}

describe('isPain002', () => {
  it('recognizes CstmrPmtStsRpt documents', () => {
    expect(isPain002(pain002Xml({}))).toBe(true)
    expect(isPain002('<Document><BkToCstmrStmt/></Document>')).toBe(false)
  })
})

describe('parsePain002', () => {
  it('extracts the original message id and accepted group status', () => {
    const result = parsePain002(pain002Xml({ originalMsgId: 'NKAP999', grpSts: 'ACCP' }))
    expect(result.originalMessageId).toBe('NKAP999')
    expect(result.groupStatus).toBe('accepted')
  })

  it('maps RJCT to rejected with reason codes per transaction', () => {
    const result = parsePain002(pain002Xml({
      grpSts: 'RJCT',
      transactions: [
        { endToEndId: 'NKAP123-TX0001', status: 'RJCT', reasonCode: 'AM04', reasonText: 'Insufficient funds' },
      ],
    }))
    expect(result.groupStatus).toBe('rejected')
    expect(result.transactions).toHaveLength(1)
    expect(result.transactions[0]).toMatchObject({
      originalEndToEndId: 'NKAP123-TX0001',
      status: 'rejected',
      reasonCode: 'AM04',
      reasonText: 'Insufficient funds',
    })
  })

  it('maps ACSC to settled', () => {
    expect(parsePain002(pain002Xml({ grpSts: 'ACSC' })).groupStatus).toBe('settled')
  })

  it('maps PART to partially_accepted', () => {
    expect(parsePain002(pain002Xml({ grpSts: 'PART' })).groupStatus).toBe('partially_accepted')
  })

  it('derives group status from transactions when GrpSts is absent', () => {
    const result = parsePain002(pain002Xml({
      transactions: [
        { endToEndId: 'TX1', status: 'ACSP' },
        { endToEndId: 'TX2', status: 'RJCT', reasonCode: 'AC01' },
      ],
    }))
    expect(result.groupStatus).toBe('partially_accepted')
  })

  it('flags missing OrgnlMsgId as an issue', () => {
    const broken = '<Document><CstmrPmtStsRpt><GrpHdr><MsgId>X</MsgId></GrpHdr></CstmrPmtStsRpt></Document>'
    const result = parsePain002(broken)
    expect(result.originalMessageId).toBeNull()
    expect(result.issues.length).toBeGreaterThan(0)
  })
})
