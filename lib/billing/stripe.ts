import 'server-only'

import { createHmac, timingSafeEqual } from 'crypto'

type StripeErrorBody = {
  error?: {
    message?: string
    type?: string
    code?: string
  }
}

export class StripeRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message)
    this.name = 'StripeRequestError'
  }
}

export type StripeProduct = {
  id: string
  name: string
  tax_code?: string | null
}

export type StripePrice = {
  id: string
  product: string
  currency: string
  unit_amount: number | null
  tax_behavior?: 'exclusive' | 'inclusive' | 'unspecified' | null
}

export type StripeCheckoutSession = {
  id: string
  url: string | null
  customer: string | null
  subscription: string | null
  status: string | null
}

export type StripePortalSession = {
  id: string
  url: string
}

export type StripeCustomer = {
  id: string
  email: string | null
  name: string | null
}

export type StripeSubscriptionSchedule = {
  id: string
  status: string
  subscription: string | null
}

export type StripeSubscription = {
  id: string
  customer: string | null
  status: string
  cancel_at_period_end: boolean
  current_period_start: number | null
  current_period_end: number | null
  items: {
    data: Array<{
      id: string
      price?: { id?: string | null; recurring?: { interval?: 'month' | 'year' | 'week' | 'day' | null } | null } | null
    }>
  }
}

export type StripeTaxSettings = {
  automaticTax: { enabled: true }
  taxIdCollection: { enabled: true }
  customerUpdate: { address: 'auto'; name: 'auto' }
}

function stripeSecretKey() {
  const key = process.env.STRIPE_SECRET_KEY?.trim()
  if (!key) throw new StripeRequestError('Stripe är inte konfigurerat. Lägg in STRIPE_SECRET_KEY i miljön.', 503)
  return key
}

export function isStripeConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim())
}

/**
 * Nordklart never silently charges prices without a defined tax strategy.
 * Stripe Tax is the only supported live payment mode because it derives tax
 * from the customer location and preserves Stripe's tax evidence on invoices.
 */
export function getStripeTaxSettings(): StripeTaxSettings {
  const enabled = process.env.STRIPE_TAX_ENABLED?.trim().toLowerCase() === 'true'
  const mode = process.env.STRIPE_TAX_MODE?.trim().toLowerCase() || 'automatic'
  if (!enabled || mode !== 'automatic') {
    throw new StripeRequestError(
      'Moms är inte redo för betalning. Aktivera Stripe Tax och sätt STRIPE_TAX_ENABLED=true samt STRIPE_TAX_MODE=automatic.',
      503,
    )
  }

  return {
    automaticTax: { enabled: true },
    taxIdCollection: { enabled: true },
    customerUpdate: { address: 'auto', name: 'auto' },
  }
}

function appendFormValue(params: URLSearchParams, key: string, value: unknown) {
  if (value === undefined || value === null) return
  if (Array.isArray(value)) {
    value.forEach((item, index) => appendFormValue(params, `${key}[${index}]`, item))
    return
  }
  if (typeof value === 'object') {
    Object.entries(value as Record<string, unknown>).forEach(([childKey, childValue]) => {
      appendFormValue(params, `${key}[${childKey}]`, childValue)
    })
    return
  }
  params.append(key, typeof value === 'boolean' ? String(value) : String(value))
}

function toStripeForm(data: Record<string, unknown>) {
  const params = new URLSearchParams()
  Object.entries(data).forEach(([key, value]) => appendFormValue(params, key, value))
  return params
}

async function stripeRequest<T>(
  path: string,
  body?: Record<string, unknown>,
  options?: { idempotencyKey?: string; method?: 'POST' | 'GET' | 'DELETE' },
): Promise<T> {
  const key = stripeSecretKey()
  const method = options?.method ?? (body ? 'POST' : 'GET')
  const response = await fetch(`https://api.stripe.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(process.env.STRIPE_API_VERSION?.trim() ? { 'Stripe-Version': process.env.STRIPE_API_VERSION.trim() } : {}),
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(options?.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
    },
    body: body ? toStripeForm(body).toString() : undefined,
    cache: 'no-store',
  })

  const raw = await response.text()
  const data = raw ? JSON.parse(raw) as T | StripeErrorBody : {} as T
  if (!response.ok) {
    const error = data as StripeErrorBody
    throw new StripeRequestError(
      error.error?.message || 'Stripe kunde inte slutföra begäran.',
      response.status,
      error.error?.code,
    )
  }

  return data as T
}

export function amountToMinorUnits(amount: number | string) {
  const numeric = typeof amount === 'number' ? amount : Number(amount)
  if (!Number.isFinite(numeric) || numeric < 0) throw new StripeRequestError('Ogiltigt pris för Stripe.', 422)
  return Math.round(numeric * 100)
}

export async function createStripeCustomer(input: {
  email?: string | null
  name?: string | null
  metadata: Record<string, string>
  idempotencyKey?: string
}) {
  return stripeRequest<StripeCustomer>('/v1/customers', {
    email: input.email || undefined,
    name: input.name || undefined,
    metadata: input.metadata,
  }, { idempotencyKey: input.idempotencyKey })
}

export async function createStripeProduct(input: {
  name: string
  description?: string | null
  taxCode: string
  metadata: Record<string, string>
  idempotencyKey?: string
}) {
  return stripeRequest<StripeProduct>('/v1/products', {
    name: input.name,
    description: input.description || undefined,
    tax_code: input.taxCode,
    metadata: input.metadata,
  }, { idempotencyKey: input.idempotencyKey })
}

export async function updateStripeProductTaxCode(input: {
  productId: string
  taxCode: string
  metadata: Record<string, string>
  idempotencyKey?: string
}) {
  return stripeRequest<StripeProduct>(`/v1/products/${encodeURIComponent(input.productId)}`, {
    tax_code: input.taxCode,
    metadata: input.metadata,
  }, { idempotencyKey: input.idempotencyKey })
}

export async function createStripePrice(input: {
  productId: string
  amountExclVat: number | string
  currency: string
  billingInterval: 'month' | 'year' | 'one_time'
  taxBehavior: 'exclusive' | 'inclusive'
  metadata: Record<string, string>
  idempotencyKey?: string
}) {
  return stripeRequest<StripePrice>('/v1/prices', {
    product: input.productId,
    currency: input.currency.toLowerCase(),
    unit_amount: amountToMinorUnits(input.amountExclVat),
    tax_behavior: input.taxBehavior,
    recurring: input.billingInterval === 'one_time' ? undefined : { interval: input.billingInterval },
    metadata: input.metadata,
  }, { idempotencyKey: input.idempotencyKey })
}

export async function createStripeCheckoutSession(input: {
  customerId: string
  priceId: string
  mode: 'subscription' | 'payment'
  successUrl: string
  cancelUrl: string
  clientReferenceId: string
  metadata: Record<string, string>
  quantity?: number
  idempotencyKey?: string
}) {
  const tax = getStripeTaxSettings()
  return stripeRequest<StripeCheckoutSession>('/v1/checkout/sessions', {
    mode: input.mode,
    customer: input.customerId,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    client_reference_id: input.clientReferenceId,
    billing_address_collection: 'required',
    automatic_tax: tax.automaticTax,
    tax_id_collection: tax.taxIdCollection,
    customer_update: tax.customerUpdate,
    line_items: [{ price: input.priceId, quantity: input.quantity ?? 1 }],
    metadata: input.metadata,
    subscription_data: input.mode === 'subscription'
      ? { metadata: input.metadata, automatic_tax: tax.automaticTax }
      : undefined,
  }, { idempotencyKey: input.idempotencyKey })
}

export async function createStripePortalSession(input: {
  customerId: string
  returnUrl: string
}) {
  return stripeRequest<StripePortalSession>('/v1/billing_portal/sessions', {
    customer: input.customerId,
    return_url: input.returnUrl,
    configuration: process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID?.trim() || undefined,
  })
}

export async function retrieveStripeSubscription(subscriptionId: string) {
  return stripeRequest<StripeSubscription>(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`)
}

export async function updateStripeSubscriptionPlan(input: {
  subscriptionId: string
  subscriptionItemId: string
  targetPriceId: string
  metadata: Record<string, string>
  idempotencyKey: string
}) {
  return stripeRequest<StripeSubscription>(`/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`, {
    items: [{ id: input.subscriptionItemId, price: input.targetPriceId }],
    proration_behavior: 'none',
    billing_cycle_anchor: 'unchanged',
    metadata: input.metadata,
  }, { idempotencyKey: input.idempotencyKey })
}


export async function createStripeSubscriptionScheduleFromSubscription(input: {
  subscriptionId: string
  idempotencyKey: string
}) {
  return stripeRequest<StripeSubscriptionSchedule>('/v1/subscription_schedules', {
    from_subscription: input.subscriptionId,
  }, { idempotencyKey: input.idempotencyKey })
}

export async function updateStripeSubscriptionSchedule(input: {
  scheduleId: string
  currentPeriodStart: number
  currentPeriodEnd: number
  currentPriceId: string
  targetPriceId: string
  metadata: Record<string, string>
  idempotencyKey: string
}) {
  return stripeRequest<StripeSubscriptionSchedule>(`/v1/subscription_schedules/${encodeURIComponent(input.scheduleId)}`, {
    end_behavior: 'release',
    metadata: input.metadata,
    phases: [
      {
        start_date: input.currentPeriodStart,
        end_date: input.currentPeriodEnd,
        proration_behavior: 'none',
        items: [{ price: input.currentPriceId, quantity: 1 }],
      },
      {
        start_date: input.currentPeriodEnd,
        iterations: 1,
        proration_behavior: 'none',
        items: [{ price: input.targetPriceId, quantity: 1 }],
      },
    ],
  }, { idempotencyKey: input.idempotencyKey })
}

export async function scheduleStripeSubscriptionCancellation(input: {
  subscriptionId: string
  metadata: Record<string, string>
  idempotencyKey: string
}) {
  return stripeRequest<StripeSubscription>(`/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`, {
    cancel_at_period_end: true,
    metadata: input.metadata,
  }, { idempotencyKey: input.idempotencyKey })
}

export async function cancelStripeSubscription(input: {
  subscriptionId: string
  idempotencyKey: string
}) {
  return stripeRequest<StripeSubscription>(`/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`, undefined, {
    method: 'DELETE',
    idempotencyKey: input.idempotencyKey,
  })
}

function parseSignatureHeader(value: string) {
  const entries = value.split(',').map((part) => part.trim().split('='))
  const timestamp = entries.find(([key]) => key === 't')?.[1]
  const signatures = entries.filter(([key]) => key === 'v1').map(([, signature]) => signature).filter(Boolean)
  return { timestamp, signatures }
}

export function verifyStripeWebhookSignature(rawBody: string, signatureHeader: string | null, toleranceSeconds = 300) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim()
  if (!secret || !signatureHeader) return false

  const { timestamp, signatures } = parseSignatureHeader(signatureHeader)
  if (!timestamp || signatures.length === 0) return false

  const issuedAt = Number(timestamp)
  if (!Number.isFinite(issuedAt) || Math.abs(Math.floor(Date.now() / 1000) - issuedAt) > toleranceSeconds) return false

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex')
  return signatures.some((signature) => {
    const received = Buffer.from(signature, 'utf8')
    const candidate = Buffer.from(expected, 'utf8')
    return received.length === candidate.length && timingSafeEqual(received, candidate)
  })
}
