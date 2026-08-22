import { withRouteContext } from '@/lib/api/with-route-context'
import { NextResponse } from 'next/server'
import { unlinkReconciliation } from '@/lib/reconciliation/bank-reconciliation'
import { validateBody } from '@/lib/api/validate'
import { BankUnlinkSchema } from '@/lib/api/schemas'
import { requireWritePermission } from '@/lib/auth/require-write'

export const POST = withRouteContext('reconciliation.bank.unlink', async (request, ctx) => {
  const { supabase, companyId, user } = ctx
  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response


  const validation = await validateBody(request, BankUnlinkSchema)
  if (!validation.success) return validation.response
  const { transaction_id } = validation.data

  const result = await unlinkReconciliation(supabase, companyId, transaction_id)

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 })
  }

  return NextResponse.json({ data: { success: true } })
})
