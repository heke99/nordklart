import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { NextResponse } from 'next/server'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import {
  reportToWorkbook,
  textColumn,
  currencyColumn,
  integerColumn,
  xlsxFilename,
} from '@/lib/reports/xlsx-export'
import type { TrialBalanceRow } from '@/types'

export const GET = withRouteContext('reports.trial_balance.xlsx', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx
  const { searchParams } = new URL(request.url)
  const periodId = searchParams.get('period_id')

  if (!periodId) {
    return errorResponseFromCode('REPORT_PERIOD_REQUIRED', log, { requestId })
  }

  const [{ data: period }, { data: companyRow }] = await Promise.all([
    supabase
      .from('fiscal_periods')
      .select('period_start, period_end')
      .eq('id', periodId)
      .eq('company_id', companyId)
      .single(),
    supabase
      .from('company_settings')
      .select('company_name')
      .eq('company_id', companyId)
      .single(),
  ])

  if (!period) {
    return NextResponse.json({ error: 'Räkenskapsperioden kunde inte läsas.' }, { status: 400 })
  }

  try {
    const report = await generateTrialBalance(supabase, companyId, periodId)

    const buffer = await reportToWorkbook<TrialBalanceRow>([
      {
        name: 'Saldobalans',
        columns: [
          textColumn('Konto'),
          textColumn('Kontonamn'),
          integerColumn('Klass'),
          currencyColumn('IB Debet'),
          currencyColumn('IB Kredit'),
          currencyColumn('Period Debet'),
          currencyColumn('Period Kredit'),
          currencyColumn('UB Debet'),
          currencyColumn('UB Kredit'),
        ],
        rows: report.rows,
        mapRow: (r) => [
          r.account_number,
          r.account_name,
          r.account_class,
          r.opening_debit,
          r.opening_credit,
          r.period_debit,
          r.period_credit,
          r.closing_debit,
          r.closing_credit,
        ],
      },
    ])

    const filename = xlsxFilename('saldobalans', companyRow?.company_name ?? '', period.period_end)
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Kunde inte generera saldobalans' },
      { status: 500 }
    )
  }
})
