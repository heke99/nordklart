import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { API_V1_VERSION } from '@/lib/api/v1/version'

ensureInitialized()

/**
 * POST /api/webhooks/manage/deliveries/[id]/redeliver
 *
 * Dashboard redelivery of a dead/delivered webhook delivery: clones the
 * payload into a fresh pending row (same semantics as the v1 :retry
 * endpoint). Tenancy: the delivery must belong to the caller's active
 * company; the insert uses the service client (webhook_deliveries writes
 * are service-role-only by design) AFTER the company check.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'webhook.manage.redeliver',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    // Read via the user-context client — RLS confirms membership.
    const { data: original, error: fetchErr } = await supabase
      .from('webhook_deliveries')
      .select('id, webhook_id, company_id, event_type, payload, previous_attributes, api_version, status')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (fetchErr) return errorResponse(fetchErr, log, { requestId })
    if (!original) {
      return NextResponse.json({ error: 'Leveransen kunde inte hittas.' }, { status: 404 })
    }

    const o = original as {
      id: string
      webhook_id: string | null
      company_id: string
      event_type: string
      payload: Record<string, unknown>
      previous_attributes: Record<string, unknown> | null
      api_version: string
      status: string
    }

    if (o.status !== 'dead' && o.status !== 'delivered') {
      return NextResponse.json(
        { error: `Endast leveranser med status dead eller delivered kan skickas om (nuvarande: ${o.status}).` },
        { status: 400 },
      )
    }
    if (!o.webhook_id) {
      return NextResponse.json(
        { error: 'Webhooken som leveransen tillhörde är borttagen.' },
        { status: 400 },
      )
    }

    // Confirm the parent webhook is still active for this company.
    const { data: webhook } = await supabase
      .from('webhooks')
      .select('id, active, disabled_at')
      .eq('id', o.webhook_id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (!webhook || !(webhook as { active: boolean }).active || (webhook as { disabled_at: string | null }).disabled_at) {
      return NextResponse.json(
        { error: 'Webhooken är inaktiverad eller borttagen — återaktivera den först.' },
        { status: 400 },
      )
    }

    const service = createServiceClientNoCookies()
    const { data: cloned, error: insertErr } = await service
      .from('webhook_deliveries')
      .insert({
        webhook_id: o.webhook_id,
        company_id: o.company_id,
        event_type: o.event_type,
        payload: o.payload,
        previous_attributes: o.previous_attributes,
        api_version: o.api_version ?? API_V1_VERSION,
        status: 'pending',
        request_id: `whredeliver_${requestId}`,
      })
      .select('id, status')
      .single()

    if (insertErr) return errorResponse(insertErr, log, { requestId })

    await supabase.from('audit_log').insert({
      user_id: user.id,
      company_id: companyId,
      action: 'SECURITY_EVENT',
      table_name: 'webhook_deliveries',
      record_id: (cloned as { id: string }).id,
      actor_id: user.id,
      description: `Webhook-leverans omskickad via inställningar (ursprunglig leverans ${id}, event ${o.event_type})`,
    })

    return NextResponse.json({ data: cloned })
  },
  { requireWrite: true },
)
