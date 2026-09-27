import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { checkRateLimit } from '@/lib/auth/rate-limit-http'
import { getPublicPricePlan } from '@/lib/commercial/public-pricing'

const QuerySchema = z.object({
  plan_version_id: z.string().uuid(),
})

/**
 * Public catalog lookup for the registration page: resolves the plan a
 * visitor selected on /priser (plan_version_id in the register URL) into a
 * display name and price. Reads only the public pricing catalog (active,
 * is_public plans) — nothing tenant-scoped.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const parsed = QuerySchema.safeParse({ plan_version_id: url.searchParams.get('plan_version_id') })
  if (!parsed.success) {
    return NextResponse.json({ error: 'Ogiltig plan.' }, { status: 400 })
  }

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'unknown'
  const limit = await checkRateLimit({
    prefix: 'public:price-plan',
    identifier: ip,
    maxRequests: 30,
    windowMs: 60 * 1000,
  })
  if (!limit.ok) return limit.response!

  const lookup = await getPublicPricePlan(parsed.data.plan_version_id)
  if (!lookup.ok) {
    return NextResponse.json({ error: 'Planen kunde inte hämtas just nu.' }, { status: 503 })
  }
  const data = lookup.plan
  if (!data) {
    return NextResponse.json({ error: 'Planen är inte tillgänglig.' }, { status: 404 })
  }

  return NextResponse.json({
    data: {
      planVersionId: data.plan_version_id,
      planCode: data.plan_code,
      name: data.public_name,
      priceExVat: Number(data.monthly_price_ex_vat),
      currency: data.currency,
      billingInterval: data.billing_interval,
      priceLabel: data.price_from_label,
      audienceType: data.audience_type,
    },
  })
}
