import { withRouteContext } from '@/lib/api/with-route-context'
import { NextResponse } from 'next/server'
import { validateBody } from '@/lib/api/validate'
import { UpdateAccountSchema } from '@/lib/api/schemas'
import { requireWritePermission } from '@/lib/auth/require-write'

export const DELETE = withRouteContext<{ params: Promise<{ number: string }> }>(
  'bookkeeping.accounts.number.delete',
  async (_request, ctx, { params }) => {
    const { supabase, companyId, user } = ctx
    const { number } = await params


    const writeCheck = await requireWritePermission(supabase, user.id)
    if (!writeCheck.ok) return writeCheck.response


    // Fetch the account to check if it's a system account
    const { data: account, error: fetchError } = await supabase
      .from('chart_of_accounts')
      .select('id, is_system_account')
      .eq('company_id', companyId)
      .eq('account_number', number)
      .single()

    if (fetchError || !account) {
      return NextResponse.json({ error: 'Kontot hittades inte' }, { status: 404 })
    }

    if (account.is_system_account) {
      return NextResponse.json(
        { error: 'Systemkonton kan inte tas bort' },
        { status: 400 }
      )
    }

    // Check if account is referenced in posted journal entries
    const { count } = await supabase
      .from('journal_entry_lines')
      .select('id', { count: 'exact', head: true })
      .eq('account_number', number)

    if (count && count > 0) {
      return NextResponse.json(
        { error: 'Kontot kan inte tas bort eftersom det används i bokförda verifikationer. Inaktivera det istället.' },
        { status: 400 }
      )
    }

    const { error: deleteError } = await supabase
      .from('chart_of_accounts')
      .delete()
      .eq('id', account.id)
      .eq('company_id', companyId)

    if (deleteError) {
      return NextResponse.json({ error: deleteError.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  },
)

export const PUT = withRouteContext<{ params: Promise<{ number: string }> }>(
  'bookkeeping.accounts.number.put',
  async (request, ctx, { params }) => {
    const { supabase, companyId, user } = ctx
    const { number } = await params


    const writeCheck = await requireWritePermission(supabase, user.id)
    if (!writeCheck.ok) return writeCheck.response


    const validation = await validateBody(request, UpdateAccountSchema)
    if (!validation.success) return validation.response
    const body = validation.data

    const { data, error } = await supabase
      .from('chart_of_accounts')
      .update(body)
      .eq('company_id', companyId)
      .eq('account_number', number)
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data })
  },
)
