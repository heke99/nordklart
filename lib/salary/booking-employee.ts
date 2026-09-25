import { roundOre } from '@/lib/money'
import type { SalaryRunEmployee } from './salary-entries'

/**
 * Map a salary_run_employees row (with employee + line_items joined) to the
 * booking shape. Applies the advanced-mode overrides (tax_withheld_override,
 * avgifter_amount_override) exactly like the AGI does, so the ledger and the
 * declaration never disagree: a changed tax amount moves money between 2710
 * and the net pay.
 */
export function toBookingEmployee(sre: {
  employee_id: string
  employee?: { employment_type?: string | null } | null
  gross_salary: number
  tax_withheld: number
  tax_withheld_override?: number | null
  net_salary: number
  avgifter_amount: number
  avgifter_amount_override?: number | null
  avgifter_rate: number
  vacation_accrual: number
  vacation_accrual_avgifter: number
  line_items?: Array<Record<string, unknown>> | null
}): SalaryRunEmployee {
  const tax = sre.tax_withheld_override ?? sre.tax_withheld
  return {
    employee_id: sre.employee_id,
    employment_type: sre.employee?.employment_type || 'employee',
    gross_salary: sre.gross_salary,
    tax_withheld: tax,
    net_salary: roundOre(sre.net_salary + (sre.tax_withheld - tax)),
    avgifter_amount: sre.avgifter_amount_override ?? sre.avgifter_amount,
    avgifter_rate: sre.avgifter_rate,
    vacation_accrual: sre.vacation_accrual,
    vacation_accrual_avgifter: sre.vacation_accrual_avgifter,
    line_items: (sre.line_items || []).map((li) => ({
      item_type: li.item_type as string,
      amount: li.amount as number,
      account_number: (li.account_number as string | null) ?? null,
      is_net_deduction: Boolean(li.is_net_deduction),
      is_gross_deduction: Boolean(li.is_gross_deduction),
    })),
  }
}
