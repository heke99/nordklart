import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../payroll-config', async (orig) => ({
  ...(await orig<typeof import('../payroll-config')>()),
  loadPayrollConfig: vi.fn().mockResolvedValue({
    configYear: 2026, avgifterTotal: 0.3142, avgifterReduced65plus: 0.1021, avgifterYouthRate: 0.2081,
    avgifterYouthSalaryCap: 25000, avgifterVaxaStodRate: 0.1021, avgifterVaxaStodCap: 35000,
    sjuklonRate: 0.8, karensavdragFactor: 0.2, prisbasbelopp: 59200,
  }),
}))
vi.mock('../calculation-engine', async (orig) => ({
  ...(await orig<typeof import('../calculation-engine')>()),
  calculateAvgifterRate: vi.fn(() => ({ rate: 0.3142, amount: 0, basis: 0, category: 'standard', steps: [] })),
}))

import { runSalaryCalculation } from '../run-calculation'

const COMPANY = 'c1'
const RUN = { id: 'run-1', company_id: COMPANY, status: 'draft', payment_date: '2026-03-25', period_year: 2026, period_month: 3 }

function employee(id: string, extra: Record<string, unknown> = {}) {
  return {
    id: `sre-${id}`, employee_id: id, hours_worked: null,
    employee: {
      id, first_name: 'Anna', last_name: id, salary_type: 'monthly', monthly_salary: 40000, employment_degree: 100,
      employment_type: 'employee', f_skatt_status: 'a_skatt', is_sidoinkomst: true, tax_table_number: null, tax_column: 1,
      jamkning_percentage: null, personnummer: 'x', vacation_rule: 'none', vacation_days_per_year: 25,
      semestertillagg_rate: 0, vaxa_stod_eligible: false, employment_start: '2025-01-01', employment_end: null, ...extra,
    },
    line_items: [{ item_type: 'monthly_salary', amount: 40000, is_taxable: true, is_avgift_basis: true, is_vacation_basis: true, is_gross_deduction: false, is_net_deduction: false }],
  }
}

function makeSupabase(tables: Record<string, unknown>, rpcResult: { data: unknown; error: unknown }) {
  const fromCalls: string[] = []
  const rpc = vi.fn().mockResolvedValue(rpcResult)
  const from = (table: string) => {
    fromCalls.push(table)
    const q: Record<string, unknown> = {}
    let rangeFrom = 0
    for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'lt', 'or', 'order', 'not', 'is']) q[m] = () => q
    q.range = (a: number) => { rangeFrom = a; return q }
    q.single = async () => ({ data: tables[table], error: null })
    q.then = (resolve: (v: unknown) => void) =>
      resolve({ data: rangeFrom === 0 ? (Array.isArray(tables[table]) ? tables[table] : []) : [], error: null })
    return q
  }
  return { client: { from, rpc } as never, rpc, fromCalls }
}

const log = { child: () => log, info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never

beforeEach(() => vi.clearAllMocks())

describe('runSalaryCalculation', () => {
  it('reads each input once for the whole run and writes everything in one RPC', async () => {
    const { client, rpc, fromCalls } = makeSupabase({
      salary_runs: RUN,
      salary_run_employees: [employee('e1'), employee('e2'), employee('e3')],
      shift_premium_rules: [],
      salary_absence_days: [{ employee_id: 'e2', absence_date: '2026-03-10', absence_type: 'sick', hours: 8 }],
      employee_benefits: [{ id: 'b1', employee_id: 'e3', benefit_type: 'car', description: 'Bilförmån', monthly_value: 4000 }],
    }, { data: { ...RUN, total_gross: 1 }, error: null })

    const result = await runSalaryCalculation({ supabase: client, companyId: COMPANY, salaryRunId: 'run-1', log, requestId: 'r' })

    expect(result.ok).toBe(true)
    // One absence query and one benefits query for three employees.
    expect(fromCalls.filter((t) => t === 'salary_absence_days')).toHaveLength(1)
    expect(fromCalls.filter((t) => t === 'employee_benefits')).toHaveLength(1)
    // No direct writes to line items or employee rows — only the RPC.
    expect(fromCalls).not.toContain('salary_line_items')
    expect(rpc).toHaveBeenCalledTimes(1)
    const [name, args] = rpc.mock.calls[0]
    expect(name).toBe('persist_salary_run_calculation')
    expect(args.p_employees).toHaveLength(3)
    const e2 = args.p_employees.find((e: { salary_run_employee_id: string }) => e.salary_run_employee_id === 'sre-e2')
    expect(e2.insert_lines.map((l: { item_type: string }) => l.item_type)).toContain('sick_karens')
    const e3 = args.p_employees.find((e: { salary_run_employee_id: string }) => e.salary_run_employee_id === 'sre-e3')
    expect(e3.insert_lines).toEqual(expect.arrayContaining([expect.objectContaining({ source_benefit_id: 'b1' })]))
    expect(args.p_totals.total_gross).toBeGreaterThan(0)
  })

  it('reports not_draft when the run changed status before the write', async () => {
    const { client } = makeSupabase({
      salary_runs: RUN,
      salary_run_employees: [employee('e1')],
      shift_premium_rules: [],
    }, { data: null, error: { code: '55000', message: 'not draft' } })

    const result = await runSalaryCalculation({ supabase: client, companyId: COMPANY, salaryRunId: 'run-1', log, requestId: 'r' })
    expect(result).toMatchObject({ ok: false, code: 'SALARY_RUN_CALCULATE_FAILED' })
  })
})
