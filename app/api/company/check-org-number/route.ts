import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { normalizeOrgNumber } from '@/lib/company-lookup/normalize-org-number'
import { createServiceClient } from '@/lib/supabase/server'
import { checkDurableRateLimit } from '@/lib/auth/rate-limit-durable'
import { clientIpKey } from '@/lib/api/client-ip'

/**
 * GET /api/company/check-org-number?org_number=XXXXXXXXXX
 *
 * Returns account-scoped matches and a platform-level boolean. The platform
 * boolean is used to steer the UI toward access-request flow instead of
 * creating a duplicate company; it never returns IDs for companies the caller
 * cannot access.
 */
export async function GET(request: Request) {
  const { supabase, user, error: authError } = await requireAuth()
  if (authError) return authError

  // platformExists tells whether an organisation number (for a sole trader,
  // a personnummer) is a Nordklart customer. Onboarding needs that to steer
  // to an access request, but it must not be usable as a bulk lookup.
  for (const [prefix, identifier] of [
    ['company:check-org:user', user.id],
    ['company:check-org:ip', clientIpKey(request)],
  ] as const) {
    const limit = await checkDurableRateLimit({ prefix, identifier, maxRequests: 20, windowMs: 60 * 60 * 1000 })
    if (!limit.ok) return limit.response!
  }

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

  if (error) return NextResponse.json({ error: 'Kunde inte kontrollera organisationsnumret.' }, { status: 500 })

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
