import { withRouteContext } from '@/lib/api/with-route-context'
import { NextResponse } from 'next/server'
import { requireWritePermission } from '@/lib/auth/require-write'
import { z } from 'zod'
import { validateBody } from '@/lib/api/validate'

const UpdateNotesSchema = z.object({
  notes: z.string().max(2000).nullable(),
})

export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal_entries.notes',
  async (request, ctx, { params }) => {
    const { supabase, companyId, user } = ctx
    const { id } = await params


    const writeCheck = await requireWritePermission(supabase, user.id)
    if (!writeCheck.ok) return writeCheck.response


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
  },
)
