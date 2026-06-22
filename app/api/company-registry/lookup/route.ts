import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { checkRateLimit } from '@/lib/auth/rate-limit-http'
import { requireAuth } from '@/lib/auth/require-auth'
import { normalizeOrgNumber } from '@/lib/company-lookup/normalize-org-number'
import { lookupCompanyAtBolagsverket } from '@/lib/company-registry/provider'
import { publicLookupPayload } from '@/lib/company-registry/registry-service'

const bodySchema = z.object({
  organizationNumber: z.string().trim().min(1).max(32),
})

export async function POST(request: NextRequest) {
  const { user, error: authError } = await requireAuth()
  if (authError) return authError

  const body = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(body)

  const limit = await checkRateLimit({
    prefix: 'company-registry:lookup',
    identifier: `${user.id}:${parsed.success ? parsed.data.organizationNumber.replace(/\D/g, '') : 'invalid'}`,
    maxRequests: 20,
    windowMs: 15 * 60 * 1000,
  })
  if (!limit.ok) return limit.response!

  if (!parsed.success) {
    return NextResponse.json({ error: 'Kontrollera organisationsnumret.' }, { status: 400 })
  }

  const organizationNumber = normalizeOrgNumber(parsed.data.organizationNumber)
  if (!organizationNumber) {
    return NextResponse.json({ error: 'Organisationsnumret är inte giltigt.' }, { status: 400 })
  }

  const result = await lookupCompanyAtBolagsverket(organizationNumber)
  if (!result.available) {
    return NextResponse.json({
      available: false,
      found: false,
      status: 'provider_unavailable',
      message: 'Bolagsverket kunde inte nås just nu. Du kan fylla i uppgifterna manuellt.',
    })
  }
  if (!result.found || result.company.organizationNumber !== organizationNumber) {
    return NextResponse.json({
      available: true,
      found: false,
      status: 'not_found',
      message: 'Vi hittade inte företaget i Bolagsverket. Kontrollera organisationsnumret eller fyll i manuellt.',
    })
  }

  return NextResponse.json({
    available: true,
    found: true,
    status: result.company.registryStatus,
    company: publicLookupPayload(result.company),
  })
}
