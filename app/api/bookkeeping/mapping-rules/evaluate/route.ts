import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { evaluateMappingRules } from '@/lib/bookkeeping/mapping-engine'
import { validateBody } from '@/lib/api/validate'
import { EvaluateMappingRulesSchema } from '@/lib/api/schemas'
import { requireCompanyId } from '@/lib/company/context'
import type { Transaction } from '@/types'

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

  const validation = await validateBody(request, EvaluateMappingRulesSchema)
  if (!validation.success) return validation.response
  const body = validation.data

  // Accept either a transaction ID or raw transaction data
  let transaction: Transaction

  if ('transaction_id' in body) {
    const { data, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', body.transaction_id)
      .eq('company_id', companyId)
      .single()

    if (error || !data) {
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
    }

    transaction = data as Transaction
  } else {
    transaction = body as unknown as Transaction
  }

  try {
    const result = await evaluateMappingRules(supabase, companyId, transaction)
    return NextResponse.json({ data: result })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Evaluation failed' },
      { status: 500 }
    )
  }
}
