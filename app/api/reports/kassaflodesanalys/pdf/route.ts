import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { NextResponse } from 'next/server'
import { renderToBuffer } from '@react-pdf/renderer'
import { generateKassaflodesanalys } from '@/lib/reports/kassaflodesanalys'
import { KassaflodesanalysPDF } from '@/lib/reports/kassaflodesanalys-pdf-template'
import type { CompanySettings } from '@/types'

export const GET = withRouteContext('reports.kassaflodesanalys.pdf', async (request, ctx) => {
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
  // An identifiable period is part of räkenskapsinformation (BFL 7 kap). Refuse
  // to render a PDF that can't be archived with the period it refers to.
  if (!period) {
    return NextResponse.json(
      {
        error:
          'Räkenskapsperioden kunde inte läsas. Välj en befintlig period innan du genererar PDF.',
      },
      { status: 400 }
    )
  }

  try {
    const report = await generateKassaflodesanalys(supabase, companyId, periodId)

    const pdfBuffer = await renderToBuffer(
      KassaflodesanalysPDF({
        report,
        company: companyRow as CompanySettings,
        generatedAt: new Date().toISOString(),
      })
    )

    const filename = `kassaflodesanalys-${report.period_start}.pdf`

    return new Response(new Uint8Array(pdfBuffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Kunde inte generera kassaflödesanalys' },
      { status: 500 }
    )
  }
})
