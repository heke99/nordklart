import Link from 'next/link'
import { redirect } from 'next/navigation'
import { CheckCircle2, LockKeyhole, ToggleLeft } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { NordklartActionCard, NordklartPageShell, NordklartStatCard } from '@/components/nordklart/NordklartShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

export const dynamic = 'force-dynamic'

type PlanRow = {
  id: string
  code: string
  name: string
  description: string | null
  billing_interval: string
  price_excl_vat: number | string
  status: string
  trial_days: number
  monthly_included_clients: number | null
  target_audience: string | null
  is_default: boolean
  product_id: string
}

type FeatureRow = {
  id: string
  code: string
  name: string
  category: string
  risk_level: string
  requires_human_review: boolean
}

export default async function PlatformPricePlansPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [
    { data: role },
    { data: products },
    { data: plans },
    { data: features },
    { data: planFeatures },
    { count: activeSubscriptions },
    { count: activeEntitlements },
    { count: oneTimePurchases },
  ] = await Promise.all([
    supabase.from('platform_roles').select('role').eq('user_id', user.id).is('revoked_at', null).maybeSingle(),
    supabase.from('platform_products').select('id, code, name, product_type, status, sort_order').order('sort_order', { ascending: true }),
    supabase.from('platform_price_plans').select('*').order('sort_order', { ascending: true }),
    supabase.from('platform_features').select('id, code, name, category, risk_level, requires_human_review').order('category', { ascending: true }).order('code', { ascending: true }),
    supabase.from('platform_plan_features').select('plan_id, feature_id, enabled, limit_value, limit_unit').eq('enabled', true),
    supabase.from('company_subscriptions').select('*', { count: 'exact', head: true }).in('status', ['trialing', 'active']),
    supabase.from('company_entitlements').select('*', { count: 'exact', head: true }).eq('enabled', true),
    supabase.from('one_time_purchases').select('*', { count: 'exact', head: true }).in('status', ['paid', 'active', 'fulfilled']),
  ])

  const isPlatform = role?.role === 'platform_admin'
  const planRows = (plans ?? []) as PlanRow[]
  const featureRows = (features ?? []) as FeatureRow[]
  const featureCountByPlan = new Map<string, number>()
  for (const row of planFeatures ?? []) {
    featureCountByPlan.set(row.plan_id, (featureCountByPlan.get(row.plan_id) ?? 0) + 1)
  }

  return (
    <NordklartPageShell
      eyebrow="Batch 4"
      title="Prisplaner och feature gates"
      description="Planer, features, abonnemang, entitlements, engångsköp och usage-grund är separerade så superadmin kan styra access utan att ändra bokföringsmotorn."
      actions={
        <Button asChild variant="secondary">
          <Link href="/platform">Till plattform</Link>
        </Button>
      }
    >
      <div className="grid gap-4 md:grid-cols-4">
        <NordklartStatCard label="Produkter" value={products?.length ?? 0} description="Start, Auto, Byrå, Bokslut och Bankgiro." tone="primary" />
        <NordklartStatCard label="Prisplaner" value={planRows.length} description="Styrbara från platform admin." />
        <NordklartStatCard label="Aktiva abonnemang" value={activeSubscriptions ?? 0} description="Trial eller active." tone="success" />
        <NordklartStatCard label="Entitlements" value={activeEntitlements ?? 0} description="Aktiva feature gates." />
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        {planRows.map((plan) => (
          <div key={plan.id} className="rounded-3xl border bg-card p-5 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <Badge variant={plan.status === 'active' ? 'success' : 'secondary'}>{plan.billing_interval === 'one_time' ? 'Engångsköp' : 'Abonnemang'}</Badge>
              {plan.is_default ? <Badge>Default</Badge> : null}
            </div>
            <h2 className="mt-4 text-xl font-semibold">{plan.name}</h2>
            <p className="mt-2 min-h-16 text-sm leading-6 text-muted-foreground">{plan.description}</p>
            <div className="mt-5 text-3xl font-semibold tabular-nums">{Number(plan.price_excl_vat).toLocaleString('sv-SE')} kr</div>
            <div className="text-xs text-muted-foreground">exkl. moms · {plan.trial_days} dagars trial</div>
            <div className="mt-5 space-y-2 text-sm">
              <div className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-primary" /> {featureCountByPlan.get(plan.id) ?? 0} features</div>
              <div className="flex items-center gap-2"><ToggleLeft className="h-4 w-4 text-primary" /> {plan.target_audience ?? 'tenant'}</div>
              <div className="flex items-center gap-2"><LockKeyhole className="h-4 w-4 text-primary" /> {isPlatform ? 'Kan administreras' : 'Read only'}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <NordklartActionCard meta="Feature gates" title="Access styrs av plan + override" description="company_has_feature() läser både aktiva entitlements och planens feature mapping. Manuell override kan läggas utan att ändra prisplanen." />
        <NordklartActionCard meta="Engångsköp" title="Bokslut utan månadsabonnemang" description={`Aktiva/fulfyllda engångsköp: ${oneTimePurchases ?? 0}. Year-end access kan kopplas till räkenskapsår och permanent eller tidsbegränsad access.`} />
        <NordklartActionCard meta="Säkerhet" title="Autobokföring är high-risk feature" description="Bank.matching och bank.autobook markeras med human-review-krav så automation inte öppnas tyst för fel bolag." />
      </div>

      <div className="rounded-3xl border bg-card p-5">
        <h2 className="text-xl font-semibold">Feature-katalog</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {featureRows.map((feature) => (
            <div key={feature.id} className="rounded-2xl border bg-background/70 p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium">{feature.name}</span>
                <Badge variant={feature.risk_level === 'high' ? 'warning' : 'secondary'}>{feature.category}</Badge>
              </div>
              <div className="mt-2 font-mono text-xs text-muted-foreground">{feature.code}</div>
              {feature.requires_human_review ? <div className="mt-2 text-xs text-warning-foreground">Kräver mänsklig granskning</div> : null}
            </div>
          ))}
        </div>
      </div>
    </NordklartPageShell>
  )
}
