import type { Metadata } from 'next'
import Link from 'next/link'
import { CheckCircle2 } from 'lucide-react'
import { listPublicPricePlans, planLimitLabel, type PublicPricePlan } from '@/lib/commercial/public-pricing'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

export const metadata: Metadata = {
  title: 'Priser för Nordklart',
  description: 'Tydliga abonnemang för företag, enskilda firmor och redovisningsbyråer. Alla planer innehåller automatisk bokföring och bokslut.',
}

const money = (value: number, currency = 'SEK') => new Intl.NumberFormat('sv-SE', {
  style: 'currency',
  currency,
  maximumFractionDigits: 0,
}).format(value)

function includedFeatures(plan: PublicPricePlan) {
  const preferred = [
    'bookkeeping.core',
    'bookkeeping.automation',
    'year_end.projects',
    'reports.core',
    'vat.reports',
    'salary.runs',
    'agency.review_queue',
    'agency.deadlines',
    'api.access',
  ]
  const byCode = new Map(plan.features_json.map((feature) => [feature.code, feature]))
  const picked = preferred.flatMap((code) => byCode.get(code) ? [byCode.get(code)!] : [])
  return picked.length > 0 ? picked.slice(0, 6) : plan.features_json.slice(0, 6)
}

function PlanCard({ plan }: { plan: PublicPricePlan }) {
  const isAgency = plan.audience_type === 'agency'
  return (
    <article className="flex h-full flex-col rounded-3xl border bg-card p-6 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          {plan.public_badge ? <Badge variant="secondary">{plan.public_badge}</Badge> : null}
          <h2 className="mt-3 text-2xl font-semibold tracking-tight">{plan.public_name}</h2>
          <p className="mt-2 min-h-12 text-sm leading-6 text-muted-foreground">{plan.public_summary}</p>
        </div>
      </div>

      <div className="mt-6">
        <div className="text-sm text-muted-foreground">Pris från</div>
        <div className="mt-1 text-3xl font-semibold">{money(plan.monthly_price_ex_vat, plan.currency)}<span className="text-base font-normal text-muted-foreground">/mån</span></div>
        <p className="mt-1 text-xs text-muted-foreground">Priser visas exklusive moms. Innehåll och villkor kan variera beroende på vald plan.</p>
      </div>

      <div className="mt-5 grid gap-2 rounded-2xl bg-muted/40 p-4 text-sm">
        {isAgency ? (
          <>
            <div className="flex justify-between gap-3"><span>Kundbolag</span><strong>{planLimitLabel(plan, 'agency.clients', 'Ingår enligt plan')}</strong></div>
            <div className="flex justify-between gap-3"><span>Byråmedarbetare</span><strong>{planLimitLabel(plan, 'agency.staff', 'Ingår enligt plan')}</strong></div>
          </>
        ) : (
          <>
            <div className="flex justify-between gap-3"><span>Användare</span><strong>{planLimitLabel(plan, 'company.users', 'Ingår enligt plan')}</strong></div>
            <div className="flex justify-between gap-3"><span>Löneanställda</span><strong>{planLimitLabel(plan, 'payroll.employees', 'Ingår enligt plan')}</strong></div>
            <div className="flex justify-between gap-3"><span>Extern rådgivare/revisor</span><strong>{planLimitLabel(plan, 'external.advisors', 'Ingår enligt plan')}</strong></div>
          </>
        )}
      </div>

      <ul className="mt-5 space-y-3 text-sm">
        {includedFeatures(plan).map((feature) => (
          <li key={feature.code} className="flex gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <span>{feature.name}</span>
          </li>
        ))}
      </ul>

      <div className="mt-auto pt-6">
        <Button asChild className="w-full">
          <Link href={plan.cta_href}>{plan.cta_label}</Link>
        </Button>
      </div>
    </article>
  )
}

export default async function PriserPage() {
  const plans = await listPublicPricePlans()
  const companyPlans = plans.filter((plan) => plan.audience_type === 'company')
  const agencyPlans = plans.filter((plan) => plan.audience_type === 'agency')
  const companyFrom = companyPlans.length ? Math.min(...companyPlans.map((plan) => plan.monthly_price_ex_vat)) : null
  const agencyFrom = agencyPlans.length ? Math.min(...agencyPlans.map((plan) => plan.monthly_price_ex_vat)) : null

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-12 px-6 py-16 sm:py-24 lg:px-8">
      <section className="mx-auto max-w-3xl text-center">
        <Badge variant="secondary">Priser</Badge>
        <h1 className="mt-5 text-4xl font-semibold tracking-tight sm:text-5xl">Automatisk bokföring och bokslut för företag och byråer.</h1>
        <p className="mt-5 text-lg leading-8 text-muted-foreground">
          Alla abonnemang innehåller automatisk bokföring och bokslut. Skillnaden är kapacitet: användare, löneanställda, kundbolag, byråfunktioner och automation.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3 text-sm text-muted-foreground">
          {companyFrom !== null ? <span>Företag från <strong className="text-foreground">{money(companyFrom)}</strong>/mån</span> : null}
          {agencyFrom !== null ? <span>Byrå från <strong className="text-foreground">{money(agencyFrom)}</strong>/mån</span> : null}
        </div>
      </section>

      <section>
        <div className="mb-6 flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-sm font-medium uppercase tracking-wide text-primary">För företag</p>
            <h2 className="text-2xl font-semibold">Aktiebolag och enskild firma</h2>
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">Välj nivå efter antal användare och löneanställda. Bokföring och bokslut ingår i alla planer.</p>
        </div>
        <div className="grid gap-5 lg:grid-cols-3">
          {companyPlans.map((plan) => <PlanCard key={plan.plan_id} plan={plan} />)}
        </div>
      </section>

      <section>
        <div className="mb-6 flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-sm font-medium uppercase tracking-wide text-primary">För redovisningsbyråer</p>
            <h2 className="text-2xl font-semibold">Byråabonnemang med kundbolag</h2>
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">Byrån har eget abonnemang och får hantera flera kundbolag enligt planens gränser.</p>
        </div>
        <div className="grid gap-5 lg:grid-cols-3">
          {agencyPlans.map((plan) => <PlanCard key={plan.plan_id} plan={plan} />)}
        </div>
      </section>
    </main>
  )
}