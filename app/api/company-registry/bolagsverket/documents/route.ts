import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { checkRateLimit } from '@/lib/auth/rate-limit-http'
import { normalizeOrgNumber } from '@/lib/company-lookup/normalize-org-number'
import { listAnnualReportsAtBolagsverket } from '@/lib/company-registry/provider'

const bodySchema = z.object({
  organizationNumber: z.string().trim().min(1).max(32),
})

function clientIp(request: NextRequest): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'unknown'
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(body)
  const ip = clientIp(request)

  const limit = await checkRateLimit({
    prefix: 'company-registry:bolagsverket:documents',
    identifier: `${ip}:${parsed.success ? parsed.data.organizationNumber.replace(/\D/g, '') : 'invalid'}`,
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

  const result = await listAnnualReportsAtBolagsverket(organizationNumber)
  if (!result.available) return NextResponse.json({ available: false })
  return NextResponse.json({ available: true, documents: result.documents })
}
