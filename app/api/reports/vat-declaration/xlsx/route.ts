import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { NextResponse } from 'next/server'
import {
  calculateVatDeclaration,
  formatPeriodLabel,
} from '@/lib/reports/vat-declaration'
import {
  reportToWorkbook,
  textColumn,
  currencyColumn,
  xlsxFilename,
} from '@/lib/reports/xlsx-export'
import {
  VAT_RUTA_LABELS,
  type VatPeriodType,
  type VatDeclarationRutor,
  type AccountingMethod,
} from '@/types'

interface RutaRow {
  ruta: string
  label: string
  amount: number
}

export const GET = withRouteContext('reports.vat_declaration.xlsx', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx
  const { searchParams } = new URL(request.url)
  const periodType = searchParams.get('periodType') as VatPeriodType | null
  const yearStr = searchParams.get('year')
  const periodStr = searchParams.get('period')
  // Yearly = räkenskapsår (see main route); ignored for monthly/quarterly.
  const fiscalPeriodId = searchParams.get('fiscal_period_id') ?? undefined

  if (!periodType || !yearStr || !periodStr) {
    return NextResponse.json(
      { error: 'periodType, year, and period are required' },
      { status: 400 }
    )
  }
  if (!['monthly', 'quarterly', 'yearly'].includes(periodType)) {
    return errorResponseFromCode('VAT_REPORT_INVALID_PERIOD_TYPE', log, { requestId })
  }

  const year = parseInt(yearStr, 10)
  const period = parseInt(periodStr, 10)
  if (isNaN(year) || isNaN(period)) {
    return errorResponseFromCode('VAT_REPORT_MISSING_PARAMS', log, { requestId })
  }

  const [{ data: settings }, { data: companyRow }] = await Promise.all([
    supabase
      .from('company_settings')
      .select('accounting_method')
      .eq('company_id', companyId)
      .single(),
    supabase
      .from('company_settings')
      .select('company_name')
      .eq('company_id', companyId)
      .single(),
  ])

  const accountingMethod = (settings?.accounting_method as AccountingMethod) || 'accrual'

  try {
    const declaration = await calculateVatDeclaration(
      supabase, companyId, periodType, year, period, accountingMethod,
      { fiscalPeriodId },
    )

    const rows: RutaRow[] = (Object.keys(declaration.rutor) as (keyof VatDeclarationRutor)[]).map(
      (key) => ({
        ruta: key.replace(/^ruta/, 'Ruta '),
        label: VAT_RUTA_LABELS[key],
        amount: declaration.rutor[key],
      }),
    )

    const buffer = await reportToWorkbook<RutaRow>([
      {
        name: `Moms ${formatPeriodLabel(periodType, year, period)}`,
        columns: [
          textColumn('Ruta'),
          textColumn('Beskrivning'),
          currencyColumn('Belopp'),
        ],
        rows,
        mapRow: (r) => [r.ruta, r.label, r.amount],
      },
    ])

    const filename = xlsxFilename(
      'momsdeklaration',
      companyRow?.company_name ?? '',
      declaration.period.end,
    )
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Kunde inte generera momsdeklaration' },
      { status: 500 }
    )
  }
})
