import { NextResponse } from 'next/server'
import { canManageCompanyBilling } from '@/lib/billing/access'
import { createStripePortalSession, isStripeConfigured, StripeRequestError } from '@/lib/billing/stripe'
import { getActiveCompanyId } from '@/lib/company/context'
import { createServiceClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth/require-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function billingAppOrigin(request: Request) {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim() || process.env.APP_URL?.trim()
  if (configured) {
    try {
      return new URL(configured).origin
    } catch {
      // Do not trust a browser-supplied Origin as a billing redirect target.
    }
  }
  return new URL(request.url).origin
}

export async function POST(request: Request) {
  const auth = await requireAuth()
  if (auth.error) return auth.error
  const { supabase, user } = auth
  if (!isStripeConfigured()) return NextResponse.json({ error: 'Betalningsportalen är inte konfigurerad.' }, { status: 503 })

  const companyId = await getActiveCompanyId(supabase, user.id)
  if (!companyId || !await canManageCompanyBilling(supabase, user.id, companyId)) {
    return NextResponse.json({ error: 'Endast företagets ägare eller administratör kan hantera abonnemang.' }, { status: 403 })
  }

  const service = createServiceClient()
  const { data: profile } = await service
    .from('company_billing_profiles')
    .select('stripe_customer_id')
    .eq('company_id', companyId)
    .maybeSingle()
  if (!profile?.stripe_customer_id) {
    return NextResponse.json({ error: 'Det finns ingen aktiv Stripe-kundprofil för företaget ännu.' }, { status: 409 })
  }

  try {
    const session = await createStripePortalSession({
      customerId: profile.stripe_customer_id,
      returnUrl: `${billingAppOrigin(request)}/settings/billing`,
    })
    return NextResponse.json({ url: session.url })
  } catch (error) {
    const message = error instanceof StripeRequestError ? error.message : 'Kundportalen kunde inte öppnas.'
    return NextResponse.json({ error: message }, { status: error instanceof StripeRequestError ? error.status : 502 })
  }
}
