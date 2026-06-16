import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { lookupTaxFromApi, TaxTableUnavailableError } from '@/lib/salary/tax-tables'

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const year = parseInt(searchParams.get('year') || new Date().getFullYear().toString())
  const tableNumber = parseInt(searchParams.get('table') || '0')
  const column = parseInt(searchParams.get('column') || '1')
  const income = parseFloat(searchParams.get('income') || '0')

  if (!tableNumber || tableNumber < 29 || tableNumber > 42) {
    return NextResponse.json({ error: 'Skattetabell måste vara 29-42' }, { status: 400 })
  }

  try {
    const { taxAmount, source } = await lookupTaxFromApi(tableNumber, column, income, year)
    return NextResponse.json({
      data: {
        year,
        tableNumber,
        column,
        income,
        taxAmount,
        source: source === 'api' ? 'skatteverket_api' : 'local_fallback',
      },
    })
  } catch (err) {
    if (err instanceof TaxTableUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 503 })
    }
    throw err
  }
}
