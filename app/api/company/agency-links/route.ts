import { NextResponse } from 'next/server'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { withRouteContext } from '@/lib/api/with-route-context'
import { resolveCompanyAccess } from '@/lib/access/company'
import { createServiceClient } from '@/lib/supabase/server'

/**
 * GET /api/company/agency-links
 *
 * The accounting agencies linked to the active company, pending or not, so
 * the client's own owner/admin can see who has — or is asking for — access
 * to the books. Only the client side manages these links: canManageCompany
 * is never granted through agency access.
 */
export const GET = withRouteContext('company.agency_links.list', async (_request, { supabase, companyId, log }) => {
  const access = await resolveCompanyAccess(supabase, companyId)
  if (!access?.canManageCompany) return errorResponseFromCode('FORBIDDEN', log, { messageSv: 'Behörighet saknas.', status: 403 })

  const service = createServiceClient()
  const { data: links, error } = await service
    .from('agency_clients')
    .select('id, agency_id, status, access_level, billing_owner, start_date, approved_at, ended_at, created_at')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
  if (error) return errorResponseFromCode('INTERNAL_ERROR', log, { messageSv: 'Kunde inte hämta byråkopplingar.', status: 500 })

  const agencyIds = [...new Set((links ?? []).map((l) => l.agency_id as string))]
  const names = new Map<string, string>()
  if (agencyIds.length > 0) {
    const { data: agencies } = await service.from('agencies').select('id, name').in('id', agencyIds)
    for (const a of agencies ?? []) names.set(a.id as string, a.name as string)
  }

  return NextResponse.json({
    data: (links ?? []).map((l) => ({ ...l, agency_name: names.get(l.agency_id as string) ?? null })),
  })
})
