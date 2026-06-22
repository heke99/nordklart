import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { normalizeOrgNumber } from '@/lib/company-lookup/normalize-org-number'
import { createServiceClient } from '@/lib/supabase/server'

/**
 * GET /api/company/check-org-number?org_number=XXXXXXXXXX
 *
 * Returns account-scoped matches and a platform-level boolean. The platform
 * boolean is used to steer the UI toward access-request flow instead of
 * creating a duplicate company; it never returns IDs for companies the caller
 * cannot access.
 */
export async function GET(request: Request) {
  const { supabase, error: authError } = await requireAuth()
  if (authError) return authError

  const url = new URL(request.url)
  const raw = url.searchParams.get('org_number') ?? ''
  if (!raw) return NextResponse.json({ error: 'org_number is required' }, { status: 400 })

  const canonical = normalizeOrgNumber(raw)
  if (!canonical) {
    return NextResponse.json({ data: { exists: false, platformExists: false, accessRequestRequired: false, companies: [] } })
  }

  const { data, error } = await supabase
    .from('companies')
    .select('id, name')
    .eq('org_number', canonical)
    .is('archived_at', null)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const companies = (data ?? []).map((c: { id: string; name: string }) => ({ id: c.id, name: c.name }))
  const service = createServiceClient()
  const { data: platformMatch } = await service
    .from('companies')
    .select('id')
    .eq('org_number', canonical)
    .is('archived_at', null)
    .limit(1)
    .maybeSingle()

  return NextResponse.json({
    data: {
      exists: companies.length > 0,
      platformExists: Boolean(platformMatch),
      accessRequestRequired: Boolean(platformMatch) && companies.length === 0,
      companies,
    },
  })
}
