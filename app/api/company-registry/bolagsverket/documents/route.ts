import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/require-auth'
import { checkDurableRateLimit } from '@/lib/auth/rate-limit-durable'
import { normalizeOrgNumber } from '@/lib/company-lookup/normalize-org-number'
import { listAnnualReportsAtBolagsverket } from '@/lib/company-registry/provider'

const bodySchema = z.object({
  organizationNumber: z.string().trim().min(1).max(32),
})

// Signed-in only: every call spends Nordklart's Bolagsverket credentials. The
// limit is keyed on the user alone, so rotating the org number does not reset it.
export async function POST(request: NextRequest) {
  const auth = await requireAuth()
  if (auth.error) return auth.error

  const body = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(body)

  const limit = await checkDurableRateLimit({
    prefix: 'company-registry:bolagsverket:documents',
    identifier: auth.user.id,
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
