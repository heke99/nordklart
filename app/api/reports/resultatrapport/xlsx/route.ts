import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { NextResponse } from 'next/server'
import { generateResultatrapport } from '@/lib/reports/resultatrapport'
import { parseReportDateRange } from '@/lib/reports/date-range'
import {
  reportToWorkbook,
  textColumn,
  currencyColumn,
  xlsxFilename,
} from '@/lib/reports/xlsx-export'

interface FlatRow {
  group: string
  account_number: string
  account_name: string
  current_period: number
  prior_period: number
}

export const GET = withRouteContext('reports.resultatrapport.xlsx', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx
  const { searchParams } = new URL(request.url)
  const periodId = searchParams.get('period_id')

  if (!periodId) {
    return errorResponseFromCode('REPORT_PERIOD_REQUIRED', log, { requestId })
  }

  const [{ data: companyRow }, { data: period }] = await Promise.all([
    supabase
      .from('company_settings')
      .select('company_name')
      .eq('company_id', companyId)
      .single(),
    supabase
      .from('fiscal_periods')
      .select('period_start, period_end')
      .eq('id', periodId)
      .eq('company_id', companyId)
      .single(),
  ])

  let range: { fromDate?: string; toDate?: string } = {}
  if (period) {
    const parsed = parseReportDateRange(searchParams, period)
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 })
    }
    range = parsed.range
  }

  try {
    const report = await generateResultatrapport(supabase, companyId, periodId, range)

    const rows: FlatRow[] = []
    for (const g of report.groups) {
      for (const r of g.rows) {
        rows.push({
          group: g.class_label,
          account_number: r.account_number,
          account_name: r.account_name,
          current_period: r.current_period,
          prior_period: r.prior_period,
        })
      }
      rows.push({
        group: g.class_label,
        account_number: '',
        account_name: `Summa ${g.class_label}`,
        current_period: g.subtotal_current,
        prior_period: g.subtotal_prior,
      })
    }
    rows.push({
      group: 'Resultat',
      account_number: '',
      account_name: 'Årets resultat',
      current_period: report.net_result_current,
      prior_period: report.net_result_prior,
    })

    const buffer = await reportToWorkbook<FlatRow>([
      {
        name: 'Resultatrapport',
        columns: [
          textColumn('Grupp'),
          textColumn('Konto'),
          textColumn('Kontonamn'),
          currencyColumn('Aktuell period'),
          currencyColumn('Föregående period'),
        ],
        rows,
        mapRow: (r) => [
          r.group,
          r.account_number,
          r.account_name,
          r.current_period,
          r.prior_period,
        ],
      },
    ])

    const filename = xlsxFilename(
      'resultatrapport',
      companyRow?.company_name ?? '',
      report.period.end,
    )
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Kunde inte generera resultatrapport' },
      { status: 500 }
    )
  }
})
