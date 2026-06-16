import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { z } from 'zod'
import { validateBody } from '@/lib/api/validate'

const UpdateNotesSchema = z.object({
  notes: z.string().max(2000).nullable(),
})

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  const result = await validateBody(request, UpdateNotesSchema)
  if (!result.success) return result.response

  const { error } = await supabase
    .from('journal_entries')
    .update({ notes: result.data.notes })
    .eq('id', id)
    .eq('company_id', companyId)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  return NextResponse.json({ data: { updated: true } })
}
