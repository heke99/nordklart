import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { createSalaryRunEntries } from '@/lib/salary/salary-entries'
import { toBookingEmployee } from '@/lib/salary/booking-employee'
import { eventBus } from '@/lib/events'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'

ensureInitialized()

/** paid → booked (creates immutable journal entries) */
export const POST = withRouteContext(
  'salary_run.book',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ salaryRunId: id })

    const { data: run, error: runError } = await supabase
      .from('salary_runs')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .eq('status', 'paid')
      .single()

    if (runError || !run) {
      return errorResponseFromCode('SALARY_RUN_NOT_CALCULATED', opLog, {
        requestId,
        details: { reason: 'must_be_paid_status' },
      })
    }

    const { data: employees, error: empError } = await supabase
      .from('salary_run_employees')
      .select('*, employee:employees(employment_type), line_items:salary_line_items(*)')
      .eq('salary_run_id', id)

    if (empError || !employees || employees.length === 0) {
      return errorResponseFromCode('SALARY_RUN_NO_EMPLOYEES', opLog, { requestId })
    }

    try {
      const { salaryEntry, avgifterEntry, vacationEntry, pensionEntry, bookedRun } = await createSalaryRunEntries(
        supabase,
        companyId!,
        user.id,
        {
          id: run.id,
          period_year: run.period_year,
          period_month: run.period_month,
          payment_date: run.payment_date,
          voucher_series: run.voucher_series,
          total_gross: run.total_gross,
          total_tax: run.total_tax,
          total_net: run.total_net,
          total_avgifter: run.total_avgifter,
          total_vacation_accrual: run.total_vacation_accrual,
          employees: employees.map(toBookingEmployee),
        },
      )

      // The vouchers and the run's status/links were written in one
      // transaction by book_salary_run (see createSalaryRunEntries).
      const entryIds = [salaryEntry, avgifterEntry, vacationEntry, pensionEntry]
        .filter((e): e is NonNullable<typeof e> => e !== null)
        .map((e) => e.id)

      await eventBus.emit({
        type: 'salary_run.booked',
        payload: { salaryRunId: id, entryIds, userId: user.id, companyId: companyId! },
      })

      return NextResponse.json({ data: bookedRun })
    } catch (err) {
      if (isBookkeepingError(err)) {
        return errorResponse(err, opLog, { requestId })
      }
      opLog.error('salary booking failed', err as Error)
      return errorResponseFromCode('SALARY_RUN_BOOK_FAILED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? err.message : 'unknown' },
      })
    }
  },
  { requireWrite: true },
)
