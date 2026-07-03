import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'

ensureInitialized()

/**
 * DELETE /api/webhooks/manage/[id] — remove a webhook subscription
 * (dashboard). Deliveries already recorded stay for the audit trail.
 */
export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'webhook.manage.delete',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    const { data: existing, error: fetchErr } = await supabase
      .from('webhooks')
      .select('id, name, event_type')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (fetchErr) return errorResponse(fetchErr, log, { requestId })
    if (!existing) {
      return NextResponse.json({ error: 'Webhooken kunde inte hittas.' }, { status: 404 })
    }

    const { error } = await supabase
      .from('webhooks')
      .delete()
      .eq('id', id)
      .eq('company_id', companyId)

    if (error) return errorResponse(error, log, { requestId })

    await supabase.from('audit_log').insert({
      user_id: user.id,
      company_id: companyId,
      action: 'DELETE',
      table_name: 'webhooks',
      record_id: id,
      actor_id: user.id,
      description: `Webhook borttagen via inställningar: ${(existing as { name: string }).name}`,
      old_state: existing,
    })

    return NextResponse.json({ data: { id, deleted: true } })
  },
  { requireWrite: true },
)
