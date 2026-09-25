import { NextResponse } from 'next/server'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { resolveCompanyAccess } from '@/lib/access/company'
import { createServiceClient } from '@/lib/supabase/server'

const BodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('approve'),
    access_level: z.enum(['bookkeeping', 'review', 'audit', 'full_service']).optional(),
  }),
  z.object({ action: z.literal('revoke') }),
])

/**
 * PATCH /api/company/agency-links/[id]
 *
 * The client company's owner/admin approves a pending agency link (optionally
 * narrowing the scope) or revokes an existing one. Each is one conditional
 * UPDATE, so a concurrent approve/revoke cannot interleave: approve only
 * matches a pending row, revoke only a pending/active/paused row.
 */
export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'company.agency_links.update',
  async (request, { supabase, user, companyId, log }, { params }) => {
    const access = await resolveCompanyAccess(supabase, companyId)
    if (!access?.canManageCompany) return errorResponseFromCode('FORBIDDEN', log, { messageSv: 'Behörighet saknas.', status: 403 })

    const parsed = BodySchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) return errorResponseFromCode('VALIDATION_ERROR', log, { messageSv: 'Ogiltig begäran.', status: 400 })

    const { id } = await params
    const now = new Date().toISOString()
    const service = createServiceClient()

    const update = parsed.data.action === 'approve'
      ? {
          status: 'active',
          approved_by_client_user_id: user.id,
          approved_at: now,
          ...(parsed.data.access_level ? { access_level: parsed.data.access_level } : {}),
        }
      : { status: 'ended', ended_by: user.id, ended_at: now, end_date: now.slice(0, 10) }
    const fromStatuses = parsed.data.action === 'approve' ? ['pending'] : ['pending', 'active', 'paused']

    const { data, error } = await service
      .from('agency_clients')
      .update(update)
      .eq('id', id)
      .eq('company_id', companyId)
      .in('status', fromStatuses)
      .select('id, agency_id, status, access_level')
      .maybeSingle()

    if (error) return errorResponseFromCode('INTERNAL_ERROR', log, { messageSv: 'Byråkopplingen kunde inte uppdateras.', status: 500 })
    if (!data) return errorResponseFromCode('CONFLICT', log, { messageSv: 'Byråkopplingen hittades inte eller har redan hanterats.', status: 409 })

    await service.from('auth_audit_events').insert({
      user_id: user.id,
      company_id: companyId,
      email: user.email ?? null,
      event_type: parsed.data.action === 'approve' ? 'agency_link_approved' : 'agency_link_revoked',
      status: 'success',
      metadata: { company_id: companyId, agency_client_id: data.id, agency_id: data.agency_id, access_level: data.access_level },
    }).then(() => undefined, () => undefined)

    return NextResponse.json({ data })
  },
)
