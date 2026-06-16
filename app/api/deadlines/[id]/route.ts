import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import type { CreateDeadlineInput } from '@/types'

/**
 * GET /api/deadlines/[id]
 * Get a single deadline by ID
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { id } = await params

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

  const { data, error } = await supabase
    .from('deadlines')
    .select('*, customer:customers(id, name)')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (error) {
    if (error.code === 'PGRST116') {
      return NextResponse.json({ error: 'Deadline not found' }, { status: 404 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data })
}

/**
 * PUT /api/deadlines/[id]
 * Update a deadline
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { id } = await params

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  const body: Partial<CreateDeadlineInput> = await request.json()

  // First, get existing deadline to verify ownership
  const { data: _existing, error: fetchError } = await supabase
    .from('deadlines')
    .select('*')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (fetchError) {
    if (fetchError.code === 'PGRST116') {
      return NextResponse.json({ error: 'Deadline not found' }, { status: 404 })
    }
    return NextResponse.json({ error: fetchError.message }, { status: 500 })
  }

  // Build update object
  const updateData: Record<string, unknown> = {}
  if (body.title !== undefined) updateData.title = body.title
  if (body.due_date !== undefined) updateData.due_date = body.due_date
  if (body.due_time !== undefined) updateData.due_time = body.due_time
  if (body.deadline_type !== undefined) updateData.deadline_type = body.deadline_type
  if (body.priority !== undefined) updateData.priority = body.priority
  if (body.customer_id !== undefined) updateData.customer_id = body.customer_id || null
  if (body.notes !== undefined) updateData.notes = body.notes

  // Update the deadline
  const { data, error } = await supabase
    .from('deadlines')
    .update(updateData)
    .eq('id', id)
    .eq('company_id', companyId)
    .select('*, customer:customers(id, name)')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data })
}

/**
 * DELETE /api/deadlines/[id]
 * Delete a deadline
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { id } = await params

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  const { error } = await supabase
    .from('deadlines')
    .delete()
    .eq('id', id)
    .eq('company_id', companyId)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
