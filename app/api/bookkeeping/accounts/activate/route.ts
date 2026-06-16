import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'

/**
 * POST /api/bookkeeping/accounts/activate
 *
 * Batch-activate BAS accounts for a user. Accepts { account_numbers: string[] }.
 * - Inserts rows from BAS reference for accounts not yet in the chart.
 * - Reactivates (is_active=true) accounts that already exist but are inactive.
 * - Skips anything already active.
 * - Returns { activated, reactivated, skipped, unknown } so callers can react.
 */
export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  const body = await request.json()
  const accountNumbers: string[] = body.account_numbers

  if (!Array.isArray(accountNumbers) || accountNumbers.length === 0) {
    return NextResponse.json({ error: 'account_numbers array required' }, { status: 400 })
  }

  const uniqueNumbers = [...new Set(accountNumbers)]

  // Fetch existing rows with current is_active state
  const { data: existing, error: fetchError } = await supabase
    .from('chart_of_accounts')
    .select('account_number, is_active')
    .eq('company_id', companyId)
    .in('account_number', uniqueNumbers)

  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 })
  }

  const existingByNumber = new Map<string, boolean>(
    (existing || []).map((a) => [a.account_number, a.is_active])
  )

  const toReactivate: string[] = []
  const toInsert: Array<ReturnType<typeof buildInsertRow>> = []
  const unknown: string[] = []
  let skipped = 0

  for (const num of uniqueNumbers) {
    if (existingByNumber.has(num)) {
      if (existingByNumber.get(num) === true) {
        skipped += 1
      } else {
        toReactivate.push(num)
      }
      continue
    }
    const row = buildInsertRow(num, user.id, companyId)
    if (row) {
      toInsert.push(row)
    } else {
      unknown.push(num)
    }
  }

  let reactivatedRows: { account_number: string }[] = []
  if (toReactivate.length > 0) {
    const { data, error } = await supabase
      .from('chart_of_accounts')
      .update({ is_active: true })
      .eq('company_id', companyId)
      .in('account_number', toReactivate)
      .select('account_number')
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    reactivatedRows = data || []
  }

  let insertedRows: { account_number: string }[] = []
  if (toInsert.length > 0) {
    const { data, error } = await supabase
      .from('chart_of_accounts')
      .insert(toInsert)
      .select('account_number')
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    insertedRows = data || []
  }

  return NextResponse.json({
    data: [...insertedRows, ...reactivatedRows],
    activated: insertedRows.length,
    reactivated: reactivatedRows.length,
    skipped,
    unknown,
  })
}

function buildInsertRow(accountNumber: string, userId: string, companyId: string) {
  const ref = getBASReference(accountNumber)
  if (!ref) return null
  return {
    user_id: userId,
    company_id: companyId,
    account_number: ref.account_number,
    account_name: ref.account_name,
    account_class: ref.account_class,
    account_group: ref.account_group,
    account_type: ref.account_type,
    normal_balance: ref.normal_balance,
    plan_type: 'full_bas' as const,
    is_active: true,
    is_system_account: false,
    description: ref.description,
    sru_code: ref.sru_code,
    sort_order: parseInt(ref.account_number),
  }
}
