import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { checkDurableRateLimit } from '@/lib/auth/rate-limit-durable'
import { normalizeOrgNumber } from '@/lib/company-lookup/normalize-org-number'
import { lookupCompanyAtBolagsverket } from '@/lib/company-registry/provider'
import { signCompanyLookup } from '@/lib/company-registry/lookup-attestation'
import { publicLookupPayload } from '@/lib/company-registry/registry-service'

const bodySchema = z.object({
  organizationNumber: z.string().trim().min(1).max(32),
})

function clientIp(request: NextRequest): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'unknown'
}

/**
 * Public and deliberately narrow: it accepts only a validated Swedish
 * organisation number and never returns contact persons, payment data or raw
 * registry payloads. Bolagsverket enrichment is optional; signup still works
 * with manual data if the provider is temporarily unavailable.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(body)
  const ip = clientIp(request)

  const limit = await checkDurableRateLimit({
    prefix: 'public:company-lookup',
    identifier: ip,
    maxRequests: 12,
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
  if (!result.found) {
    return NextResponse.json({
      available: true,
      found: false,
      status: 'not_found',
      message: 'Vi hittade inte företaget i Bolagsverket. Kontrollera organisationsnumret eller fyll i manuellt.',
    })
  }

  // Exact identifier equality is mandatory. Registry search must never fill a
  // signup from a "first matching" company result.
  if (result.company.organizationNumber !== organizationNumber) {
    return NextResponse.json({
      available: true,
      found: false,
      status: 'identifier_mismatch',
      message: 'Registersvaret matchade inte organisationsnumret.',
    })
  }

  return NextResponse.json({
    available: true,
    found: true,
    status: result.company.registryStatus,
    company: publicLookupPayload(result.company),
    lookupToken: signCompanyLookup(result.company),
  })
}
