import { describe, expect, it } from 'vitest'
import {
  assertK2FormalReportModel,
  buildK2FormalReportModel,
  formalBalanceSheetLines,
  formalIncomeStatementLines,
} from '../k2-model'

const current = {
  preClosing: [
    { account_number: '1930', account_name: 'Företagskonto', closing_debit: 125, closing_credit: 0 },
    { account_number: '3001', account_name: 'Försäljning', closing_debit: 0, closing_credit: 100 },
    { account_number: '2611', account_name: 'Utgående moms', closing_debit: 0, closing_credit: 25 },
  ],
  full: [
    { account_number: '1930', account_name: 'Företagskonto', closing_debit: 125, closing_credit: 0 },
    { account_number: '2099', account_name: 'Årets resultat', closing_debit: 0, closing_credit: 100 },
    { account_number: '2611', account_name: 'Utgående moms', closing_debit: 0, closing_credit: 25 },
  ],
}

const previous = {
  preClosing: [
    { account_number: '1930', account_name: 'Företagskonto', closing_debit: 100, closing_credit: 0 },
    { account_number: '3001', account_name: 'Försäljning', closing_debit: 0, closing_credit: 80 },
    { account_number: '2611', account_name: 'Utgående moms', closing_debit: 0, closing_credit: 20 },
  ],
  full: [
    { account_number: '1930', account_name: 'Företagskonto', closing_debit: 100, closing_credit: 0 },
    { account_number: '2099', account_name: 'Årets resultat', closing_debit: 0, closing_credit: 80 },
    { account_number: '2611', account_name: 'Utgående moms', closing_debit: 0, closing_credit: 20 },
  ],
}

describe('canonical K2 formal report model', () => {
  it('drives all PDF rows and iXBRL concepts from the same node values', () => {
    const model = buildK2FormalReportModel(current, previous)
    expect(() => assertK2FormalReportModel(model)).not.toThrow()

    const revenueNode = model.nodes.find(
      (node) => node.taxonomyConcept === 'Nettoomsattning',
    )
    expect(revenueNode).toMatchObject({ current: 100, previous: 80, displayCurrent: 100 })

    const pdfRevenue = formalIncomeStatementLines(model).find(
      (line) => line.label === revenueNode?.label,
    )
    expect(pdfRevenue).toMatchObject({ amount: 100, prior_amount: 80 })

    const pdfBalance = formalBalanceSheetLines(model)
    expect(pdfBalance.total_assets).toBe(model.totals.tillgangar.current)
    expect(pdfBalance.total_equity_liabilities).toBe(
      model.totals.egetKapitalSkulder.current,
    )
  })

  it('classifies 21xx as untaxed reserves rather than equity', () => {
    const withReserve = {
      preClosing: current.preClosing,
      full: [
        { account_number: '1930', account_name: 'Företagskonto', closing_debit: 225, closing_credit: 0 },
        { account_number: '2099', account_name: 'Årets resultat', closing_debit: 0, closing_credit: 100 },
        { account_number: '2110', account_name: 'Periodiseringsfond', closing_debit: 0, closing_credit: 100 },
        { account_number: '2611', account_name: 'Utgående moms', closing_debit: 0, closing_credit: 25 },
      ],
    }
    const model = buildK2FormalReportModel(withReserve, null)
    expect(model.br.Periodiseringsfonder.current).toBe(100)
    expect(model.totals.obeskattadeReserver.current).toBe(100)
    expect(model.totals.egetKapital.current).toBe(100)
  })
})
