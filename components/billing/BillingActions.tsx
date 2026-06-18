'use client'

import { useMemo, useState, useTransition } from 'react'
import { CreditCard, ExternalLink, Loader2, RotateCcw, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'

type PurchasablePlan = {
  id: string
  name: string
  description: string | null
  productType: 'subscription' | 'addon' | 'one_time'
  productCode: string
  billingInterval: string
  price: number
  currency: string
  stripeReady: boolean
}

type FiscalPeriod = { id: string; name: string; periodStart: string; periodEnd: string }
type ChangeRequest = { id: string; requestType: 'change_plan' | 'cancel_subscription'; status: string; requestedAt: string; targetPlanVersionId: string | null }

type Props = {
  plans: PurchasablePlan[]
  fiscalPeriods: FiscalPeriod[]
  hasActiveBaseSubscription: boolean
  hasStripeCustomer: boolean
  activeSubscriptionId: string | null
  activePlanVersionId: string | null
  changeRequests: ChangeRequest[]
}

function formatPrice(plan: PurchasablePlan) {
  const amount = new Intl.NumberFormat('sv-SE', { style: 'currency', currency: plan.currency || 'SEK', maximumFractionDigits: 2 }).format(plan.price)
  if (plan.billingInterval === 'month') return `${amount} / månad exkl. moms`
  if (plan.billingInterval === 'year') return `${amount} / år exkl. moms`
  return `${amount} exkl. moms`
}

export function BillingActions({ plans, fiscalPeriods, hasActiveBaseSubscription, hasStripeCustomer, activeSubscriptionId, activePlanVersionId, changeRequests }: Props) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [yearEndPeriodId, setYearEndPeriodId] = useState(fiscalPeriods[0]?.id || '')
  const [targetPlanVersionId, setTargetPlanVersionId] = useState('')
  const [changeNote, setChangeNote] = useState('')
  const openRequest = useMemo(() => changeRequests.find((request) => ['requested', 'approved', 'processing', 'scheduled'].includes(request.status)) ?? null, [changeRequests])
  const alternativeBasePlans = useMemo(() => plans.filter((plan) => plan.productType === 'subscription' && plan.id !== activePlanVersionId && plan.stripeReady), [plans, activePlanVersionId])

  const openCheckout = (planVersionId: string, fiscalPeriodId?: string) => {
    setError(null); setNotice(null)
    startTransition(async () => {
      const response = await fetch('/api/billing/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planVersionId, ...(fiscalPeriodId ? { fiscalPeriodId } : {}) }) })
      const body = await response.json().catch(() => ({})) as { url?: string; error?: string }
      if (!response.ok || !body.url) { setError(body.error || 'Betalningen kunde inte startas.'); return }
      window.location.assign(body.url)
    })
  }

  const openPortal = () => {
    setError(null); setNotice(null)
    startTransition(async () => {
      const response = await fetch('/api/billing/portal', { method: 'POST' })
      const body = await response.json().catch(() => ({})) as { url?: string; error?: string }
      if (!response.ok || !body.url) { setError(body.error || 'Kundportalen kunde inte öppnas.'); return }
      window.location.assign(body.url)
    })
  }

  const requestChange = (requestType: 'change_plan' | 'cancel_subscription') => {
    if (!activeSubscriptionId || openRequest) return
    if (requestType === 'change_plan' && !targetPlanVersionId) { setError('Välj den plan du vill byta till.'); return }
    setError(null); setNotice(null)
    startTransition(async () => {
      const response = await fetch('/api/billing/subscription-changes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptionId: activeSubscriptionId, requestType, ...(requestType === 'change_plan' ? { targetPlanVersionId } : {}), note: changeNote || undefined }),
      })
      const body = await response.json().catch(() => ({})) as { message?: string; error?: string }
      if (!response.ok) { setError(body.error || 'Begäran kunde inte registreras.'); return }
      setNotice(body.message || 'Begäran är registrerad. Ladda om sidan för aktuell status.')
    })
  }

  return (
    <section className="rounded-[1.75rem] border bg-card p-6 shadow-sm md:p-8">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div><p className="text-sm font-medium text-primary">Abonnemang och tillägg</p><h2 className="mt-1 text-2xl font-semibold">Välj rätt tjänster</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Betalning, abonnemangsändringar och åtkomst hanteras i kontrollerade flöden. Nordklart aktiverar funktioner först efter verifierad betalning och rätt kontrollsteg.</p></div>
        {hasStripeCustomer ? <Button variant="secondary" onClick={openPortal} disabled={pending}>{pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ExternalLink className="mr-2 h-4 w-4" />}Fakturor och betalmetod</Button> : null}
      </div>
      {error ? <div className="mt-5 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div> : null}
      {notice ? <div className="mt-5 rounded-xl border border-success/30 bg-success/10 px-4 py-3 text-sm text-success">{notice}</div> : null}

      {hasActiveBaseSubscription ? <div className="mt-6 rounded-2xl border bg-background/70 p-5"><div className="flex items-start gap-3"><RotateCcw className="mt-0.5 h-5 w-5 text-primary" /><div className="min-w-0 flex-1"><h3 className="font-semibold">Planbyte eller uppsägning</h3><p className="mt-1 text-sm text-muted-foreground">Ändringen granskas och schemaläggs till nästa faktureringsperiod. Bankgiro och andra tillägg kontrolleras tillsammans med basplanen så att inget fortsätter av misstag.</p></div></div>{openRequest ? <p className="mt-4 rounded-lg bg-muted px-3 py-2 text-sm">Pågående begäran: <strong>{openRequest.requestType === 'cancel_subscription' ? 'uppsägning' : 'planbyte'}</strong> ({openRequest.status}).</p> : <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_auto_auto]"><select value={targetPlanVersionId} onChange={(event) => setTargetPlanVersionId(event.target.value)} className="h-10 rounded-lg border bg-card px-3 text-sm"><option value="">Välj ny plan</option>{alternativeBasePlans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name} · {formatPrice(plan)}</option>)}</select><Button variant="secondary" disabled={pending || !alternativeBasePlans.length} onClick={() => requestChange('change_plan')}>{pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-2 h-4 w-4" />}Begär planbyte</Button><Button variant="outline" disabled={pending} onClick={() => requestChange('cancel_subscription')}><XCircle className="mr-2 h-4 w-4" />Begär uppsägning</Button></div>}<textarea value={changeNote} onChange={(event) => setChangeNote(event.target.value)} maxLength={1000} placeholder="Valfri kommentar till Nordklart" className="mt-3 min-h-20 w-full rounded-lg border bg-card px-3 py-2 text-sm" /></div> : null}

      <div className="mt-6 grid gap-4 lg:grid-cols-3">{plans.map((plan) => {
        const isBase = plan.productType === 'subscription'; const isAddon = plan.productType === 'addon'; const isYearEnd = plan.productType === 'one_time' && plan.productCode === 'year_end'
        if (isBase && hasActiveBaseSubscription) return null
        const disabled = pending || !plan.stripeReady || (isAddon && !hasActiveBaseSubscription) || (isYearEnd && !yearEndPeriodId)
        const label = !plan.stripeReady ? 'Inte redo för betalning' : isAddon && !hasActiveBaseSubscription ? 'Kräver basabonnemang' : isYearEnd ? 'Köp bokslut' : isAddon ? 'Lägg till tjänst' : 'Välj plan'
        return <article key={plan.id} className="rounded-2xl border bg-background/70 p-5"><p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">{isYearEnd ? 'Engångsköp' : isAddon ? 'Tillägg' : 'Abonnemang'}</p><h3 className="mt-2 text-xl font-semibold">{plan.name}</h3><p className="mt-2 min-h-14 text-sm leading-6 text-muted-foreground">{plan.description || 'Produktinformation saknas.'}</p><div className="mt-5 text-lg font-semibold tabular-nums">{formatPrice(plan)}</div>{isYearEnd ? <label className="mt-4 block text-sm font-medium">Räkenskapsår<select className="mt-2 flex h-10 w-full rounded-lg border bg-card px-3 text-sm" value={yearEndPeriodId} onChange={(event) => setYearEndPeriodId(event.target.value)}>{fiscalPeriods.length === 0 ? <option value="">Inget räkenskapsår tillgängligt</option> : null}{fiscalPeriods.map((period) => <option key={period.id} value={period.id}>{period.name} · {period.periodStart}–{period.periodEnd}</option>)}</select></label> : null}<Button className="mt-5 w-full" disabled={disabled} onClick={() => openCheckout(plan.id, isYearEnd ? yearEndPeriodId : undefined)}>{pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CreditCard className="mr-2 h-4 w-4" />}{label}</Button></article>
      })}</div>
    </section>
  )
}
