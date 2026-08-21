import { withRouteContext } from '@/lib/api/with-route-context'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { manualLink } from '@/lib/reconciliation/bank-reconciliation'
import { validateBody } from '@/lib/api/validate'
import { BankLinkSchema } from '@/lib/api/schemas'
import { requireWritePermission } from '@/lib/auth/require-write'

ensureInitialized()

export const POST = withRouteContext('reconciliation.bank.link', async (request, ctx) => {
  const { supabase, companyId, user } = ctx
  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response


  const validation = await validateBody(request, BankLinkSchema)
  if (!validation.success) return validation.response
  const { transaction_id, journal_entry_id, account_number, allow_amount_mismatch } =
    validation.data

  const result = await manualLink(
    supabase,
    companyId,
    transaction_id,
    journal_entry_id,
    user.id,
    account_number ?? '1930',
    { allowAmountMismatch: allow_amount_mismatch === true },
  )

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 })
  }

  return NextResponse.json({ data: { success: true } })
})
