import type { SupabaseClient } from '@supabase/supabase-js'

export interface CreateSalaryRunResult {
  run: Record<string, unknown>
  employeeCount: number
}

/**
 * Create a draft salary run and seed a base line for every active employee
 * whose employment overlaps the period.
 *
 * One database transaction (create_salary_run_with_employees): the run, the
 * per-employee rows and their base lines exist together or not at all. The
 * base-line account follows getLineItemAccount() in ./account-mapping — 7210
 * (tjänstemän), 7220 (företagsledare), 7240 (styrelsearvoden).
 *
 * Shared by the MCP tool and any route that creates a populated run.
 */
export async function createSalaryRunWithEmployees(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  params: { periodYear: number; periodMonth: number; paymentDate: string },
): Promise<CreateSalaryRunResult> {
  const { data, error } = await supabase
    .rpc('create_salary_run_with_employees', {
      p_company_id: companyId,
      p_user_id: userId,
      p_period_year: params.periodYear,
      p_period_month: params.periodMonth,
      p_payment_date: params.paymentDate,
    })
    .single<{ run: Record<string, unknown>; employee_count: number }>()

  if (error || !data) {
    throw new Error(
      error?.code === '23505'
        ? 'Salary run already exists for this period'
        : (error?.message ?? 'Failed to create salary run'),
    )
  }

  return { run: data.run, employeeCount: data.employee_count }
}
