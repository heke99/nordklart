import { describe, expect, it } from 'vitest'
import {
  applyPresentationReclassifications,
  applyVerifiedComparativeSnapshot,
  buildK2FormalReportModel,
  formalBalanceSheetLines,
} from '@/lib/bokslut/formal-report/k2-model'
import type { TrialBalanceRow } from '@/types'

const row = (
  account_number: string,
  closing_debit: number,
  closing_credit: number,
): TrialBalanceRow => ({
  account_number,
  account_name: account_number,
  account_class: Number(account_number[0]),
  opening_debit: 0,
  opening_credit: 0,
  period_debit: closing_debit,
  period_credit: closing_credit,
  closing_debit,
  closing_credit,
})

describe('verified annual-report comparatives', () => {
  it('copies prior current values without querying a live prior ledger', () => {
    const current = buildK2FormalReportModel(
      { full: [row('1930', 100, 0), row('2081', 0, 100)], preClosing: [] },
      null,
    )
    const prior = buildK2FormalReportModel(
      { full: [row('1930', 80, 0), row('2081', 0, 80)], preClosing: [] },
      null,
    )
    const result = applyVerifiedComparativeSnapshot(current, prior)
    expect(result.totals.tillgangar.previous).toBe(prior.totals.tillgangar.current)
    expect(result.totals.egetKapitalSkulder.previous).toBe(
      prior.totals.egetKapitalSkulder.current,
    )
  })

  it('does not duplicate the two balance-sheet grand totals in row arrays', () => {
    const model = buildK2FormalReportModel(
      { full: [row('1930', 100, 0), row('2081', 0, 100)], preClosing: [] },
      null,
    )
    const balance = formalBalanceSheetLines(model)
    expect(balance.assets.filter((line) => line.label === 'Summa tillgångar')).toHaveLength(0)
    expect(
      balance.equity_liabilities.filter(
        (line) => line.label === 'Summa eget kapital och skulder',
      ),
    ).toHaveLength(0)
  })
  it('moves an abnormal debtor balance on a liability account to an asset presentation only', () => {
    const model = buildK2FormalReportModel(
      {
        full: [
          row('1930', 100, 0),
          row('1680', 0, 0),
          row('2081', 0, 120),
          row('2893', 20, 0),
        ],
        preClosing: [],
      },
      null,
    )
    expect(model.br.OvrigaKortfristigaSkulder.current).toBe(-20)

    const result = applyPresentationReclassifications(model, [
      {
        id: 'reclass-1',
        account_number: '2893',
        source_concept: 'OvrigaKortfristigaSkulder',
        target_concept: 'OvrigaFordringarKortfristiga',
        amount: 20,
        reason: 'Debetsaldot är en verifierad fordran och presenteras separat.',
      },
    ])

    expect(result.br.OvrigaKortfristigaSkulder.current).toBe(0)
    expect(result.br.OvrigaFordringarKortfristiga.current).toBe(20)
    expect(result.totals.tillgangar.current).toBe(result.totals.egetKapitalSkulder.current)
  })

  it('rejects a presentation move that does not target an asset concept', () => {
    const model = buildK2FormalReportModel(
      { full: [row('1930', 100, 0), row('2081', 0, 120), row('2893', 20, 0)], preClosing: [] },
      null,
    )
    expect(() =>
      applyPresentationReclassifications(model, [
        {
          id: 'reclass-invalid',
          account_number: '2893',
          source_concept: 'OvrigaKortfristigaSkulder',
          target_concept: 'Leverantorsskulder',
          amount: 20,
          reason: 'Ogiltig testomklassificering till en annan skuldrad.',
        },
      ]),
    ).toThrow(/negative liability to an asset concept/)
  })

})
