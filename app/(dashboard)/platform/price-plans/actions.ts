'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requirePlatformAdmin } from '@/lib/auth/platform'
import {
  createStripePrice,
  createStripeProduct,
  updateStripeProductTaxCode,
  isStripeConfigured,
} from '@/lib/billing/stripe'

const PRICING_PATH = '/platform/price-plans'

type SupabaseError = { message?: string } | null

function redirectWith(kind: 'notice' | 'error', value: string): never {
  redirect(`${PRICING_PATH}?${kind}=${encodeURIComponent(value)}`)
}

function text(formData: FormData, key: string, required = false) {
  const value = String(formData.get(key) ?? '').trim()
  if (required && !value) redirectWith('error', 'Ett obligatoriskt fält saknas.')
  return value || null
}

function numberValue(formData: FormData, key: string, fallback?: number | null) {
  const raw = text(formData, key)
  if (!raw) return fallback ?? null
  const value = Number(raw.replace(',', '.'))
  if (!Number.isFinite(value)) redirectWith('error', 'Ett pris eller en gräns är ogiltig.')
  return value
}

function dateTimeValue(formData: FormData, key: string) {
  const raw = text(formData, key)
  if (!raw) return null
  const value = new Date(raw)
  if (Number.isNaN(value.getTime())) redirectWith('error', 'Datumet är ogiltigt.')
  return value.toISOString()
}

function featurePayload(formData: FormData) {
  const codes = formData.getAll('feature_code').map((value) => String(value)).filter(Boolean)
  if (codes.length === 0) redirectWith('error', 'Välj minst en funktion för planversionen.')

  return codes.map((featureCode) => {
    const limitValue = numberValue(formData, `limit_value__${featureCode}`)
    const limitUnit = text(formData, `limit_unit__${featureCode}`)
    return {
      feature_code: featureCode,
      enabled: true,
      limit_value: limitValue,
      limit_unit: limitUnit,
    }
  })
}

function assertRpc(error: SupabaseError, fallback: string) {
  if (error) redirectWith('error', error.message || fallback)
}

async function syncPlanVersionToStripe(planVersionId: string) {
  if (!isStripeConfigured()) return false

  const { supabase } = await requirePlatformAdmin()
  const { data: version, error: versionError } = await supabase
    .from('platform_plan_versions')
    .select('id, plan_id, status, price_excl_vat, currency, billing_interval, stripe_product_id, stripe_price_id, stripe_tax_behavior')
    .eq('id', planVersionId)
    .maybeSingle()
  assertRpc(versionError, 'Planversionen kunde inte läsas.')
  if (!version) redirectWith('error', 'Planversionen finns inte.')

  if (version.stripe_price_id) return true

  const { data: plan, error: planError } = await supabase
    .from('platform_price_plans')
    .select('id, code, name, description, product_id')
    .eq('id', version.plan_id)
    .maybeSingle()
  assertRpc(planError, 'Planen kunde inte läsas.')
  if (!plan) redirectWith('error', 'Planen finns inte.')

  const { data: product, error: productError } = await supabase
    .from('platform_products')
    .select('id, stripe_tax_code, stripe_tax_behavior')
    .eq('id', plan.product_id)
    .maybeSingle()
  assertRpc(productError, 'Produktens momsinställning kunde inte läsas.')
  if (!product?.stripe_tax_code) {
    redirectWith('error', 'Produkten saknar Stripe Tax-kod. Sätt momsinställning innan priset synkas.')
  }

  const { data: existingStripeVersion } = await supabase
    .from('platform_plan_versions')
    .select('stripe_product_id')
    .eq('plan_id', plan.id)
    .not('stripe_product_id', 'is', null)
    .order('version_number', { ascending: false })
    .limit(1)
    .maybeSingle()

  const existingStripeProductId = version.stripe_product_id || existingStripeVersion?.stripe_product_id || null
  const stripeProductId = existingStripeProductId || (await createStripeProduct({
    name: plan.name,
    description: plan.description,
    taxCode: product.stripe_tax_code,
    metadata: { nordklart_plan_id: plan.id, nordklart_plan_code: plan.code },
    idempotencyKey: `nordklart-product-${plan.id}`,
  })).id
  if (existingStripeProductId) {
    await updateStripeProductTaxCode({
      productId: existingStripeProductId,
      taxCode: product.stripe_tax_code,
      metadata: { nordklart_plan_id: plan.id, nordklart_plan_code: plan.code },
      idempotencyKey: `nordklart-product-tax-${plan.id}-${product.stripe_tax_code}`,
    })
  }

  const taxBehavior = (version.stripe_tax_behavior ?? product.stripe_tax_behavior ?? 'exclusive') as 'exclusive' | 'inclusive'
  const stripePrice = await createStripePrice({
    productId: stripeProductId,
    amountExclVat: Number(version.price_excl_vat),
    currency: version.currency,
    billingInterval: version.billing_interval as 'month' | 'year' | 'one_time',
    taxBehavior,
    metadata: {
      nordklart_plan_id: plan.id,
      nordklart_plan_version_id: version.id,
      nordklart_plan_code: plan.code,
      nordklart_tax_behavior: taxBehavior,
    },
    idempotencyKey: `nordklart-price-${version.id}`,
  })

  const { error: bindError } = await supabase.rpc('platform_bind_stripe_price', {
    p_plan_version_id: version.id,
    p_stripe_product_id: stripeProductId,
    p_stripe_price_id: stripePrice.id,
  })
  assertRpc(bindError, 'Stripe-priset kunde inte kopplas till planversionen.')
  return true
}


export async function setProductTaxSettingsAction(formData: FormData) {
  const { supabase } = await requirePlatformAdmin()
  const productId = text(formData, 'product_id', true)!
  const taxCode = text(formData, 'stripe_tax_code', true)!
  const taxBehavior = text(formData, 'stripe_tax_behavior', true)!
  const { error } = await supabase.rpc('platform_set_product_tax_settings', {
    p_product_id: productId,
    p_stripe_tax_code: taxCode,
    p_stripe_tax_behavior: taxBehavior,
  })
  assertRpc(error, 'Produktens momsinställning kunde inte sparas.')
  revalidatePath(PRICING_PATH)
  redirectWith('notice', 'Stripe Tax-inställningen är sparad. Skapa en ny prisversion och synka Stripe innan den publiceras.')
}

export async function createPricePlanAction(formData: FormData) {
  const { supabase } = await requirePlatformAdmin()
  const productId = text(formData, 'product_id', true)!
  const code = text(formData, 'code', true)!
  const name = text(formData, 'name', true)!
  const description = text(formData, 'description')
  const billingInterval = text(formData, 'billing_interval', true)!
  const currency = (text(formData, 'currency') || 'SEK').toUpperCase()
  const price = numberValue(formData, 'price_excl_vat', 0)!
  const vatRate = numberValue(formData, 'vat_rate', 25)!
  const trialDays = numberValue(formData, 'trial_days', 0)!
  const includedClients = numberValue(formData, 'monthly_included_clients')
  const graceDays = numberValue(formData, 'grace_days', 7)!
  if (graceDays < 0 || graceDays > 90) redirectWith('error', 'Grace-perioden måste vara mellan 0 och 90 dagar.')
  const features = featurePayload(formData)

  const { data: planId, error: planError } = await supabase.rpc('platform_create_price_plan', {
    p_product_id: productId,
    p_code: code,
    p_name: name,
    p_description: description,
    p_billing_interval: billingInterval,
    p_currency: currency,
    p_trial_days: Math.round(trialDays),
    p_monthly_included_clients: includedClients === null ? null : Math.round(includedClients),
    p_sort_order: 100,
  })
  assertRpc(planError, 'Planen kunde inte skapas.')

  const { data: planVersionId, error: versionError } = await supabase.rpc('platform_create_price_plan_version', {
    p_plan_id: planId,
    p_price_excl_vat: price,
    p_vat_rate: vatRate,
    p_currency: currency,
    p_billing_interval: billingInterval,
    p_trial_days: Math.round(trialDays),
    p_monthly_included_clients: includedClients === null ? null : Math.round(includedClients),
    p_effective_from: new Date().toISOString(),
    p_metadata: { created_via: 'platform_pricing_console' },
  })
  assertRpc(versionError, 'Första planversionen kunde inte skapas.')

  const { error: featureError } = await supabase.rpc('platform_replace_plan_version_features', {
    p_plan_version_id: planVersionId,
    p_features: features,
  })
  assertRpc(featureError, 'Planens funktioner kunde inte sparas.')

  const { error: graceError } = await supabase.rpc('platform_set_price_plan_version_grace_days', {
    p_plan_version_id: planVersionId,
    p_grace_days: Math.round(graceDays),
  })
  assertRpc(graceError, 'Grace-perioden kunde inte sparas.')

  revalidatePath(PRICING_PATH)
  redirectWith('notice', 'Planen har skapats som ett utkast. Synka Stripe-priset och publicera när innehållet är klart.')
}

export async function createPlanVersionAction(formData: FormData) {
  const { supabase } = await requirePlatformAdmin()
  const planId = text(formData, 'plan_id', true)!
  const price = numberValue(formData, 'price_excl_vat', 0)!
  const vatRate = numberValue(formData, 'vat_rate', 25)!
  const interval = text(formData, 'billing_interval', true)!
  const currency = (text(formData, 'currency') || 'SEK').toUpperCase()
  const trialDays = numberValue(formData, 'trial_days', 0)!
  const includedClients = numberValue(formData, 'monthly_included_clients')
  const graceDays = numberValue(formData, 'grace_days', 7)!
  if (graceDays < 0 || graceDays > 90) redirectWith('error', 'Grace-perioden måste vara mellan 0 och 90 dagar.')
  const effectiveFrom = dateTimeValue(formData, 'effective_from') || new Date().toISOString()

  const { data: planVersionId, error } = await supabase.rpc('platform_create_price_plan_version', {
    p_plan_id: planId,
    p_price_excl_vat: price,
    p_vat_rate: vatRate,
    p_currency: currency,
    p_billing_interval: interval,
    p_trial_days: Math.round(trialDays),
    p_monthly_included_clients: includedClients === null ? null : Math.round(includedClients),
    p_effective_from: effectiveFrom,
    p_metadata: { created_via: 'platform_pricing_console' },
  })
  assertRpc(error, 'Planversionen kunde inte skapas.')

  const { error: graceError } = await supabase.rpc('platform_set_price_plan_version_grace_days', {
    p_plan_version_id: planVersionId,
    p_grace_days: Math.round(graceDays),
  })
  assertRpc(graceError, 'Grace-perioden kunde inte sparas.')

  revalidatePath(PRICING_PATH)
  redirectWith('notice', 'En ny planversion har skapats som utkast med tidigare feature-innehåll kopierat.')
}

export async function replacePlanVersionFeaturesAction(formData: FormData) {
  const { supabase } = await requirePlatformAdmin()
  const planVersionId = text(formData, 'plan_version_id', true)!
  const { error } = await supabase.rpc('platform_replace_plan_version_features', {
    p_plan_version_id: planVersionId,
    p_features: featurePayload(formData),
  })
  assertRpc(error, 'Planversionens funktioner kunde inte sparas.')
  revalidatePath(PRICING_PATH)
  redirectWith('notice', 'Feature-innehållet för utkastet har sparats.')
}

export async function syncStripePriceAction(formData: FormData) {
  const planVersionId = text(formData, 'plan_version_id', true)!
  if (!isStripeConfigured()) redirectWith('error', 'Stripe saknar STRIPE_SECRET_KEY i miljön.')
  await syncPlanVersionToStripe(planVersionId)
  revalidatePath(PRICING_PATH)
  redirectWith('notice', 'Stripe-produkt och immutabelt Stripe-pris är kopplade till planversionen.')
}

export async function publishPlanVersionAction(formData: FormData) {
  const { supabase } = await requirePlatformAdmin()
  const planVersionId = text(formData, 'plan_version_id', true)!
  const effectiveFrom = dateTimeValue(formData, 'effective_from')

  if (isStripeConfigured()) await syncPlanVersionToStripe(planVersionId)

  const { error } = await supabase.rpc('platform_publish_price_plan_version', {
    p_plan_version_id: planVersionId,
    p_effective_from: effectiveFrom,
  })
  assertRpc(error, 'Planversionen kunde inte publiceras.')
  revalidatePath(PRICING_PATH)
  redirectWith('notice', effectiveFrom && new Date(effectiveFrom) > new Date() ? 'Planversionen är schemalagd.' : 'Planversionen är publicerad.')
}

export async function retirePlanVersionAction(formData: FormData) {
  const { supabase } = await requirePlatformAdmin()
  const planVersionId = text(formData, 'plan_version_id', true)!
  const { error } = await supabase.rpc('platform_retire_price_plan_version', {
    p_plan_version_id: planVersionId,
  })
  assertRpc(error, 'Planversionen kunde inte avvecklas.')
  revalidatePath(PRICING_PATH)
  redirectWith('notice', 'Planversionen är avvecklad för nya köp. Befintliga kunders snapshots påverkas inte.')
}

export async function updatePlanStatusAction(formData: FormData) {
  const { supabase } = await requirePlatformAdmin()
  const planId = text(formData, 'plan_id', true)!
  const status = text(formData, 'status', true)!
  const { error } = await supabase.rpc('platform_update_price_plan_catalog', {
    p_plan_id: planId,
    p_name: text(formData, 'name'),
    p_description: text(formData, 'description'),
    p_status: status,
    p_sort_order: numberValue(formData, 'sort_order'),
  })
  assertRpc(error, 'Planen kunde inte uppdateras.')
  revalidatePath(PRICING_PATH)
  redirectWith('notice', 'Planens katalogstatus har uppdaterats.')
}

export async function grantCommercialAccessAction(formData: FormData) {
  const { supabase } = await requirePlatformAdmin()
  const companyId = text(formData, 'company_id', true)!
  const grantType = text(formData, 'grant_type', true)!
  const startsAt = dateTimeValue(formData, 'starts_at') || new Date().toISOString()
  const expiresAt = dateTimeValue(formData, 'expires_at')
  const note = text(formData, 'note')

  const rpcName = grantType === 'complimentary_bankgiro'
    ? 'platform_grant_complimentary_bankgiro'
    : 'platform_grant_complimentary_full_access'

  const { error } = await supabase.rpc(rpcName, {
    p_company_id: companyId,
    p_starts_at: startsAt,
    p_expires_at: expiresAt,
    p_note: note,
  })
  assertRpc(error, 'Åtkomsten kunde inte beviljas.')
  revalidatePath(PRICING_PATH)
  redirectWith('notice', grantType === 'complimentary_bankgiro' ? 'Complimentary Bankgiro har beviljats.' : 'Complimentary Full Access har beviljats.')
}

export async function revokeCommercialAccessAction(formData: FormData) {
  const { supabase } = await requirePlatformAdmin()
  const grantId = text(formData, 'grant_id', true)!
  const { error } = await supabase.rpc('platform_revoke_commercial_access_grant', {
    p_grant_id: grantId,
    p_reason: text(formData, 'reason'),
  })
  assertRpc(error, 'Åtkomsten kunde inte återkallas.')
  revalidatePath(PRICING_PATH)
  redirectWith('notice', 'Åtkomsten har återkallats och audit-loggats.')
}

export async function setManualSubscriptionAction(formData: FormData) {
  const { supabase } = await requirePlatformAdmin()
  const companyId = text(formData, 'company_id', true)!
  const planVersionId = text(formData, 'plan_version_id', true)!
  const status = text(formData, 'status', true)!
  const periodEnd = dateTimeValue(formData, 'current_period_end')

  const { error } = await supabase.rpc('platform_set_company_subscription', {
    p_company_id: companyId,
    p_plan_version_id: planVersionId,
    p_status: status,
    p_starts_at: new Date().toISOString(),
    p_current_period_end: periodEnd,
    p_trial_ends_at: null,
    p_override_note: text(formData, 'note') || 'Manuellt administrerat av superadmin',
  })
  assertRpc(error, 'Abonnemanget kunde inte uppdateras.')
  revalidatePath(PRICING_PATH)
  redirectWith('notice', 'Bolagets basabonnemang har uppdaterats.')
}

export async function processSubscriptionChangeRequestAction(formData: FormData) {
  const { supabase, user } = await requirePlatformAdmin()
  const requestId = text(formData, 'request_id', true)!
  const service = (await import('@/lib/supabase/server')).createServiceClient()
  const stripe = await import('@/lib/billing/stripe')

  const { data: request, error: requestError } = await service
    .from('company_subscription_change_requests')
    .select('id,company_id,subscription_id,request_type,target_plan_version_id,status')
    .eq('id', requestId)
    .maybeSingle()
  assertRpc(requestError, 'Ändringsbegäran kunde inte läsas.')
  if (!request || !['requested', 'approved'].includes(request.status)) redirectWith('error', 'Ändringsbegäran kan inte behandlas i sitt nuvarande läge.')

  const { data: subscription, error: subscriptionError } = await service
    .from('company_subscriptions')
    .select('id,external_provider,external_subscription_id,current_period_end,plan_version_id,status')
    .eq('id', request.subscription_id)
    .eq('company_id', request.company_id)
    .maybeSingle()
  assertRpc(subscriptionError, 'Abonnemanget kunde inte läsas.')
  if (!subscription?.external_subscription_id || subscription.external_provider !== 'stripe') {
    redirectWith('error', 'Endast aktiva Stripe-abonnemang kan schemaläggas från den här vyn.')
  }

  const mark = async (status: string, internalNote?: string | null, failureReason?: string | null, stripeOperationId?: string | null, effectiveAt?: string | null) => {
    const { error } = await supabase.rpc('platform_mark_subscription_change_request', {
      p_request_id: request.id,
      p_status: status,
      p_internal_note: internalNote || null,
      p_failure_reason: failureReason || null,
      p_stripe_operation_id: stripeOperationId || null,
      p_effective_at: effectiveAt || null,
    })
    assertRpc(error, 'Ändringsbegäran kunde inte uppdateras.')
  }

  try {
    await mark('processing', `Behandlas av ${user.email ?? user.id}`)
    const stripeSubscription = await stripe.retrieveStripeSubscription(subscription.external_subscription_id)
    const periodEnd = stripeSubscription.current_period_end
    if (!periodEnd) throw new Error('Stripe-abonnemanget saknar periodslut och kan inte schemaläggas säkert.')

    if (request.request_type === 'cancel_subscription') {
      const { data: dependentItems, error: itemsError } = await service
        .from('company_subscription_items')
        .select('id,external_subscription_item_id,status')
        .eq('subscription_id', subscription.id)
        .in('status', ['trialing', 'active', 'past_due', 'paused'])
      if (itemsError) throw itemsError
      for (const item of dependentItems ?? []) {
        if (!item.external_subscription_item_id) continue
        await stripe.scheduleStripeSubscriptionCancellation({
          subscriptionId: item.external_subscription_item_id,
          metadata: { nordklart_change_request_id: request.id, nordklart_company_id: request.company_id, nordklart_parent_subscription_id: subscription.id },
          idempotencyKey: `nordklart-cancel-addon-${request.id}-${item.id}`,
        })
      }
      const cancelled = await stripe.scheduleStripeSubscriptionCancellation({
        subscriptionId: subscription.external_subscription_id,
        metadata: { nordklart_change_request_id: request.id, nordklart_company_id: request.company_id },
        idempotencyKey: `nordklart-cancel-subscription-${request.id}`,
      })
      const { error: cancelStateError } = await supabase.rpc('platform_set_subscription_cancellation_state', {
        p_subscription_id: subscription.id,
        p_cancel_at_period_end: true,
        p_effective_at: new Date(periodEnd * 1000).toISOString(),
      })
      assertRpc(cancelStateError, 'Uppsägningen kunde inte sparas i Nordklart.')
      await mark('scheduled', 'Uppsägning är schemalagd i Stripe. Beroende tillägg avslutas samtidigt.', null, cancelled.id, new Date(periodEnd * 1000).toISOString())
    } else {
      if (!request.target_plan_version_id) throw new Error('Målplan saknas.')
      const { data: target, error: targetError } = await service
        .from('platform_plan_versions')
        .select('id,stripe_price_id,status')
        .eq('id', request.target_plan_version_id)
        .eq('status', 'active')
        .maybeSingle()
      if (targetError) throw targetError
      if (!target?.stripe_price_id) throw new Error('Målplanen saknar publicerat Stripe-pris.')
      const currentItem = stripeSubscription.items.data[0]
      const currentPriceId = currentItem?.price?.id
      const periodStart = stripeSubscription.current_period_start
      if (!currentPriceId || !periodStart || !periodEnd) throw new Error('Stripe-abonnemanget saknar period- eller prisdata och kan inte bytas säkert.')
      const schedule = await stripe.createStripeSubscriptionScheduleFromSubscription({ subscriptionId: subscription.external_subscription_id, idempotencyKey: `nordklart-change-schedule-${request.id}` })
      const updatedSchedule = await stripe.updateStripeSubscriptionSchedule({
        scheduleId: schedule.id,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        currentPriceId,
        targetPriceId: target.stripe_price_id,
        metadata: { nordklart_change_request_id: request.id, nordklart_company_id: request.company_id, nordklart_target_plan_version_id: target.id },
        idempotencyKey: `nordklart-change-schedule-update-${request.id}`,
      })
      await mark('scheduled', 'Planbyte är schemalagt i Stripe till nästa faktureringsperiod.', null, updatedSchedule.id, new Date(periodEnd * 1000).toISOString())
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Okänt fel när Stripe-begäran skulle behandlas.'
    await mark('failed', null, message)
    redirectWith('error', `Ändringsbegäran misslyckades: ${message}`)
  }

  revalidatePath(PRICING_PATH)
  revalidatePath('/settings/billing')
  redirectWith('notice', 'Ändringsbegäran är schemalagd och audit-loggad.')
}

export async function rejectSubscriptionChangeRequestAction(formData: FormData) {
  const { supabase } = await requirePlatformAdmin()
  const requestId = text(formData, 'request_id', true)!
  const reason = text(formData, 'reason', true)!
  const { error } = await supabase.rpc('platform_mark_subscription_change_request', {
    p_request_id: requestId,
    p_status: 'rejected',
    p_internal_note: reason,
    p_failure_reason: null,
    p_stripe_operation_id: null,
    p_effective_at: null,
  })
  assertRpc(error, 'Ändringsbegäran kunde inte avslås.')
  revalidatePath(PRICING_PATH)
  revalidatePath('/settings/billing')
  redirectWith('notice', 'Ändringsbegäran har avslagits och loggats.')
}
