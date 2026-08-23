import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { updateDeadlineStatus, isValidTransition } from '@/lib/deadlines/status-engine'
import type { DeadlineStatus } from '@/types'

/**
 * PATCH /api/deadlines/[id]/status
 * Manually update a deadline's status
 */
export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'deadline.status_update',
  async (request, { supabase, companyId, user }, { params }) => {
  const { id } = await params
  const body = await request.json()
  const newStatus = body.status as DeadlineStatus

  if (!newStatus) {
    return NextResponse.json({ error: 'Status is required' }, { status: 400 })
  }

  const validStatuses: DeadlineStatus[] = [
    'upcoming',
    'action_needed',
    'in_progress',
    'submitted',
    'confirmed',
    'overdue',
  ]

  if (!validStatuses.includes(newStatus)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
  }

  const result = await updateDeadlineStatus(supabase, id, companyId, newStatus)

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 })
  }

  return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)

/**
 * GET /api/deadlines/[id]/status
 * Get current status and valid transitions
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'deadline.status_get',
  async (request, { supabase, companyId, user }, { params }) => {
  const { id } = await params
  const { data: deadline, error } = await supabase
    .from('deadlines')
    .select('status, is_completed, due_date')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (error || !deadline) {
    return NextResponse.json({ error: 'Deadline not found' }, { status: 404 })
  }

  // Calculate valid transitions from current status
  const validTransitions: DeadlineStatus[] = []
  const allStatuses: DeadlineStatus[] = [
    'upcoming',
    'action_needed',
    'in_progress',
    'submitted',
    'confirmed',
    'overdue',
  ]

  for (const status of allStatuses) {
    if (isValidTransition(deadline.status, status)) {
      validTransitions.push(status)
    }
  }

  return NextResponse.json({
    currentStatus: deadline.status,
    isCompleted: deadline.is_completed,
    dueDate: deadline.due_date,
    validTransitions,
  })
  },
)
