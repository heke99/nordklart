import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { UpdateRecurringScheduleSchema } from '@/lib/api/schemas'

ensureInitialized()

export const GET = withRouteContext(
  'recurring_invoice.get',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log } = ctx
    const { data, error } = await supabase
      .from('recurring_invoice_schedules')
      .select('*, customer:customers(*), items:recurring_invoice_schedule_items(*)')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (error || !data) {
      log.warn('recurring schedule not found', { scheduleId: id })
      return NextResponse.json(
        { error: 'Schedule not found', type: 'not_found' },
        { status: 404 },
      )
    }

    // Run history: latest attempts (succeeded/failed/running) with the
    // spawned invoice number where available. Read via RLS — company-scoped.
    const { data: runs } = await supabase
      .from('recurring_invoice_runs')
      .select('id, run_date, status, invoice_id, auto_sent, warning, error, started_at, finished_at, invoice:invoices(id, invoice_number, status, total)')
      .eq('schedule_id', id)
      .eq('company_id', companyId)
      .order('started_at', { ascending: false })
      .limit(12)

    return NextResponse.json({ data, runs: runs ?? [] })
  },
)

export const PATCH = withRouteContext(
  'recurring_invoice.update',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON in request body', type: 'validation_error' },
        { status: 400 },
      )
    }

    const parsed = UpdateRecurringScheduleSchema.safeParse(rawBody)
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Validation failed',
          type: 'validation_error',
          errors: parsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            message: i.message,
            code: i.code,
          })),
        },
        { status: 400 },
      )
    }
    const input = parsed.data
    const { items, ...scheduleFields } = input

    // Only forward fields the user actually supplied.
    const updateRow: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(scheduleFields)) {
      if (v !== undefined) updateRow[k] = v
    }

    if (Object.keys(updateRow).length > 0) {
      const { error: updateError } = await supabase
        .from('recurring_invoice_schedules')
        .update(updateRow)
        .eq('id', id)
        .eq('company_id', companyId)

      if (updateError) {
        log.error('failed to update recurring schedule', updateError)
        return errorResponse(updateError, log, { requestId })
      }
    }

    if (items) {
      // Replace items wholesale — atomically, via an RPC that runs the
      // delete + insert in one transaction with a tenant/write guard. A
      // failed replace can therefore never leave the schedule with zero
      // items (which would make every subsequent cron run throw "schedule
      // has no items" and silently skip billing dates).
      const itemPayload = items.map((item) => ({
        description: item.description,
        quantity: item.quantity,
        unit: item.unit,
        unit_price: item.unit_price,
        vat_rate: item.vat_rate ?? null,
      }))
      const { error: replaceError } = await supabase.rpc('replace_recurring_schedule_items', {
        p_schedule_id: id,
        p_company_id: companyId,
        p_items: itemPayload,
      })
      if (replaceError) {
        if (replaceError.code === 'P0002') {
          return NextResponse.json(
            { error: 'Schedule not found', type: 'not_found' },
            { status: 404 },
          )
        }
        log.error('failed to replace schedule items', replaceError)
        return errorResponse(replaceError, log, { requestId })
      }
    }

    const { data: complete } = await supabase
      .from('recurring_invoice_schedules')
      .select('*, customer:customers(*), items:recurring_invoice_schedule_items(*)')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    return NextResponse.json({ data: complete })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext(
  'recurring_invoice.delete',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx

    // Items cascade-delete via FK ON DELETE CASCADE.
    const { error } = await supabase
      .from('recurring_invoice_schedules')
      .delete()
      .eq('id', id)
      .eq('company_id', companyId)

    if (error) {
      log.error('failed to delete recurring schedule', error)
      return errorResponse(error, log, { requestId })
    }
    return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)
