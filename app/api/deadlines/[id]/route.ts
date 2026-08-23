import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import type { CreateDeadlineInput } from '@/types'

/**
 * GET /api/deadlines/[id]
 * Get a single deadline by ID
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'deadline.get',
  async (request, { supabase, companyId, user }, { params }) => {
  const { id } = await params
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
  },
)

/**
 * PUT /api/deadlines/[id]
 * Update a deadline
 */
export const PUT = withRouteContext<{ params: Promise<{ id: string }> }>(
  'deadline.update',
  async (request, { supabase, companyId, user }, { params }) => {
  const { id } = await params
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
  },
  { requireWrite: true },
)

/**
 * DELETE /api/deadlines/[id]
 * Delete a deadline
 */
export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'deadline.delete',
  async (request, { supabase, companyId, user }, { params }) => {
  const { id } = await params
  const { error } = await supabase
    .from('deadlines')
    .delete()
    .eq('id', id)
    .eq('company_id', companyId)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)
