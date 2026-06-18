import { NextResponse } from 'next/server'
import { z } from 'zod'
import { canManageCompanyBilling } from '@/lib/billing/access'
import { createStripeCheckoutSession, createStripeCustomer, isStripeConfigured, StripeRequestError } from '@/lib/billing/stripe'
import { getActiveCompanyId } from '@/lib/company/context'
import { createServiceClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth/require-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CheckoutRequest = z.object({
  planVersionId: z.string().uuid(),
  fiscalPeriodId: z.string().uuid().optional(),
})

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status })
}

function billingAppOrigin(request: Request) {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim() || process.env.APP_URL?.trim()
  if (configured) {
    try {
      return new URL(configured).origin
    } catch {
      // A malformed configuration must not make a browser-provided Origin trusted.
    }
  }
  return new URL(request.url).origin
}

export async function POST(request: Request) {
  const auth = await requireAuth()
  if (auth.error) return auth.error
  const { supabase, user } = auth
  if (!isStripeConfigured()) return jsonError('Betalning är inte konfigurerad ännu. Kontakta Nordklart.', 503)

  const parsed = CheckoutRequest.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return jsonError('Kontrollera vald plan och försök igen.', 422)

  const companyId = await getActiveCompanyId(supabase, user.id)
  if (!companyId) return jsonError('Välj ett företag innan du startar betalning.', 409)
  if (!await canManageCompanyBilling(supabase, user.id, companyId)) {
    return jsonError('Endast företagets ägare eller administratör kan hantera abonnemang.', 403)
  }

  const service = createServiceClient()
  const { data: version, error: versionError } = await service
    .from('platform_plan_versions')
    .select('id, plan_id, status, price_excl_vat, currency, billing_interval, stripe_price_id')
    .eq('id', parsed.data.planVersionId)
    .eq('status', 'active')
    .maybeSingle()
  if (versionError || !version) return jsonError('Den valda planversionen är inte tillgänglig.', 404)
  if (!version.stripe_price_id) return jsonError('Planen saknar ett publicerat Stripe-pris. Kontakta Nordklart.', 409)

  const { data: plan, error: planError } = await service
    .from('platform_price_plans')
    .select('id, code, name, product_id, status')
    .eq('id', version.plan_id)
    .maybeSingle()
  if (planError || !plan || plan.status !== 'active') return jsonError('Planen är inte tillgänglig.', 409)

  const { data: product, error: productError } = await service
    .from('platform_products')
    .select('id, code, product_type, status')
    .eq('id', plan.product_id)
    .maybeSingle()
  if (productError || !product || product.status !== 'active') return jsonError('Produkten är inte tillgänglig.', 409)

  const checkoutKind = product.product_type === 'subscription'
    ? 'subscription'
    : product.product_type === 'addon'
      ? 'addon'
      : 'one_time'

  let parentSubscriptionId: string | null = null
  if (checkoutKind === 'subscription') {
    const { data: currentBase } = await service
      .from('company_subscriptions')
      .select('id')
      .eq('company_id', companyId)
      .in('status', ['trialing', 'active', 'past_due', 'paused'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (currentBase) {
      return jsonError('Det finns redan ett basabonnemang. Hantera planbyte och betalning i kundportalen.', 409)
    }
  }

  if (checkoutKind === 'addon') {
    const { data: activeBase } = await service
      .from('company_subscriptions')
      .select('id')
      .eq('company_id', companyId)
      .in('status', ['trialing', 'active'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!activeBase) return jsonError('Ett aktivt basabonnemang krävs innan ett tillägg kan beställas.', 409)
    parentSubscriptionId = activeBase.id
  }

  let fiscalPeriodId: string | null = null
  if (checkoutKind === 'one_time' && product.code === 'year_end') {
    if (!parsed.data.fiscalPeriodId) return jsonError('Välj vilket räkenskapsår bokslutet gäller.', 422)
    const { data: period } = await service
      .from('fiscal_periods')
      .select('id')
      .eq('id', parsed.data.fiscalPeriodId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (!period) return jsonError('Det valda räkenskapsåret tillhör inte företaget.', 403)

    const { data: existingPurchase } = await service
      .from('one_time_purchases')
      .select('id')
      .eq('company_id', companyId)
      .eq('purchase_type', 'year_end')
      .eq('fiscal_period_id', period.id)
      .in('status', ['pending_payment', 'paid', 'active', 'fulfilled'])
      .maybeSingle()
    if (existingPurchase) return jsonError('Det finns redan ett pågående eller aktivt bokslutsköp för räkenskapsåret.', 409)
    fiscalPeriodId = period.id
  }

  const { data: existingProfile } = await service
    .from('company_billing_profiles')
    .select('stripe_customer_id, billing_email, billing_name')
    .eq('company_id', companyId)
    .maybeSingle()

  let stripeCustomerId = existingProfile?.stripe_customer_id || null
  if (!stripeCustomerId) {
    try {
      const customer = await createStripeCustomer({
        email: existingProfile?.billing_email || user.email || null,
        name: existingProfile?.billing_name || null,
        metadata: { nordklart_company_id: companyId },
        idempotencyKey: `nordklart-customer-${companyId}`,
      })
      stripeCustomerId = customer.id
      const { error: profileError } = await service.from('company_billing_profiles').upsert({
        company_id: companyId,
        stripe_customer_id: customer.id,
        billing_email: customer.email || user.email || null,
        billing_name: customer.name,
        created_by: user.id,
        metadata: { created_via: 'stripe_checkout' },
      }, { onConflict: 'company_id' })
      if (profileError) return jsonError('Kundprofilen för betalning kunde inte sparas.', 500)
    } catch (error) {
      const message = error instanceof StripeRequestError ? error.message : 'Stripe kunde inte skapa kundprofilen.'
      return jsonError(message, error instanceof StripeRequestError ? error.status : 502)
    }
  }

  let openCheckoutQuery = service
    .from('billing_checkout_sessions')
    .select('id')
    .eq('company_id', companyId)
    .eq('plan_version_id', version.id)
    .in('status', ['created', 'open'])
    .limit(1)
  openCheckoutQuery = fiscalPeriodId
    ? openCheckoutQuery.eq('fiscal_period_id', fiscalPeriodId)
    : openCheckoutQuery.is('fiscal_period_id', null)
  const { data: existingCheckout } = await openCheckoutQuery.maybeSingle()
  if (existingCheckout) {
    return jsonError('Det finns redan en pågående betalning för den här tjänsten. Avsluta eller avbryt den i Stripe innan du försöker igen.', 409)
  }

  const checkoutId = crypto.randomUUID()
  const { error: checkoutInsertError } = await service.from('billing_checkout_sessions').insert({
    id: checkoutId,
    company_id: companyId,
    plan_version_id: version.id,
    checkout_kind: checkoutKind,
    parent_subscription_id: parentSubscriptionId,
    fiscal_period_id: fiscalPeriodId,
    amount_excl_vat: version.price_excl_vat,
    currency: version.currency,
    created_by: user.id,
    metadata: { plan_code: plan.code, initiated_by: user.id },
  })
  if (checkoutInsertError) return jsonError('Betalningen kunde inte förberedas.', 500)

  const origin = billingAppOrigin(request)
  try {
    const stripeSession = await createStripeCheckoutSession({
      customerId: stripeCustomerId,
      priceId: version.stripe_price_id,
      mode: checkoutKind === 'one_time' ? 'payment' : 'subscription',
      successUrl: `${origin}/settings/billing?checkout=success`,
      cancelUrl: `${origin}/settings/billing?checkout=cancelled`,
      clientReferenceId: checkoutId,
      metadata: {
        nordklart_checkout_id: checkoutId,
        nordklart_company_id: companyId,
        nordklart_plan_version_id: version.id,
        nordklart_checkout_kind: checkoutKind,
        ...(fiscalPeriodId ? { nordklart_fiscal_period_id: fiscalPeriodId } : {}),
      },
      idempotencyKey: `nordklart-checkout-${checkoutId}`,
    })

    if (!stripeSession.url) throw new StripeRequestError('Stripe returnerade ingen betalningslänk.', 502)
    const { error: sessionUpdateError } = await service
      .from('billing_checkout_sessions')
      .update({
        stripe_checkout_session_id: stripeSession.id,
        stripe_customer_id: stripeCustomerId,
        status: 'open',
        metadata: { plan_code: plan.code, initiated_by: user.id, stripe_mode: checkoutKind === 'one_time' ? 'payment' : 'subscription' },
      })
      .eq('id', checkoutId)
    if (sessionUpdateError) return jsonError('Betalningen skapades men kunde inte sparas. Kontakta Nordklart.', 500)

    return NextResponse.json({ url: stripeSession.url })
  } catch (error) {
    await service.from('billing_checkout_sessions').update({ status: 'failed' }).eq('id', checkoutId)
    const message = error instanceof StripeRequestError ? error.message : 'Stripe kunde inte starta betalningen.'
    return jsonError(message, error instanceof StripeRequestError ? error.status : 502)
  }
}
