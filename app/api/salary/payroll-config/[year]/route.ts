import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { loadPayrollConfig } from '@/lib/salary/payroll-config'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ year: string }> }
) {
  const { year } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const yearNum = parseInt(year)
  if (isNaN(yearNum) || yearNum < 2020 || yearNum > 2100) {
    return NextResponse.json({ error: 'Ogiltigt år' }, { status: 400 })
  }

  try {
    const config = await loadPayrollConfig(supabase, yearNum)
    return NextResponse.json({ data: config })
  } catch {
    return NextResponse.json({ error: `Löneuppgifter för ${year} saknas` }, { status: 404 })
  }
}
