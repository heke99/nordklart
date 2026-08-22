import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { NextResponse } from 'next/server'
import { renderToBuffer } from '@react-pdf/renderer'
import { generateBalansrapport } from '@/lib/reports/balansrapport'
import { BalansrapportPDF } from '@/lib/reports/operational-report-pdf-template'
import { parseReportDateRange } from '@/lib/reports/date-range'
import type { CompanySettings } from '@/types'

export const GET = withRouteContext('reports.balansrapport.pdf', async (request, ctx) => {
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
      .select('*')
      .eq('company_id', companyId)
      .single(),
  ])

  if (!companyRow) {
    return errorResponseFromCode('COMPANY_SETTINGS_MISSING', log, { requestId })
  }
  if (!period) {
    return NextResponse.json(
      { error: 'Räkenskapsperioden kunde inte läsas. Välj en befintlig period innan du genererar PDF.' },
      { status: 400 }
    )
  }

  const parsedRange = parseReportDateRange(searchParams, period)
  if (!parsedRange.ok) {
    return NextResponse.json({ error: parsedRange.error }, { status: 400 })
  }

  try {
    const report = await generateBalansrapport(supabase, companyId, periodId, parsedRange.range)

    const pdfBuffer = await renderToBuffer(
      BalansrapportPDF({
        report,
        company: companyRow as CompanySettings,
        generatedAt: new Date().toISOString(),
      })
    )

    // Anchor on period.start to match the convention used by every other
    // report PDF route in this repo (resultatrapport, balance-sheet,
    // income-statement). A balansrapport is a snapshot at period end, but
    // consistent filenames let users sort and script-rename predictably.
    const filename = `balansrapport-${report.period.start}--${report.period.end}.pdf`

    return new Response(new Uint8Array(pdfBuffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Kunde inte generera balansrapport' },
      { status: 500 }
    )
  }
})
