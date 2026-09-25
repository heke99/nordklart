import { describe, it, expect, vi, beforeEach } from 'vitest'

const created: Array<{ lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }> }> = []
vi.mock('@/lib/bookkeeping/engine', () => ({
  findFiscalPeriod: vi.fn().mockResolvedValue('fp-1'),
  createDraftEntry: vi.fn(async (_s: unknown, _c: unknown, _u: unknown, input: { lines: never[] }) => {
    created.push(input)
    return { id: `je-${created.length}` }
  }),
}))
vi.mock('@/lib/events', () => ({ eventBus: { emit: vi.fn() } }))

import { createSalaryRunEntries, resolveLineAccount } from '../salary-entries'
import { calculateSalary } from '../calculation-engine'

function supabaseWithAllAccounts() {
  const q: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in']) q[m] = () => q
  q.insert = async () => ({ error: null })
  const rpc = vi.fn(async () => ({ data: { id: 'run', status: 'booked' }, error: null }))
  q.then = (resolve: (v: unknown) => void) => resolve({ data: [
    '7210', '7220', '7240', '7281', '7285', '7321', '7331', '1610', '2790', '7388', '2710', '1930', '7510', '2731', '2920', '2940', '7519', '7410', '2740', '7533', '2514', '7218', '7385',
  ].map((account_number) => ({ account_number })), error: null })
  return { from: () => q, rpc } as never
}

function balance(entry: (typeof created)[number]) {
  const debit = entry.lines.reduce((s, l) => s + l.debit_amount, 0)
  const credit = entry.lines.reduce((s, l) => s + l.credit_amount, 0)
  return Math.round((debit - credit) * 100) / 100
}

beforeEach(() => {
  created.length = 0
  vi.clearAllMocks()
})

describe('salary entry', () => {
  it('balances with nettolöneavdrag and skattefria ersättningar', async () => {
    const run = {
      id: 'run-1', period_year: 2026, period_month: 3, payment_date: '2026-03-25', voucher_series: 'L',
      total_gross: 40000, total_tax: 10000, total_net: 30000, total_avgifter: 12568, total_vacation_accrual: 0,
      employees: [{
        employee_id: 'e1', employment_type: 'employee',
        // gross 40 000, tax 10 000, fackavgift 400, förskott 1 000, skattefritt traktamente 900
        gross_salary: 40000, tax_withheld: 10000, net_salary: 40000 - 10000 - 1400 + 900,
        avgifter_amount: 12568, avgifter_rate: 0.3142, vacation_accrual: 0, vacation_accrual_avgifter: 0,
        line_items: [
          { item_type: 'monthly_salary', amount: 40000, account_number: '7210', is_net_deduction: false, is_gross_deduction: false },
          { item_type: 'traktamente_taxfree', amount: 900, account_number: null, is_net_deduction: false, is_gross_deduction: false },
          { item_type: 'net_deduction_union', amount: -400, account_number: '7210', is_net_deduction: true, is_gross_deduction: false },
          { item_type: 'net_deduction_advance', amount: 1000, account_number: null, is_net_deduction: true, is_gross_deduction: false },
        ],
      }],
    }

    await createSalaryRunEntries(supabaseWithAllAccounts(), 'c1', 'u1', run)

    const salary = created[0]
    expect(balance(salary)).toBe(0)
    const byAccount = Object.fromEntries(salary.lines.map((l) => [l.account_number, l.debit_amount - l.credit_amount]))
    expect(byAccount).toMatchObject({ '7210': 40000, '7321': 900, '2790': -400, '1610': -1000, '2710': -10000, '1930': -29500 })
  })

  it('an engine result books balanced end to end', async () => {
    const result = calculateSalary(
      {
        employmentType: 'employee', salaryType: 'monthly', monthlySalary: 35000, employmentDegree: 100,
        taxTableNumber: null as never, taxColumn: 1, isSidoinkomst: true, jamkningPercentage: null,
        jamkningValidFrom: null, jamkningValidTo: null, fSkattStatus: 'a_skatt', personnummer: 'x',
        paymentDate: '2026-03-25', vacationRule: 'none', vacationDaysPerYear: 25, semestertillaggRate: 0,
        vaxaStodEligible: false, vaxaStodStart: null, vaxaStodEnd: null,
        lineItems: [
          { itemType: 'mileage_taxfree', amount: 500, isTaxable: false, isAvgiftBasis: false, isVacationBasis: false, isGrossDeduction: false, isNetDeduction: false },
          { itemType: 'traktamente_taxable', amount: 200, isTaxable: true, isAvgiftBasis: true, isVacationBasis: false, isGrossDeduction: false, isNetDeduction: false },
          { itemType: 'net_deduction_union', amount: -300, isTaxable: false, isAvgiftBasis: false, isVacationBasis: false, isGrossDeduction: false, isNetDeduction: true },
        ],
      } as never,
      { avgifterTotal: 0.3142, avgifterReduced65plus: 0.1021 } as never,
      [],
    )
    expect(result.grossSalary).toBe(35200)
    expect(result.taxFreeAllowances).toBe(500)
    expect(result.netSalary).toBe(35200 - result.taxWithheld - 300 + 500)

    await createSalaryRunEntries(supabaseWithAllAccounts(), 'c1', 'u1', {
      id: 'run-2', period_year: 2026, period_month: 3, payment_date: '2026-03-25', voucher_series: 'L',
      total_gross: result.grossSalary, total_tax: result.taxWithheld, total_net: result.netSalary,
      total_avgifter: result.avgifterAmount, total_vacation_accrual: 0,
      employees: [{
        employee_id: 'e1', employment_type: 'employee', gross_salary: result.grossSalary, tax_withheld: result.taxWithheld,
        net_salary: result.netSalary, avgifter_amount: result.avgifterAmount, avgifter_rate: result.avgifterRate,
        vacation_accrual: 0, vacation_accrual_avgifter: 0,
        line_items: [
          { item_type: 'monthly_salary', amount: 35000, account_number: null, is_net_deduction: false, is_gross_deduction: false },
          { item_type: 'mileage_taxfree', amount: 500, account_number: null, is_net_deduction: false, is_gross_deduction: false },
          { item_type: 'traktamente_taxable', amount: 200, account_number: null, is_net_deduction: false, is_gross_deduction: false },
          { item_type: 'net_deduction_union', amount: -300, account_number: null, is_net_deduction: true, is_gross_deduction: false },
        ],
      }],
    })
    for (const entry of created) expect(balance(entry)).toBe(0)
  })
})

describe('F-skatt', () => {
  it('no skatteavdrag and no arbetsgivaravgifter', () => {
    const result = calculateSalary(
      {
        employmentType: 'board_member', salaryType: 'monthly', monthlySalary: 10000, employmentDegree: 100,
        taxTableNumber: null, taxColumn: 1, isSidoinkomst: false, jamkningPercentage: null,
        jamkningValidFrom: null, jamkningValidTo: null, fSkattStatus: 'f_skatt', personnummer: 'x',
        paymentDate: '2026-03-25', vacationRule: 'none', vacationDaysPerYear: 25, semestertillaggRate: 0,
        vaxaStodEligible: false, vaxaStodStart: null, vaxaStodEnd: null, lineItems: [],
      } as never,
      { avgifterTotal: 0.3142 } as never,
      [],
    )
    expect(result.taxWithheld).toBe(0)
    expect(result.avgifterAmount).toBe(0)
    expect(result.avgifterCategory).toBe('exempt')
  })
})

describe('resolveLineAccount', () => {
  it('maps a legacy 7210 net deduction to 2790', () => {
    expect(resolveLineAccount({ item_type: 'net_deduction_union', account_number: '7210', is_net_deduction: true }, 'employee')).toBe('2790')
  })
  it('keeps a deliberately chosen account', () => {
    expect(resolveLineAccount({ item_type: 'net_deduction_other', account_number: '2750', is_net_deduction: true }, 'employee')).toBe('2750')
  })
})
