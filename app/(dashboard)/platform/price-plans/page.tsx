import Link from 'next/link'
import { CheckCircle2, CircleDollarSign, Clock3, CreditCard, Gift, ShieldCheck } from 'lucide-react'
import { requirePlatformAdmin } from '@/lib/auth/platform'
import { isStripeConfigured } from '@/lib/billing/stripe'
import { NordklartActionCard, NordklartPageShell, NordklartStatCard } from '@/components/nordklart/NordklartShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  createPlanVersionAction,
  createPricePlanAction,
  grantCommercialAccessAction,
  publishPlanVersionAction,
  replacePlanVersionFeaturesAction,
  retirePlanVersionAction,
  revokeCommercialAccessAction,
  setManualSubscriptionAction,
  setProductTaxSettingsAction,
  processSubscriptionChangeRequestAction,
  rejectSubscriptionChangeRequestAction,
  syncStripePriceAction,
  updatePlanStatusAction,
} from './actions'

export const dynamic = 'force-dynamic'

type ProductRow = { id: string; code: string; name: string; product_type: 'subscription' | 'addon' | 'one_time'; status: string; sort_order: number; stripe_tax_code: string | null; stripe_tax_behavior: 'exclusive' | 'inclusive' }
type PlanRow = { id: string; product_id: string; code: string; name: string; description: string | null; billing_interval: string; currency: string; status: string; trial_days: number; monthly_included_clients: number | null; sort_order: number }
type VersionRow = { id: string; plan_id: string; version_number: number; status: string; effective_from: string; effective_until: string | null; price_excl_vat: number | string; vat_rate: number | string; currency: string; billing_interval: string; trial_days: number; monthly_included_clients: number | null; grace_days: number; stripe_product_id: string | null; stripe_price_id: string | null; stripe_tax_behavior: 'exclusive' | 'inclusive'; published_at: string | null }
type FeatureRow = { id: string; code: string; name: string; category: string; risk_level: string; requires_human_review: boolean }
type VersionFeatureRow = { plan_version_id: string; feature_id: string; enabled: boolean; limit_value: number | string | null; limit_unit: string | null }
type CompanyRow = { id: string; name: string; org_number: string | null }
type GrantRow = { id: string; company_id: string; grant_type: string; status: string; starts_at: string; expires_at: string | null; note: string | null; created_at: string }
type SubscriptionRow = { id: string; company_id: string; plan_version_id: string | null; status: string; current_period_end: string | null; external_provider: string | null; created_at: string }
type CheckoutRow = { id: string; company_id: string; checkout_kind: string; status: string; amount_excl_vat: number | string; currency: string; stripe_checkout_session_id: string | null; created_at: string }
type WebhookRow = { id: string; event_type: string; status: string; attempt_count: number; company_id: string | null; received_at: string; processing_error: string | null }
type EffectiveFeatureRow = { feature_code: string; feature_name: string; category: string; allowed: boolean; reason: string | null; source_type: string | null; source_id: string | null; expires_at: string | null; limit_value: number | string | null; limit_unit: string | null }
type ChangeRequestRow = { id: string; company_id: string; subscription_id: string; request_type: 'change_plan' | 'cancel_subscription'; target_plan_version_id: string | null; status: string; requested_at: string; customer_note: string | null; internal_note: string | null; effective_at: string | null }

const money = (value: number | string, currency = 'SEK') => new Intl.NumberFormat('sv-SE', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(value))
const dateTime = (value: string | null) => value ? new Intl.DateTimeFormat('sv-SE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '–'
const intervalLabel = (value: string) => value === 'one_time' ? 'Engångsköp' : value === 'year' ? 'Årsvis' : 'Månadsvis'
const versionStatusVariant = (status: string) => status === 'active' ? 'success' : status === 'scheduled' ? 'warning' : 'secondary'

function selectedFeatureIds(rows: VersionFeatureRow[], versionId: string) {
  return new Map(rows.filter((row) => row.plan_version_id === versionId && row.enabled).map((row) => [row.feature_id, row]))
}

export default async function PlatformPricePlansPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; error?: string; company?: string }>
}) {
  const { supabase } = await requirePlatformAdmin()
  const query = await searchParams

  const [
    productsRes,
    plansRes,
    versionsRes,
    featuresRes,
    versionFeaturesRes,
    companiesRes,
    grantsRes,
    subscriptionsRes,
    checkoutsRes,
    webhookEventsRes,
    activeSubscriptionCountRes,
    purchaseCountRes,
    changeRequestsRes,
  ] = await Promise.all([
    supabase.from('platform_products').select('id,code,name,product_type,status,sort_order,stripe_tax_code,stripe_tax_behavior').order('sort_order', { ascending: true }),
    supabase.from('platform_price_plans').select('id,product_id,code,name,description,billing_interval,currency,status,trial_days,monthly_included_clients,sort_order').order('sort_order', { ascending: true }),
    supabase.from('platform_plan_versions').select('id,plan_id,version_number,status,effective_from,effective_until,price_excl_vat,vat_rate,currency,billing_interval,trial_days,monthly_included_clients,grace_days,stripe_product_id,stripe_price_id,stripe_tax_behavior,published_at').order('effective_from', { ascending: false }).order('version_number', { ascending: false }),
    supabase.from('platform_features').select('id,code,name,category,risk_level,requires_human_review').order('category', { ascending: true }).order('code', { ascending: true }),
    supabase.from('platform_plan_version_features').select('plan_version_id,feature_id,enabled,limit_value,limit_unit'),
    supabase.from('companies').select('id,name,org_number').order('name', { ascending: true }).limit(500),
    supabase.from('commercial_access_grants').select('id,company_id,grant_type,status,starts_at,expires_at,note,created_at').order('created_at', { ascending: false }).limit(100),
    supabase.from('company_subscriptions').select('id,company_id,plan_version_id,status,current_period_end,external_provider,created_at').order('created_at', { ascending: false }).limit(100),
    supabase.from('billing_checkout_sessions').select('id,company_id,checkout_kind,status,amount_excl_vat,currency,stripe_checkout_session_id,created_at').order('created_at', { ascending: false }).limit(20),
    supabase.from('stripe_webhook_events').select('id,event_type,status,attempt_count,company_id,received_at,processing_error').order('received_at', { ascending: false }).limit(20),
    supabase.from('company_subscriptions').select('*', { count: 'exact', head: true }).in('status', ['trialing', 'active']),
    supabase.from('one_time_purchases').select('*', { count: 'exact', head: true }).in('status', ['paid', 'active', 'fulfilled']),
    supabase.from('company_subscription_change_requests').select('id,company_id,subscription_id,request_type,target_plan_version_id,status,requested_at,customer_note,internal_note,effective_at').order('requested_at', { ascending: false }).limit(100),
  ])

  const products = (productsRes.data ?? []) as ProductRow[]
  const plans = (plansRes.data ?? []) as PlanRow[]
  const versions = (versionsRes.data ?? []) as VersionRow[]
  const features = (featuresRes.data ?? []) as FeatureRow[]
  const versionFeatures = (versionFeaturesRes.data ?? []) as VersionFeatureRow[]
  const companies = (companiesRes.data ?? []) as CompanyRow[]
  const grants = (grantsRes.data ?? []) as GrantRow[]
  const subscriptions = (subscriptionsRes.data ?? []) as SubscriptionRow[]
  const checkouts = (checkoutsRes.data ?? []) as CheckoutRow[]
  const webhookEvents = (webhookEventsRes.data ?? []) as WebhookRow[]
  const changeRequests = (changeRequestsRes.data ?? []) as ChangeRequestRow[]

  const productById = new Map(products.map((product) => [product.id, product]))
  const companyById = new Map(companies.map((company) => [company.id, company]))
  const versionById = new Map(versions.map((version) => [version.id, version]))
  const versionsByPlan = new Map<string, VersionRow[]>()
  for (const version of versions) versionsByPlan.set(version.plan_id, [...(versionsByPlan.get(version.plan_id) ?? []), version])
  const activeVersions = versions.filter((version) => version.status === 'active')
  const scheduledVersions = versions.filter((version) => version.status === 'scheduled')
  const activeGrants = grants.filter((grant) => grant.status === 'active' || grant.status === 'scheduled')
  const stripeReadyVersions = versions.filter((version) => Boolean(version.stripe_price_id)).length
  const selectedCompanyId = query.company && companies.some((company) => company.id === query.company) ? query.company : null
  const { data: effectiveFeatureData } = selectedCompanyId
    ? await supabase.rpc('company_effective_feature_access', { p_company_id: selectedCompanyId })
    : { data: [] }
  const effectiveFeatures = (effectiveFeatureData ?? []) as EffectiveFeatureRow[]

  return (
    <NordklartPageShell
      eyebrow="Superadmin · kommersiell styrning"
      title="Planer, priser och åtkomst"
      description="Nordklart styr produktkatalog, prisversioner, gratisåtkomst och kundabonnemang. Stripe bekräftar betalning, men Nordklart avgör alltid vilken funktion som faktiskt är aktiv."
      actions={<Button asChild variant="secondary"><Link href="/platform">Till plattform</Link></Button>}
    >
      {query.notice ? <div className="rounded-2xl border border-success/30 bg-success/10 px-5 py-4 text-sm text-success">{query.notice}</div> : null}
      {query.error ? <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-5 py-4 text-sm text-destructive">{query.error}</div> : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <NordklartStatCard label="Aktiva prisversioner" value={activeVersions.length} description="Det pris som kan säljas nu." tone="success" />
        <NordklartStatCard label="Schemalagda ändringar" value={scheduledVersions.length} description="Kommande priser utan att skriva över historik." tone={scheduledVersions.length ? 'warning' : 'default'} />
        <NordklartStatCard label="Aktiva abonnemang" value={activeSubscriptionCountRes.count ?? 0} description="Trial eller aktiv Stripe/manuell period." tone="primary" />
        <NordklartStatCard label="Bokslutsköp" value={purchaseCountRes.count ?? 0} description="Betalda eller aktiva engångsköp." />
        <NordklartStatCard label="Stripe-klara priser" value={stripeReadyVersions} description={isStripeConfigured() ? 'Stripe är konfigurerat i miljön.' : 'STRIPE_SECRET_KEY saknas i miljön.'} tone={isStripeConfigured() ? 'success' : 'warning'} />
      </div>

      <Tabs defaultValue="overview">
        <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto p-1">
          <TabsTrigger value="overview">Översikt</TabsTrigger>
          <TabsTrigger value="plans">Planer och priser</TabsTrigger>
          <TabsTrigger value="access">Åtkomst och kunder</TabsTrigger>
          <TabsTrigger value="stripe">Stripe och händelser</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-5">
          <div className="grid gap-4 lg:grid-cols-3">
            <NordklartActionCard meta="Prisversioner" title="Ändra aldrig ett publicerat pris" description="Varje prisändring börjar som utkast, får ett eget Stripe Price och publiceras eller schemaläggs. Befintliga kunders pris-snapshot ligger kvar.">
              <div className="flex items-center gap-2 text-sm font-medium"><Clock3 className="h-4 w-4 text-primary" /> {scheduledVersions.length} framtida prisändringar</div>
            </NordklartActionCard>
            <NordklartActionCard meta="Grants" title="Complimentary Full Access" description="Gratis full produktåtkomst kan beviljas per bolag utan att skapa en plattformroll. Bankgiro är alltid ett separat val.">
              <div className="flex items-center gap-2 text-sm font-medium"><Gift className="h-4 w-4 text-primary" /> {activeGrants.length} aktiva eller schemalagda grants</div>
            </NordklartActionCard>
            <NordklartActionCard meta="Säkerhet" title="Access aktiveras efter rätt bevis" description="Checkout i sig ger inte funktionstillgång. Verifierat Stripe-event uppdaterar abonnemang eller köp, och Bankgiro kräver dessutom provisioning.">
              <div className="flex items-center gap-2 text-sm font-medium"><ShieldCheck className="h-4 w-4 text-primary" /> Server-side enforcement</div>
            </NordklartActionCard>
          </div>

          <section className="rounded-3xl border bg-card p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div><h2 className="text-xl font-semibold">Publicerade och kommande prisversioner</h2><p className="mt-1 text-sm text-muted-foreground">Kundens checkout använder bara aktiva versioner med ett kopplat Stripe Price.</p></div>
              <Badge variant={isStripeConfigured() ? 'success' : 'warning'}>{isStripeConfigured() ? 'Stripe ansluten' : 'Stripe behöver konfigureras'}</Badge>
            </div>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="border-b text-left text-muted-foreground"><tr><th className="px-3 py-3">Plan</th><th className="px-3 py-3">Version</th><th className="px-3 py-3">Pris</th><th className="px-3 py-3">Gäller från</th><th className="px-3 py-3">Stripe</th><th className="px-3 py-3">Status</th></tr></thead>
                <tbody>
                  {versions.filter((version) => ['active', 'scheduled', 'draft'].includes(version.status)).slice(0, 30).map((version) => {
                    const plan = plans.find((entry) => entry.id === version.plan_id)
                    return <tr key={version.id} className="border-b last:border-0"><td className="px-3 py-3 font-medium">{plan?.name ?? 'Okänd plan'}</td><td className="px-3 py-3">v{version.version_number}</td><td className="px-3 py-3 tabular-nums">{money(version.price_excl_vat, version.currency)} · {intervalLabel(version.billing_interval)}</td><td className="px-3 py-3">{dateTime(version.effective_from)}</td><td className="px-3 py-3">{version.stripe_price_id ? <Badge variant="success">Kopplad</Badge> : <Badge variant="warning">Saknas</Badge>}</td><td className="px-3 py-3"><Badge variant={versionStatusVariant(version.status)}>{version.status}</Badge></td></tr>
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </TabsContent>

        <TabsContent value="plans" className="space-y-5">
          <section className="rounded-3xl border bg-card p-5 shadow-sm"><div><h2 className="text-xl font-semibold">Moms och Stripe Tax</h2><p className="mt-1 text-sm text-muted-foreground">Varje produkt måste ha en Stripe Tax-kod innan en ny Stripe-prisversion kan synkas eller säljas. Priser anges exklusive moms när momsbeteendet är exklusivt.</p></div><div className="mt-4 grid gap-3 lg:grid-cols-2">{products.map((product) => <form key={product.id} action={setProductTaxSettingsAction} className="rounded-2xl border bg-background/60 p-4"><input type="hidden" name="product_id" value={product.id} /><div className="flex items-center justify-between gap-3"><div><p className="font-medium">{product.name}</p><p className="font-mono text-xs text-muted-foreground">{product.code}</p></div><Badge variant={product.stripe_tax_code ? 'success' : 'warning'}>{product.stripe_tax_code ? 'Moms klar' : 'Moms saknas'}</Badge></div><div className="mt-3 grid gap-3 md:grid-cols-2"><label className="text-sm font-medium">Stripe Tax-kod<input name="stripe_tax_code" required defaultValue={product.stripe_tax_code ?? ''} placeholder="txcd_..." className="mt-1 h-10 w-full rounded-lg border bg-card px-3" /></label><label className="text-sm font-medium">Momsbehandling<select name="stripe_tax_behavior" defaultValue={product.stripe_tax_behavior ?? 'exclusive'} className="mt-1 h-10 w-full rounded-lg border bg-card px-3"><option value="exclusive">Moms läggs på</option><option value="inclusive">Moms ingår</option></select></label></div><Button type="submit" size="sm" variant="secondary" className="mt-3">Spara momsinställning</Button></form>)}</div></section>
          <details className="rounded-3xl border bg-card p-5 shadow-sm">
            <summary className="cursor-pointer text-xl font-semibold">Skapa ny plan som utkast</summary>
            <p className="mt-2 text-sm text-muted-foreground">Välj produkt, definiera pris och markera exakt vilka feature gates planen ska innehålla. Priset blir inte synligt för kunder förrän du publicerar versionen.</p>
            <form action={createPricePlanAction} className="mt-5 space-y-5">
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <label className="text-sm font-medium">Produkt<select name="product_id" required className="mt-1 h-10 w-full rounded-lg border bg-background px-3">{products.filter((product) => product.status !== 'archived').map((product) => <option key={product.id} value={product.id}>{product.name} · {product.product_type}</option>)}</select></label>
                <label className="text-sm font-medium">Plankod<input name="code" required pattern="[a-z0-9_]+" placeholder="bookkeeping_monthly" className="mt-1 h-10 w-full rounded-lg border bg-background px-3" /></label>
                <label className="text-sm font-medium">Namn<input name="name" required placeholder="Nordklart Bokföring" className="mt-1 h-10 w-full rounded-lg border bg-background px-3" /></label>
                <label className="text-sm font-medium">Intervall<select name="billing_interval" defaultValue="month" className="mt-1 h-10 w-full rounded-lg border bg-background px-3"><option value="month">Månad</option><option value="year">År</option><option value="one_time">Engångsköp</option></select></label>
                <label className="text-sm font-medium">Pris exkl. moms<input name="price_excl_vat" type="number" min="0" step="0.01" required className="mt-1 h-10 w-full rounded-lg border bg-background px-3" /></label>
                <label className="text-sm font-medium">Moms %<input name="vat_rate" type="number" min="0" max="100" step="0.01" defaultValue="25" className="mt-1 h-10 w-full rounded-lg border bg-background px-3" /></label>
                <label className="text-sm font-medium">Testdagar<input name="trial_days" type="number" min="0" defaultValue="0" className="mt-1 h-10 w-full rounded-lg border bg-background px-3" /></label>
                <label className="text-sm font-medium">Inkluderade byråkunder<input name="monthly_included_clients" type="number" min="0" placeholder="Valfritt" className="mt-1 h-10 w-full rounded-lg border bg-background px-3" /></label><label className="text-sm font-medium">Betalningsgrace (dagar)<input name="grace_days" type="number" min="0" max="90" defaultValue="7" className="mt-1 h-10 w-full rounded-lg border bg-background px-3" /></label>
              </div>
              <label className="block text-sm font-medium">Beskrivning<textarea name="description" rows={2} className="mt-1 w-full rounded-lg border bg-background px-3 py-2" /></label>
              <div><div className="text-sm font-semibold">Inkluderade funktioner</div><div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{features.map((feature) => <label key={feature.id} className="rounded-xl border bg-background/70 p-3 text-sm"><span className="flex items-start gap-2"><input type="checkbox" name="feature_code" value={feature.code} className="mt-1" /><span><span className="font-medium">{feature.name}</span><span className="block font-mono text-xs text-muted-foreground">{feature.code}</span></span></span></label>)}</div></div>
              <Button type="submit"><CircleDollarSign className="mr-2 h-4 w-4" />Skapa planutkast</Button>
            </form>
          </details>

          <div className="space-y-5">
            {plans.map((plan) => {
              const product = productById.get(plan.product_id)
              const planVersions = versionsByPlan.get(plan.id) ?? []
              const current = planVersions.find((version) => version.status === 'active') ?? planVersions[0]
              return (
                <section key={plan.id} className="rounded-3xl border bg-card p-5 shadow-sm">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div><div className="flex flex-wrap items-center gap-2"><Badge variant={plan.status === 'active' ? 'success' : 'secondary'}>{plan.status}</Badge><Badge variant="secondary">{product?.product_type ?? 'okänd produkt'}</Badge><span className="font-mono text-xs text-muted-foreground">{plan.code}</span></div><h2 className="mt-3 text-2xl font-semibold">{plan.name}</h2><p className="mt-2 max-w-2xl text-sm text-muted-foreground">{plan.description || 'Ingen beskrivning.'}</p></div>
                    <div className="rounded-2xl border bg-background/70 px-4 py-3 text-right"><div className="text-xs text-muted-foreground">Nuvarande version</div><div className="mt-1 text-lg font-semibold">{current ? `v${current.version_number} · ${money(current.price_excl_vat, current.currency)}` : 'Saknas'}</div><div className="text-xs text-muted-foreground">{current ? intervalLabel(current.billing_interval) : ''}</div></div>
                  </div>

                  <div className="mt-5 grid gap-4 xl:grid-cols-2">
                    <details className="rounded-2xl border bg-background/60 p-4"><summary className="cursor-pointer font-medium">Ny prisversion</summary><form action={createPlanVersionAction} className="mt-4 grid gap-3 md:grid-cols-2"><input type="hidden" name="plan_id" value={plan.id} /><label className="text-sm">Pris exkl. moms<input name="price_excl_vat" type="number" min="0" step="0.01" defaultValue={current ? Number(current.price_excl_vat) : 0} className="mt-1 h-10 w-full rounded-lg border bg-background px-3" /></label><label className="text-sm">Moms %<input name="vat_rate" type="number" min="0" max="100" step="0.01" defaultValue={current ? Number(current.vat_rate) : 25} className="mt-1 h-10 w-full rounded-lg border bg-background px-3" /></label><label className="text-sm">Intervall<select name="billing_interval" defaultValue={current?.billing_interval || plan.billing_interval} className="mt-1 h-10 w-full rounded-lg border bg-background px-3"><option value="month">Månad</option><option value="year">År</option><option value="one_time">Engångsköp</option></select></label><label className="text-sm">Gäller från<input name="effective_from" type="datetime-local" defaultValue={new Date().toISOString().slice(0, 16)} className="mt-1 h-10 w-full rounded-lg border bg-background px-3" /></label><label className="text-sm">Testdagar<input name="trial_days" type="number" min="0" defaultValue={current?.trial_days ?? plan.trial_days} className="mt-1 h-10 w-full rounded-lg border bg-background px-3" /></label><label className="text-sm">Inkluderade byråkunder<input name="monthly_included_clients" type="number" min="0" defaultValue={current?.monthly_included_clients ?? plan.monthly_included_clients ?? ''} className="mt-1 h-10 w-full rounded-lg border bg-background px-3" /></label><label className="text-sm">Betalningsgrace (dagar)<input name="grace_days" type="number" min="0" max="90" defaultValue={current?.grace_days ?? 7} className="mt-1 h-10 w-full rounded-lg border bg-background px-3" /></label><input type="hidden" name="currency" value={current?.currency || plan.currency} /><div className="md:col-span-2"><Button size="sm" type="submit">Skapa nytt utkast</Button></div></form></details>
                    <details className="rounded-2xl border bg-background/60 p-4"><summary className="cursor-pointer font-medium">Katalogstatus och namn</summary><form action={updatePlanStatusAction} className="mt-4 grid gap-3 md:grid-cols-2"><input type="hidden" name="plan_id" value={plan.id} /><label className="text-sm">Namn<input name="name" defaultValue={plan.name} className="mt-1 h-10 w-full rounded-lg border bg-background px-3" /></label><label className="text-sm">Status<select name="status" defaultValue={plan.status} className="mt-1 h-10 w-full rounded-lg border bg-background px-3"><option value="active">Aktiv</option><option value="paused">Pausad</option><option value="archived">Arkiverad</option></select></label><label className="text-sm md:col-span-2">Beskrivning<textarea name="description" defaultValue={plan.description ?? ''} rows={2} className="mt-1 w-full rounded-lg border bg-background px-3 py-2" /></label><input type="hidden" name="sort_order" value={plan.sort_order} /><div><Button size="sm" variant="secondary" type="submit">Spara kataloguppgifter</Button></div></form></details>
                  </div>

                  <div className="mt-5 space-y-3">
                    {planVersions.map((version) => {
                      const enabledFeatures = selectedFeatureIds(versionFeatures, version.id)
                      return <div key={version.id} className="rounded-2xl border bg-background/60 p-4"><div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between"><div><div className="flex items-center gap-2"><span className="font-semibold">Version {version.version_number}</span><Badge variant={versionStatusVariant(version.status)}>{version.status}</Badge>{version.stripe_price_id ? <Badge variant="success">Stripe kopplad</Badge> : <Badge variant="warning">Stripe saknas</Badge>}</div><p className="mt-1 text-sm text-muted-foreground">{money(version.price_excl_vat, version.currency)} · {intervalLabel(version.billing_interval)} · gäller {dateTime(version.effective_from)} · {enabledFeatures.size} funktioner</p></div><div className="flex flex-wrap gap-2">{version.status === 'draft' ? <><form action={syncStripePriceAction}><input type="hidden" name="plan_version_id" value={version.id} /><Button type="submit" size="sm" variant="secondary" disabled={!isStripeConfigured()}><CreditCard className="mr-2 h-4 w-4" />Synka Stripe</Button></form><form action={publishPlanVersionAction}><input type="hidden" name="plan_version_id" value={version.id} /><input type="hidden" name="effective_from" value={version.effective_from} /><Button type="submit" size="sm"><CheckCircle2 className="mr-2 h-4 w-4" />Publicera</Button></form></> : null}{['active', 'scheduled'].includes(version.status) ? <form action={retirePlanVersionAction}><input type="hidden" name="plan_version_id" value={version.id} /><Button type="submit" size="sm" variant="outline">Avveckla</Button></form> : null}</div></div>
                      {version.status === 'draft' ? <details className="mt-4 rounded-xl border bg-card p-4"><summary className="cursor-pointer text-sm font-medium">Ändra funktioner i utkastet</summary><form action={replacePlanVersionFeaturesAction} className="mt-4"><input type="hidden" name="plan_version_id" value={version.id} /><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{features.map((feature) => { const selection = enabledFeatures.get(feature.id); return <label key={feature.id} className="rounded-xl border bg-background/70 p-3 text-sm"><span className="flex items-start gap-2"><input type="checkbox" name="feature_code" value={feature.code} defaultChecked={Boolean(selection)} className="mt-1" /><span><span className="font-medium">{feature.name}</span><span className="block font-mono text-xs text-muted-foreground">{feature.code}</span></span></span>{selection ? <span className="mt-2 grid grid-cols-2 gap-2"><input name={`limit_value__${feature.code}`} type="number" step="0.01" defaultValue={selection.limit_value ?? ''} placeholder="Gräns" className="h-8 rounded border bg-card px-2 text-xs" /><input name={`limit_unit__${feature.code}`} defaultValue={selection.limit_unit ?? ''} placeholder="Enhet" className="h-8 rounded border bg-card px-2 text-xs" /></span> : null}</label> })}</div><Button className="mt-4" size="sm" type="submit">Spara funktioner</Button></form></details> : null}</div>
                    })}
                  </div>
                </section>
              )
            })}
          </div>
        </TabsContent>

        <TabsContent value="access" className="space-y-5">
          <section className="rounded-3xl border bg-card p-5 shadow-sm"><div><h2 className="text-xl font-semibold">Abonnemangsändringar</h2><p className="mt-1 text-sm text-muted-foreground">Planbyten och uppsägningar behandlas här så basplan och beroende tillägg förblir konsekventa.</p></div><div className="mt-4 space-y-3">{changeRequests.map((request) => { const company = companyById.get(request.company_id); const target = request.target_plan_version_id ? versionById.get(request.target_plan_version_id) : null; const targetPlan = target ? plans.find((plan) => plan.id === target.plan_id) : null; const actionable = ['requested', 'approved'].includes(request.status); return <div key={request.id} className="rounded-2xl border bg-background/60 p-4"><div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between"><div><div className="flex flex-wrap items-center gap-2"><span className="font-medium">{request.request_type === 'cancel_subscription' ? 'Uppsägning' : 'Planbyte'}</span><Badge variant={request.status === 'scheduled' || request.status === 'applied' ? 'success' : request.status === 'failed' || request.status === 'rejected' ? 'warning' : 'secondary'}>{request.status}</Badge></div><p className="mt-1 text-sm text-muted-foreground">{company?.name ?? request.company_id} · {dateTime(request.requested_at)}{targetPlan ? ` · till ${targetPlan.name}` : ''}</p>{request.customer_note ? <p className="mt-2 text-sm">Kund: {request.customer_note}</p> : null}{request.internal_note ? <p className="mt-1 text-xs text-muted-foreground">Internt: {request.internal_note}</p> : null}{request.effective_at ? <p className="mt-1 text-xs text-muted-foreground">Planerad effekt: {dateTime(request.effective_at)}</p> : null}</div>{actionable ? <div className="flex flex-wrap gap-2"><form action={processSubscriptionChangeRequestAction}><input type="hidden" name="request_id" value={request.id} /><Button type="submit" size="sm">Behandla i Stripe</Button></form><form action={rejectSubscriptionChangeRequestAction} className="flex gap-2"><input type="hidden" name="request_id" value={request.id} /><input required name="reason" placeholder="Orsak" className="h-9 rounded-lg border bg-card px-3 text-sm" /><Button type="submit" size="sm" variant="outline">Avslå</Button></form></div> : null}</div></div> })}{changeRequests.length === 0 ? <p className="text-sm text-muted-foreground">Inga abonnemangsändringar att behandla.</p> : null}</div></section>
          <div className="grid gap-5 xl:grid-cols-2">
            <section className="rounded-3xl border bg-card p-5 shadow-sm"><div className="flex items-center gap-2"><Gift className="h-5 w-5 text-primary" /><h2 className="text-xl font-semibold">Bevilja complimentary access</h2></div><p className="mt-2 text-sm leading-6 text-muted-foreground">Complimentary Full Access ger produktåtkomst i ett specifikt bolag. Den ger inte plattformsåtkomst och inkluderar aldrig Bankgiro.</p><form action={grantCommercialAccessAction} className="mt-5 grid gap-3"><label className="text-sm font-medium">Bolag<select name="company_id" required className="mt-1 h-10 w-full rounded-lg border bg-background px-3">{companies.map((company) => <option key={company.id} value={company.id}>{company.name}{company.org_number ? ` · ${company.org_number}` : ''}</option>)}</select></label><label className="text-sm font-medium">Åtkomst<select name="grant_type" defaultValue="complimentary_full_access" className="mt-1 h-10 w-full rounded-lg border bg-background px-3"><option value="complimentary_full_access">Complimentary Full Access</option><option value="complimentary_bankgiro">Complimentary Bankgiro</option></select></label><div className="grid gap-3 md:grid-cols-2"><label className="text-sm font-medium">Start<input name="starts_at" type="datetime-local" defaultValue={new Date().toISOString().slice(0, 16)} className="mt-1 h-10 w-full rounded-lg border bg-background px-3" /></label><label className="text-sm font-medium">Slutar<input name="expires_at" type="datetime-local" className="mt-1 h-10 w-full rounded-lg border bg-background px-3" /></label></div><label className="text-sm font-medium">Intern anteckning<textarea name="note" rows={2} className="mt-1 w-full rounded-lg border bg-background px-3 py-2" /></label><Button type="submit">Bevilja access</Button></form></section>
            <section className="rounded-3xl border bg-card p-5 shadow-sm"><div className="flex items-center gap-2"><CircleDollarSign className="h-5 w-5 text-primary" /><h2 className="text-xl font-semibold">Manuellt basabonnemang</h2></div><p className="mt-2 text-sm leading-6 text-muted-foreground">Används för godkända migrationer eller administrerade avtal. Normala kunder ska välja och betala via Stripe Checkout.</p><form action={setManualSubscriptionAction} className="mt-5 grid gap-3"><label className="text-sm font-medium">Bolag<select name="company_id" required className="mt-1 h-10 w-full rounded-lg border bg-background px-3">{companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label><label className="text-sm font-medium">Aktiv abonnemangsversion<select name="plan_version_id" required className="mt-1 h-10 w-full rounded-lg border bg-background px-3">{activeVersions.filter((version) => productById.get(plans.find((plan) => plan.id === version.plan_id)?.product_id || '')?.product_type === 'subscription').map((version) => { const plan = plans.find((entry) => entry.id === version.plan_id); return <option key={version.id} value={version.id}>{plan?.name} · v{version.version_number} · {money(version.price_excl_vat, version.currency)}</option> })}</select></label><div className="grid gap-3 md:grid-cols-2"><label className="text-sm font-medium">Status<select name="status" defaultValue="active" className="mt-1 h-10 w-full rounded-lg border bg-background px-3"><option value="active">Aktiv</option><option value="trialing">Testperiod</option><option value="past_due">Förfallen</option><option value="paused">Pausad</option></select></label><label className="text-sm font-medium">Period slut<input name="current_period_end" type="datetime-local" className="mt-1 h-10 w-full rounded-lg border bg-background px-3" /></label></div><label className="text-sm font-medium">Intern anteckning<textarea name="note" rows={2} className="mt-1 w-full rounded-lg border bg-background px-3 py-2" /></label><Button type="submit" variant="secondary">Spara abonnemang</Button></form></section>
          </div>

          <section className="rounded-3xl border bg-card p-5 shadow-sm">
            <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between"><div><h2 className="text-xl font-semibold">Åtkomstinspektör</h2><p className="mt-1 text-sm text-muted-foreground">Visar exakt vilken accesskälla som avgör varje funktion för ett valt bolag.</p></div><form className="flex w-full gap-2 md:w-auto" method="get"><select name="company" defaultValue={selectedCompanyId ?? ''} className="h-10 min-w-60 rounded-lg border bg-background px-3 text-sm"><option value="">Välj bolag</option>{companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}</select><Button type="submit" variant="secondary">Visa</Button></form></div>
            {selectedCompanyId ? <div className="mt-5 overflow-x-auto"><table className="w-full min-w-[820px] text-sm"><thead className="border-b text-left text-muted-foreground"><tr><th className="px-3 py-3">Funktion</th><th className="px-3 py-3">Status</th><th className="px-3 py-3">Orsak/källa</th><th className="px-3 py-3">Giltighet</th><th className="px-3 py-3">Gräns</th></tr></thead><tbody>{effectiveFeatures.map((feature) => <tr key={feature.feature_code} className="border-b last:border-0"><td className="px-3 py-3"><div className="font-medium">{feature.feature_name}</div><div className="font-mono text-xs text-muted-foreground">{feature.feature_code}</div></td><td className="px-3 py-3"><Badge variant={feature.allowed ? 'success' : 'secondary'}>{feature.allowed ? 'Aktiv' : 'Inte aktiv'}</Badge></td><td className="px-3 py-3">{feature.allowed ? feature.source_type ?? 'okänd källa' : feature.reason ?? 'saknar åtkomst'}</td><td className="px-3 py-3">{dateTime(feature.expires_at)}</td><td className="px-3 py-3">{feature.limit_value ?? '–'}{feature.limit_unit ? ` ${feature.limit_unit}` : ''}</td></tr>)}{effectiveFeatures.length === 0 ? <tr><td colSpan={5} className="px-3 py-5 text-muted-foreground">Inga funktioner kunde läsas för valt bolag.</td></tr> : null}</tbody></table></div> : <p className="mt-5 text-sm text-muted-foreground">Välj ett bolag för att kontrollera varför det har eller saknar åtkomst.</p>}
          </section>

          <section className="rounded-3xl border bg-card p-5 shadow-sm"><h2 className="text-xl font-semibold">Aktiva och schemalagda access-grants</h2><div className="mt-4 space-y-3">{activeGrants.map((grant) => <div key={grant.id} className="flex flex-col gap-3 rounded-2xl border bg-background/60 p-4 md:flex-row md:items-center md:justify-between"><div><div className="flex items-center gap-2"><span className="font-medium">{grant.grant_type === 'complimentary_full_access' ? 'Complimentary Full Access' : 'Complimentary Bankgiro'}</span><Badge variant={grant.status === 'active' ? 'success' : 'warning'}>{grant.status}</Badge></div><p className="mt-1 text-sm text-muted-foreground">{companyById.get(grant.company_id)?.name ?? grant.company_id} · start {dateTime(grant.starts_at)} · slut {dateTime(grant.expires_at)}</p>{grant.note ? <p className="mt-1 text-xs text-muted-foreground">{grant.note}</p> : null}</div><form action={revokeCommercialAccessAction} className="flex gap-2"><input type="hidden" name="grant_id" value={grant.id} /><input name="reason" placeholder="Orsak" className="h-9 rounded-lg border bg-card px-3 text-sm" /><Button type="submit" size="sm" variant="outline">Återkalla</Button></form></div>)}{activeGrants.length === 0 ? <p className="text-sm text-muted-foreground">Inga aktiva complimentary-grants.</p> : null}</div></section>

          <section className="rounded-3xl border bg-card p-5 shadow-sm"><h2 className="text-xl font-semibold">Senaste abonnemang</h2><div className="mt-4 overflow-x-auto"><table className="w-full min-w-[700px] text-sm"><thead className="border-b text-left text-muted-foreground"><tr><th className="px-3 py-3">Bolag</th><th className="px-3 py-3">Version</th><th className="px-3 py-3">Status</th><th className="px-3 py-3">Period slut</th><th className="px-3 py-3">Källa</th></tr></thead><tbody>{subscriptions.slice(0, 25).map((subscription) => { const version = subscription.plan_version_id ? versionById.get(subscription.plan_version_id) : null; const plan = version ? plans.find((entry) => entry.id === version.plan_id) : null; return <tr key={subscription.id} className="border-b last:border-0"><td className="px-3 py-3">{companyById.get(subscription.company_id)?.name ?? subscription.company_id}</td><td className="px-3 py-3">{plan?.name ?? 'Legacy'}{version ? ` · v${version.version_number}` : ''}</td><td className="px-3 py-3"><Badge variant={subscription.status === 'active' ? 'success' : 'secondary'}>{subscription.status}</Badge></td><td className="px-3 py-3">{dateTime(subscription.current_period_end)}</td><td className="px-3 py-3">{subscription.external_provider ?? '–'}</td></tr> })}</tbody></table></div></section>
        </TabsContent>

        <TabsContent value="stripe" className="space-y-5">
          <div className="grid gap-4 lg:grid-cols-3"><NordklartActionCard meta="Checkout" title="Betalning aktiverar aldrig access själv" description="Nordklart skapar ett Checkout-intent. Först när en verifierad Stripe-webhook bekräftar betalningen skapas abonnemang, add-on eller bokslutsköp." /><NordklartActionCard meta="Kundportal" title="Ändra kort och fakturor i Stripe" description="Kundportalen skapas på begäran för rätt Stripe Customer och skickar kunden tillbaka till Nordklart efter avslutad hantering." /><NordklartActionCard meta="Webhook" title="Idempotent och granskningsbar" description="Varje Stripe-event sparas med event-id och behandlingsstatus. Misslyckade events markeras för omförsök i stället för att bli tysta fel." /></div>
          <section className="rounded-3xl border bg-card p-5 shadow-sm"><h2 className="text-xl font-semibold">Senaste Checkout-försök</h2><div className="mt-4 overflow-x-auto"><table className="w-full min-w-[700px] text-sm"><thead className="border-b text-left text-muted-foreground"><tr><th className="px-3 py-3">Bolag</th><th className="px-3 py-3">Typ</th><th className="px-3 py-3">Belopp</th><th className="px-3 py-3">Status</th><th className="px-3 py-3">Tid</th></tr></thead><tbody>{checkouts.map((checkout) => <tr key={checkout.id} className="border-b last:border-0"><td className="px-3 py-3">{companyById.get(checkout.company_id)?.name ?? checkout.company_id}</td><td className="px-3 py-3">{checkout.checkout_kind}</td><td className="px-3 py-3">{money(checkout.amount_excl_vat, checkout.currency)}</td><td className="px-3 py-3"><Badge variant={checkout.status === 'completed' ? 'success' : checkout.status === 'failed' ? 'warning' : 'secondary'}>{checkout.status}</Badge></td><td className="px-3 py-3">{dateTime(checkout.created_at)}</td></tr>)}{checkouts.length === 0 ? <tr><td colSpan={5} className="px-3 py-5 text-muted-foreground">Inga Checkout-försök ännu.</td></tr> : null}</tbody></table></div></section>
          <section className="rounded-3xl border bg-card p-5 shadow-sm"><h2 className="text-xl font-semibold">Senaste Stripe-webhooks</h2><div className="mt-4 space-y-3">{webhookEvents.map((event) => <div key={event.id} className="rounded-2xl border bg-background/60 p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><span className="font-mono text-sm font-medium">{event.event_type}</span><p className="mt-1 text-xs text-muted-foreground">{dateTime(event.received_at)} · försök {event.attempt_count}{event.company_id ? ` · ${companyById.get(event.company_id)?.name ?? event.company_id}` : ''}</p></div><Badge variant={event.status === 'processed' ? 'success' : event.status === 'failed' ? 'warning' : 'secondary'}>{event.status}</Badge></div>{event.processing_error ? <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{event.processing_error}</p> : null}</div>)}{webhookEvents.length === 0 ? <p className="text-sm text-muted-foreground">Inga Stripe-händelser har tagits emot ännu.</p> : null}</div></section>
        </TabsContent>
      </Tabs>
    </NordklartPageShell>
  )
}
