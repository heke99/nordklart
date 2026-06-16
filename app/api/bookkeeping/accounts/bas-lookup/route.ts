import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'

/**
 * GET /api/bookkeeping/accounts/bas-lookup?numbers=5010,2641
 *
 * Returns BAS reference metadata (name, class, type) for a list of account
 * numbers. Used by ActivateAccountsDialog to render human-readable labels
 * before the user confirms activation. Unknown numbers are returned with
 * account_name=null so the UI can flag them as non-BAS.
 */
export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const raw = searchParams.get('numbers') || ''
  const numbers = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))]
  if (numbers.length === 0) {
    return NextResponse.json({ data: [] })
  }

  const data = numbers.map((num) => {
    const ref = getBASReference(num)
    if (!ref) {
      return { account_number: num, account_name: null, known: false }
    }
    return {
      account_number: ref.account_number,
      account_name: ref.account_name,
      account_class: ref.account_class,
      account_type: ref.account_type,
      known: true,
    }
  })

  return NextResponse.json({ data })
}
