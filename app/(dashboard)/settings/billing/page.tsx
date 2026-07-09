import { redirect } from 'next/navigation'
import { CheckCircle2, CircleAlert, ReceiptText } from 'lucide-react'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getActiveCompanyId } from '@/lib/company/context'
import { canManageCompanyBilling } from '@/lib/billing/access'
import { BillingActions } from '@/components/billing/BillingActions'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

type PlanRow = { id: string; product_id: string; code: string; name: string; description: string | null; status: string; is_public: boolean | null; audience_type: string | null }
type ProductRow = { id: string; code: string; product_type: 'subscription' | 'addon' | 'one_time'; status: string }
type VersionRow = { id: string; plan_id: string; price_excl_vat: number | string; currency: string; billing_interval: string; stripe_price_id: string | null; status: string; effective_from: string; grace_days: number }
type SubscriptionRow = { id: string; plan_version_id: string | null; status: string; current_period_end: string | null; grace_ends_at: string | null; external_provider: string | null; cancel_at_period_end: boolean }
type ItemRow = { id: string; plan_version_id: string; status: string; current_period_end: string | null; grace_ends_at: string | null; quantity: number | string }
type GrantRow = { id: string; grant_type: string; status: string; starts_at: string; expires_at: string | null }
type PurchaseRow = { id: string; plan_version_id: string | null; purchase_type: string; status: string; price_excl_vat: number | string; currency: string; fiscal_period_id: string | null; created_at: string }
type PeriodRow = { id: string; name: string; period_start: string; period_end: string }
type BillingEventRow = { id: string; event_type: string; amount_excl_vat: number | string | null; currency: string; created_at: string }
type ChangeRequestRow = { id: string; request_type: 'change_plan' | 'cancel_subscription'; status: string; requested_at: string; target_plan_version_id: string | null }
type StripeInvoiceRow = { id: string; status: string | null; currency: string; amount_excl_vat: number | string | null; tax_amount: number | string | null; amount_incl_vat: number | string | null; hosted_invoice_url: string | null; invoice_pdf_url: string | null; invoice_date: string | null }
type BankgiroRow = { id: string; status: string; provider_setup_status: string | null; documents_status: string | null; updated_at: string }

const money = (value: number | string, currency = 'SEK') => new Intl.NumberFormat('sv-SE', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(value))
const date = (value: string | null) => value ? new Intl.DateTimeFormat('sv-SE', { dateStyle: 'medium' }).format(new Date(value)) : '–'

const statusLabel = (status?: string | null) => {
  const labels: Record<string, string> = {
    active: 'Aktiv',
    paid: 'Betald',
    fulfilled: 'Slutförd',
    pending: 'Väntar',
    past_due: 'Betalning saknas',
    cancelled: 'Avslutad',
    failed: 'Misslyckad',
    submitted: 'Inskickad',
    under_review: 'Under granskning',
    needs_information: 'Behöver kompletteras',
    provider_setup: 'Aktivering',
  }
  return labels[status ?? ''] ?? status ?? '–'
}

const grantLabel = (grantType: string) => {
  if (grantType === 'complimentary_full_access') return 'Kostnadsfri åtkomst'
  if (grantType === 'complimentary_bankgiro') return 'Kostnadsfri Bankgiroåtkomst'
  return 'Särskild åtkomst'
}

const billingEventLabel = (eventType: string) => {
  const labels: Record<string, string> = {
    checkout_session_completed: 'Betalning bekräftad',
    customer_subscription_created: 'Abonnemang startat',
    customer_subscription_updated: 'Abonnemang uppdaterat',
    customer_subscription_deleted: 'Abonnemang avslutat',
    invoice_paid: 'Faktura betald',
    invoice_payment_failed: 'Fakturabetalning misslyckades',
    one_time_purchase_paid: 'Engångsköp betalt',
  }
  return labels[eventType] ?? 'Betalningshändelse'
}

export default async function BillingSettingsPage({ searchParams }: { searchParams: Promise<{ checkout?: string; checkout_id?: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const companyId = await getActiveCompanyId(supabase, user.id)
  if (!companyId) redirect('/onboarding')
  const canManageBilling = await canManageCompanyBilling(supabase, user.id, companyId)
  const query = await searchParams

  // Cancel return from Stripe: mark the local checkout session failed so the
  // open-session guard doesn't block a retry until Stripe's 24h expiry.
  // Scoped to the active company + created/open status; a later paid webhook
  // still completes the purchase (stripe_finalize_checkout_v2 only skips
  // sessions already marked completed).
  if (
    query.checkout === 'cancelled'
    && query.checkout_id
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(query.checkout_id)
    && canManageBilling
  ) {
    await createServiceClient()
      .from('billing_checkout_sessions')
      .update({ status: 'failed' })
      .eq('id', query.checkout_id)
      .eq('company_id', companyId)
      .in('status', ['created', 'open'])
  }

  const [
    subscriptionsRes,
    itemsRes,
    grantsRes,
    purchasesRes,
    periodsRes,
    eventsRes,
    bankgiroRes,
    profileRes,
    plansRes,
    productsRes,
    versionsRes,
    changeRequestsRes,
    invoicesRes,
  ] = await Promise.all([
    supabase.from('company_subscriptions').select('id,plan_version_id,status,current_period_end,grace_ends_at,external_provider,cancel_at_period_end').eq('company_id', companyId).order('created_at', { ascending: false }).limit(10),
    supabase.from('company_subscription_items').select('id,plan_version_id,status,current_period_end,grace_ends_at,quantity').eq('company_id', companyId).order('created_at', { ascending: false }).limit(20),
    supabase.from('commercial_access_grants').select('id,grant_type,status,starts_at,expires_at').eq('company_id', companyId).order('created_at', { ascending: false }).limit(20),
    supabase.from('one_time_purchases').select('id,plan_version_id,purchase_type,status,price_excl_vat,currency,fiscal_period_id,created_at').eq('company_id', companyId).order('created_at', { ascending: false }).limit(20),
    supabase.from('fiscal_periods').select('id,name,period_start,period_end').eq('company_id', companyId).order('period_end', { ascending: false }).limit(20),
    supabase.from('billing_events').select('id,event_type,amount_excl_vat,currency,created_at').eq('company_id', companyId).order('created_at', { ascending: false }).limit(12),
    supabase.from('bankgiro_applications').select('id,status,provider_setup_status,documents_status,updated_at').eq('company_id', companyId).order('updated_at', { ascending: false }).limit(1),
    supabase.from('company_billing_profiles').select('stripe_customer_id').eq('company_id', companyId).maybeSingle(),
    // Load the whole catalog (including archived plans) so the CURRENT
    // subscription always renders its plan name — purchase filtering
    // happens separately below.
    supabase.from('platform_price_plans').select('id,product_id,code,name,description,status,is_public,audience_type').order('sort_order', { ascending: true }),
    supabase.from('platform_products').select('id,code,product_type,status').eq('status', 'active').order('sort_order', { ascending: true }),
    supabase.from('platform_plan_versions').select('id,plan_id,price_excl_vat,currency,billing_interval,stripe_price_id,status,effective_from,grace_days').in('status', ['active', 'scheduled']).order('effective_from', { ascending: false }),
    supabase.from('company_subscription_change_requests').select('id,request_type,status,requested_at,target_plan_version_id').eq('company_id', companyId).order('requested_at', { ascending: false }).limit(20),
    supabase.from('stripe_invoice_records').select('id,status,currency,amount_excl_vat,tax_amount,amount_incl_vat,hosted_invoice_url,invoice_pdf_url,invoice_date').eq('company_id', companyId).order('invoice_date', { ascending: false }).limit(20),
  ])

  const subscriptions = (subscriptionsRes.data ?? []) as SubscriptionRow[]
  const items = (itemsRes.data ?? []) as ItemRow[]
  const grants = (grantsRes.data ?? []) as GrantRow[]
  const purchases = (purchasesRes.data ?? []) as PurchaseRow[]
  const periods = (periodsRes.data ?? []) as PeriodRow[]
  const events = (eventsRes.data ?? []) as BillingEventRow[]
  const bankgiro = ((bankgiroRes.data ?? []) as BankgiroRow[])[0] ?? null
  const plans = (plansRes.data ?? []) as PlanRow[]
  const products = (productsRes.data ?? []) as ProductRow[]
  const versions = (versionsRes.data ?? []) as VersionRow[]
  const changeRequests = (changeRequestsRes.data ?? []) as ChangeRequestRow[]
  const invoices = (invoicesRes.data ?? []) as StripeInvoiceRow[]

  const planById = new Map(plans.map((plan) => [plan.id, plan]))
  const productById = new Map(products.map((product) => [product.id, product]))
  const versionById = new Map(versions.map((version) => [version.id, version]))
  const periodById = new Map(periods.map((period) => [period.id, period]))
  const activeSubscription = subscriptions.find((subscription) => ['trialing', 'active', 'past_due', 'paused'].includes(subscription.status)) ?? null
  const currentVersion = activeSubscription?.plan_version_id ? versionById.get(activeSubscription.plan_version_id) : null
  const currentPlan = currentVersion ? planById.get(currentVersion.plan_id) : null
  const activeBase = Boolean(activeSubscription && ['trialing', 'active'].includes(activeSubscription.status))
  const activeItems = items.filter((item) => ['trialing', 'active', 'past_due'].includes(item.status))
  const activeGrants = grants.filter((grant) => ['active', 'scheduled'].includes(grant.status))
  const upcomingVersion = currentVersion
    ? versions.find((version) => version.plan_id === currentVersion.plan_id && version.status === 'scheduled') ?? null
    : null

  // Base plans are audience-scoped: a byrå's own subscription company buys
  // agency plans, everyone else buys company plans. Add-ons and one-time
  // products are audience-neutral SKUs.
  const [{ data: agencyRow }, { data: companyRow }] = await Promise.all([
    supabase.from('agencies').select('id').eq('company_id', companyId).maybeSingle(),
    supabase.from('companies').select('name').eq('id', companyId).maybeSingle(),
  ])
  const buyerAudience = agencyRow ? 'agency' : 'company'
  const companyName = (companyRow as { name?: string } | null)?.name ?? null

  const purchasablePlans = versions
    .map((version) => {
      const plan = planById.get(version.plan_id)
      const product = plan ? productById.get(plan.product_id) : null
      if (!plan || !product || version.status !== 'active') return null
      // Only currently sold plans are purchasable — archived/paused plans
      // remain loaded above solely so existing subscriptions render names.
      if (plan.status !== 'active') return null
      if (product.product_type === 'subscription') {
        // Public base plans matching the buyer's audience. Plans without an
        // audience (legacy/internal) are not self-service purchasable.
        if (plan.is_public !== true) return null
        if (plan.audience_type !== buyerAudience && plan.audience_type !== 'both') return null
      }
      return {
        id: version.id,
        name: plan.name,
        description: plan.description,
        productType: product.product_type,
        productCode: product.code,
        billingInterval: version.billing_interval,
        price: Number(version.price_excl_vat),
        currency: version.currency,
        stripeReady: Boolean(version.stripe_price_id),
      }
    })
    .filter((plan): plan is NonNullable<typeof plan> => Boolean(plan))

  // Signup plan intent: the plan chosen on /priser is stored on the signup
  // draft (signup_drafts.selected_plan_version_id) and honored here — the
  // one place where payment actually happens. Never auto-charges; it only
  // pre-selects the plan in the purchase UI.
  let preselectedPlanVersionId: string | null = null
  if (!activeBase && canManageBilling) {
    const { data: draft } = await createServiceClient()
      .from('signup_drafts')
      .select('selected_plan_version_id')
      .eq('claimed_by_user_id', user.id)
      .not('selected_plan_version_id', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const draftVersionId = (draft as { selected_plan_version_id?: string | null } | null)?.selected_plan_version_id ?? null
    if (draftVersionId && purchasablePlans.some((plan) => plan.id === draftVersionId)) {
      preselectedPlanVersionId = draftVersionId
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {query.checkout === 'success' ? <div className="rounded-2xl border border-success/30 bg-success/10 px-5 py-4 text-sm text-success">Tack. Betalningen tas emot och tjänsten aktiveras när betalningen har bekräftats.</div> : null}
      {query.checkout === 'cancelled' ? <div className="rounded-2xl border border-warning/30 bg-warning/10 px-5 py-4 text-sm text-warning-foreground">Betalningen avbröts. Ingen ny tjänst har aktiverats.</div> : null}

      <section className="rounded-[1.75rem] border bg-card p-6 shadow-sm md:p-8">
        <p className="text-sm font-medium text-primary">Plan och tjänster</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Hantera Nordklart för ditt företag</h1>
        <p className="mt-3 max-w-3xl text-muted-foreground">Se aktiv plan, tillägg, bokslutsköp och Bankgiro-status på ett ställe. Tillgång hanteras säkert och uppdateras när betalning eller beslut är bekräftat.</p>
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          <div className="rounded-2xl border bg-background/70 p-5"><p className="text-sm text-muted-foreground">Basplan</p><p className="mt-1 text-lg font-semibold">{currentPlan?.name ?? 'Ingen aktiv basplan'}</p><p className="mt-2 text-sm text-muted-foreground">{currentVersion ? `${money(currentVersion.price_excl_vat, currentVersion.currency)} · ${currentVersion.billing_interval === 'year' ? 'årsvis' : 'månadsvis'} · nästa period till ${date(activeSubscription?.current_period_end ?? null)}` : 'Välj en plan för löpande Nordklart-tjänster.'}</p>{activeSubscription?.status === 'past_due' && activeSubscription.grace_ends_at ? <p className="mt-2 text-xs font-medium text-warning-foreground">Betalning saknas. Tillgång gäller till {date(activeSubscription.grace_ends_at)}.</p> : null}{activeSubscription?.cancel_at_period_end ? <p className="mt-2 text-xs font-medium text-warning-foreground">Uppsägning är planerad. Tillgång upphör {date(activeSubscription.current_period_end)}.</p> : null}{upcomingVersion ? <p className="mt-2 text-xs text-muted-foreground">Kommande pris: {money(upcomingVersion.price_excl_vat, upcomingVersion.currency)} från {date(upcomingVersion.effective_from)}.</p> : null}</div>
          <div className="rounded-2xl border bg-background/70 p-5"><p className="text-sm text-muted-foreground">Aktiva tillägg</p><p className="mt-1 text-lg font-semibold">{activeItems.length}</p><p className="mt-2 text-sm text-muted-foreground">{activeItems.length ? activeItems.map((item) => planById.get(versionById.get(item.plan_version_id)?.plan_id ?? '')?.name ?? 'Tillägg').join(', ') : 'Exempelvis Bankgiro hanteras separat från bokföringsplanen.'}</p></div>
          <div className="rounded-2xl border bg-background/70 p-5"><p className="text-sm text-muted-foreground">Särskild åtkomst</p><p className="mt-1 text-lg font-semibold">{activeGrants.length ? 'Aktiv' : 'Ordinarie plan'}</p><p className="mt-2 text-sm text-muted-foreground">{activeGrants.length ? activeGrants.map((grant) => grantLabel(grant.grant_type)).join(', ') : 'Bankgiro hanteras som separat tillägg.'}</p></div>
        </div>
      </section>

      {canManageBilling ? <BillingActions plans={purchasablePlans} fiscalPeriods={periods.map((period) => ({ id: period.id, name: period.name, periodStart: period.period_start, periodEnd: period.period_end }))} hasActiveBaseSubscription={activeBase} hasStripeCustomer={Boolean(profileRes.data?.stripe_customer_id)} activeSubscriptionId={activeSubscription?.id ?? null} activePlanVersionId={activeSubscription?.plan_version_id ?? null} preselectedPlanVersionId={preselectedPlanVersionId} changeRequests={changeRequests.map((request) => ({ id: request.id, requestType: request.request_type, status: request.status, requestedAt: request.requested_at, targetPlanVersionId: request.target_plan_version_id }))} companyName={companyName} yearEndPurchasedPeriodIds={purchases.filter((purchase) => purchase.purchase_type === 'year_end' && ['paid', 'active', 'fulfilled'].includes(purchase.status) && purchase.fiscal_period_id).map((purchase) => purchase.fiscal_period_id as string)} /> : <section className="rounded-2xl border bg-card p-5 text-sm text-muted-foreground">Endast företagets ägare eller administratör kan ändra abonnemang och betalning.</section>}

      <section className="rounded-3xl border bg-card p-5 shadow-sm"><h2 className="text-xl font-semibold">Aktiva tjänster och åtkomst</h2><div className="mt-4 grid gap-3 lg:grid-cols-2"><div className="rounded-2xl border bg-background/60 p-4"><p className="font-medium">Tillägg</p><div className="mt-3 space-y-2">{activeItems.map((item) => { const version = versionById.get(item.plan_version_id); const plan = version ? planById.get(version.plan_id) : null; return <div key={item.id} className="flex items-center justify-between gap-3 text-sm"><span>{plan?.name ?? 'Tillägg'}</span><span className="text-muted-foreground">{item.status === 'past_due' && item.grace_ends_at ? `Tillgång till ${date(item.grace_ends_at)}` : `Period till ${date(item.current_period_end)}`}</span></div> })}{activeItems.length === 0 ? <p className="text-sm text-muted-foreground">Inga aktiva tillägg.</p> : null}</div></div><div className="rounded-2xl border bg-background/60 p-4"><p className="font-medium">Gratis- och partneråtkomst</p><div className="mt-3 space-y-2">{activeGrants.map((grant) => <div key={grant.id} className="flex items-center justify-between gap-3 text-sm"><span>{grantLabel(grant.grant_type)}</span><span className="text-muted-foreground">{grant.expires_at ? `Gäller till ${date(grant.expires_at)}` : 'Utan slutdatum'}</span></div>)}{activeGrants.length === 0 ? <p className="text-sm text-muted-foreground">Ingen separat kostnadsfri åtkomst.</p> : null}</div></div></div></section>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="rounded-3xl border bg-card p-5 shadow-sm"><div className="flex items-center gap-2"><ReceiptText className="h-5 w-5 text-primary" /><h2 className="text-xl font-semibold">Köp och fakturering</h2></div><div className="mt-4 space-y-3">{purchases.map((purchase) => <div key={purchase.id} className="rounded-2xl border bg-background/60 p-4"><div className="flex items-center justify-between gap-3"><span className="font-medium">{purchase.purchase_type === 'year_end' ? 'Bokslut' : 'Engångsköp'}</span><Badge variant={['paid', 'active', 'fulfilled'].includes(purchase.status) ? 'success' : 'secondary'}>{statusLabel(purchase.status)}</Badge></div><p className="mt-1 text-sm text-muted-foreground">{money(purchase.price_excl_vat, purchase.currency)} · {purchase.fiscal_period_id ? periodById.get(purchase.fiscal_period_id)?.name ?? 'Räkenskapsår' : '–'} · {date(purchase.created_at)}</p></div>)}{purchases.length === 0 ? <p className="text-sm text-muted-foreground">Inga engångsköp ännu.</p> : null}</div></section>
        <section className="rounded-3xl border bg-card p-5 shadow-sm"><div className="flex items-center gap-2"><CheckCircle2 className="h-5 w-5 text-primary" /><h2 className="text-xl font-semibold">Bankgiro och Autogiro</h2></div><div className="mt-4 rounded-2xl border bg-background/60 p-4"><p className="font-medium">{bankgiro ? `Ansökan: ${statusLabel(bankgiro.status)}` : 'Ingen ansökan ännu'}</p><p className="mt-1 text-sm text-muted-foreground">{bankgiro ? `Underlag: ${statusLabel(bankgiro.documents_status)} · Aktivering: ${statusLabel(bankgiro.provider_setup_status)}` : 'Bankgiro är ett separat tillägg. Bokföringsplanen aktiverar inte Bankgiro automatiskt.'}</p><Button className="mt-4" asChild variant="secondary"><Link href="/payments/bankgiro">Visa Bankgiro</Link></Button></div></section>
      </div>

      <section className="rounded-3xl border bg-card p-5 shadow-sm"><div className="flex items-center gap-2"><ReceiptText className="h-5 w-5 text-primary" /><h2 className="text-xl font-semibold">Fakturor och moms</h2></div><div className="mt-4 space-y-3">{invoices.map((invoice) => <div key={invoice.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border bg-background/60 p-4"><div><p className="font-medium">{date(invoice.invoice_date)}</p><p className="mt-1 text-xs text-muted-foreground">Exkl. moms {invoice.amount_excl_vat === null ? '–' : money(invoice.amount_excl_vat, invoice.currency)} · Moms {invoice.tax_amount === null ? '–' : money(invoice.tax_amount, invoice.currency)} · Inkl. moms {invoice.amount_incl_vat === null ? '–' : money(invoice.amount_incl_vat, invoice.currency)}</p></div><div className="flex gap-2">{invoice.hosted_invoice_url ? <Button size="sm" variant="outline" asChild><a href={invoice.hosted_invoice_url} target="_blank" rel="noreferrer">Visa</a></Button> : null}{invoice.invoice_pdf_url ? <Button size="sm" variant="outline" asChild><a href={invoice.invoice_pdf_url} target="_blank" rel="noreferrer">PDF</a></Button> : null}</div></div>)}{invoices.length === 0 ? <p className="text-sm text-muted-foreground">Inga fakturor ännu.</p> : null}</div></section>

      <section className="rounded-3xl border bg-card p-5 shadow-sm"><div className="flex items-center gap-2"><CircleAlert className="h-5 w-5 text-primary" /><h2 className="text-xl font-semibold">Senaste betalningshändelser</h2></div><div className="mt-4 space-y-3">{events.map((event) => <div key={event.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border bg-background/60 p-4"><div><span className="text-sm font-medium">{billingEventLabel(event.event_type)}</span><p className="mt-1 text-xs text-muted-foreground">{date(event.created_at)}</p></div><span className="text-sm font-medium">{event.amount_excl_vat === null ? '–' : money(event.amount_excl_vat, event.currency)}</span></div>)}{events.length === 0 ? <p className="text-sm text-muted-foreground">Inga betalningshändelser ännu.</p> : null}</div></section>
    </div>
  )
}
