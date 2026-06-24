import Link from 'next/link'
import { notFound } from 'next/navigation'
import { AlertTriangle, ArrowLeft, Banknote, BookOpenCheck, Building2, CreditCard, UsersRound } from 'lucide-react'
import { requirePlatformAdmin } from '@/lib/auth/platform'
import { NordklartPageShell, NordklartStatCard } from '@/components/nordklart/NordklartShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { accessStatusLabel, bankgiroStatusLabel, companyKindLabel, entityTypeLabel } from '@/lib/platform/company-overview'
import { getPlatformCompanyDetail, type PlatformPlanVersionOption } from '@/lib/platform/company-detail'
import {
  addSubscriptionItemFromCardAction,
  grantCompanyAccessFromCardAction,
  revokeCompanyAccessFromCardAction,
  setCompanySubscriptionFromCardAction,
} from './actions'

export const dynamic = 'force-dynamic'

type SearchParams = { notice?: string; error?: string }

const dateTime = (value: unknown) => typeof value === 'string' && value
  ? new Intl.DateTimeFormat('sv-SE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  : '–'
const money = (value: unknown, currency = 'SEK') => typeof value === 'number'
  ? `${value.toLocaleString('sv-SE', { maximumFractionDigits: 0 })} ${currency}`
  : '–'
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value : '–'

function productType(option: PlatformPlanVersionOption) {
  return option.plan?.product?.product_type ?? 'subscription'
}

function planName(option: PlatformPlanVersionOption) {
  return `${option.plan?.name ?? 'Plan'} · v${option.version_number} · ${money(option.price_excl_vat, option.currency)} / ${option.billing_interval}`
}

function sourceTypeLabel(value: unknown) {
  switch (value) {
    case 'supplier_invoice': return 'Leverantörsfaktura/utlägg'
    case 'invoice_inbox_item': return 'Inkorgsunderlag'
    case 'document': return 'Dokument'
    default: return text(value)
  }
}

export default async function PlatformCompanyDetailPage({ params, searchParams }: { params: Promise<{ companyId: string }>; searchParams: Promise<SearchParams> }) {
  await requirePlatformAdmin()
  const [{ companyId }, query] = await Promise.all([params, searchParams])
  const detail = await getPlatformCompanyDetail(companyId)
  if (!detail) notFound()

  const { company, commercial, operational } = detail
  const accountingIssues = (operational?.unlinked_document_count || 0) + (operational?.pending_inbox_count || 0) + (operational?.unbooked_transaction_count || 0)
  const basePlans = detail.planVersions.filter((plan) => productType(plan) === 'subscription')
  const addonPlans = detail.planVersions.filter((plan) => productType(plan) === 'addon')
  const activeSubscriptionId = commercial?.subscription_id ?? (detail.subscriptions[0]?.id as string | undefined)

  return (
    <NordklartPageShell
      eyebrow="Superadmin · bolagskort"
      title={company.name}
      description="Granska bolagets användare, byråkoppling, åtkomst, abonnemang, bokslut, Bankgiro och bokföringskontroller. Alla ändringar sker via kontrollerade server actions och audit-loggas."
      actions={<Button asChild variant="secondary"><Link href="/platform/companies"><ArrowLeft className="mr-2 h-4 w-4" />Alla bolag</Link></Button>}
    >
      {query.notice ? <div className="rounded-2xl border border-success/30 bg-success/10 px-5 py-4 text-sm text-success">{query.notice}</div> : null}
      {query.error ? <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-5 py-4 text-sm text-destructive">{query.error}</div> : null}

      <div className="grid gap-4 md:grid-cols-5">
        <NordklartStatCard label="Typ" value={companyKindLabel(company.workspace_kind)} description={entityTypeLabel(company.entity_type)} />
        <NordklartStatCard label="Användare" value={company.active_member_count} description={`${company.member_count} totalt`} />
        <NordklartStatCard label="Åtkomst" value={accessStatusLabel(commercial?.access_status)} description={commercial?.plan_name || 'Ingen aktiv plan'} tone={commercial?.access_status === 'active' ? 'success' : 'warning'} />
        <NordklartStatCard label="Bankgiro" value={bankgiroStatusLabel(operational?.bankgiro_status)} description={operational?.bankgiro_provider_setup_status || 'Status'} tone={operational?.bankgiro_status === 'active' ? 'success' : 'default'} />
        <NordklartStatCard label="Kontrollpunkter" value={accountingIssues} description="Bokföring/underlag" tone={accountingIssues > 0 ? 'warning' : 'success'} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
        <section className="rounded-3xl border bg-card p-6 shadow-sm">
          <div className="flex items-start gap-3"><Building2 className="mt-1 h-5 w-5 text-primary" /><div><h2 className="text-xl font-semibold">Bolagsinformation</h2><p className="mt-1 text-sm text-muted-foreground">Grunddata och kopplingar.</p></div></div>
          <dl className="mt-5 grid gap-3 text-sm md:grid-cols-2">
            <Info label="Org.nr" value={company.org_number} />
            <Info label="Bolagsform" value={entityTypeLabel(company.entity_type)} />
            <Info label="Workspace" value={companyKindLabel(company.workspace_kind)} />
            <Info label="Byrå" value={company.agency_name || company.client_agency_name} />
            <Info label="Skapad" value={dateTime(company.created_at)} />
            <Info label="Senast ändrad" value={dateTime(company.updated_at)} />
          </dl>
        </section>

        <section className="rounded-3xl border bg-card p-6 shadow-sm">
          <div className="flex items-start gap-3"><UsersRound className="mt-1 h-5 w-5 text-primary" /><div><h2 className="text-xl font-semibold">Användare</h2><p className="mt-1 text-sm text-muted-foreground">Roller, status och åtkomstkälla.</p></div></div>
          <div className="mt-5 space-y-3">
            {detail.users.map((user) => (
              <div key={user.membership_id} className="rounded-2xl border bg-background/60 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{user.full_name || user.email || user.user_id}</span>
                  <Badge variant="secondary">{user.role}</Badge>
                  <Badge variant={user.status === 'active' ? 'success' : 'warning'}>{user.status}</Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{user.email || user.user_id} · {user.access_source} · {dateTime(user.joined_at)}</p>
              </div>
            ))}
            {detail.users.length === 0 ? <p className="text-sm text-muted-foreground">Inga användare hittades på bolaget.</p> : null}
          </div>
        </section>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
        <section className="rounded-3xl border bg-card p-6 shadow-sm">
          <div className="flex items-start gap-3"><CreditCard className="mt-1 h-5 w-5 text-primary" /><div><h2 className="text-xl font-semibold">Abonnemang och åtkomst</h2><p className="mt-1 text-sm text-muted-foreground">Ändra plan, lägg till tillägg och hantera särskild åtkomst.</p></div></div>
          <div className="mt-5 rounded-2xl border bg-background/60 p-4 text-sm">
            <div className="flex flex-wrap items-center gap-2"><Badge variant={commercial?.access_status === 'active' ? 'success' : 'warning'}>{accessStatusLabel(commercial?.access_status)}</Badge><span>{commercial?.plan_name || 'Ingen aktiv plan'}</span></div>
            <p className="mt-2 text-muted-foreground">Förnyas/slutar: {dateTime(commercial?.current_period_end)} · Källa: {commercial?.access_source || 'saknas'}</p>
          </div>

          <form action={setCompanySubscriptionFromCardAction} className="mt-5 grid gap-3 rounded-2xl border p-4">
            <input type="hidden" name="company_id" value={company.id} />
            <h3 className="font-semibold">Byt eller sätt basplan</h3>
            <select required name="plan_version_id" className="h-10 rounded-lg border bg-background px-3 text-sm" defaultValue={commercial?.plan_version_id || ''}>
              <option value="" disabled>Välj plan</option>
              {basePlans.map((plan) => <option key={plan.id} value={plan.id}>{planName(plan)}</option>)}
            </select>
            <div className="grid gap-3 md:grid-cols-2">
              <select name="status" defaultValue="active" className="h-10 rounded-lg border bg-background px-3 text-sm"><option value="active">Aktiv</option><option value="trialing">Provperiod</option><option value="paused">Pausad</option><option value="cancelled">Avslutad</option></select>
              <input name="current_period_end" type="datetime-local" className="h-10 rounded-lg border bg-background px-3 text-sm" />
            </div>
            <input name="note" placeholder="Intern anteckning" className="h-10 rounded-lg border bg-background px-3 text-sm" />
            <Button type="submit" size="sm">Spara abonnemang</Button>
          </form>

          <form action={addSubscriptionItemFromCardAction} className="mt-5 grid gap-3 rounded-2xl border p-4">
            <input type="hidden" name="company_id" value={company.id} />
            <input type="hidden" name="subscription_id" value={activeSubscriptionId || ''} />
            <h3 className="font-semibold">Lägg till tillägg/quantity</h3>
            <select required name="plan_version_id" className="h-10 rounded-lg border bg-background px-3 text-sm" disabled={!activeSubscriptionId || addonPlans.length === 0}>
              <option value="">Välj tillägg</option>
              {addonPlans.map((plan) => <option key={plan.id} value={plan.id}>{planName(plan)}</option>)}
            </select>
            <div className="grid gap-3 md:grid-cols-2"><input name="quantity" type="number" min="1" step="1" defaultValue="1" className="h-10 rounded-lg border bg-background px-3 text-sm" /><input name="current_period_end" type="datetime-local" className="h-10 rounded-lg border bg-background px-3 text-sm" /></div>
            <input name="note" placeholder="Intern anteckning" className="h-10 rounded-lg border bg-background px-3 text-sm" />
            <Button type="submit" size="sm" disabled={!activeSubscriptionId || addonPlans.length === 0}>Lägg till</Button>
          </form>
        </section>

        <section className="rounded-3xl border bg-card p-6 shadow-sm">
          <div className="flex items-start gap-3"><Banknote className="mt-1 h-5 w-5 text-primary" /><div><h2 className="text-xl font-semibold">Särskild åtkomst och köp</h2><p className="mt-1 text-sm text-muted-foreground">Tillfällig eller kostnadsfri åtkomst ska alltid ha intern anteckning.</p></div></div>
          <form action={grantCompanyAccessFromCardAction} className="mt-5 grid gap-3 rounded-2xl border p-4">
            <input type="hidden" name="company_id" value={company.id} />
            <h3 className="font-semibold">Bevilja åtkomst</h3>
            <select name="grant_type" defaultValue="complimentary_full_access" className="h-10 rounded-lg border bg-background px-3 text-sm"><option value="complimentary_full_access">Kostnadsfri full åtkomst</option><option value="complimentary_bankgiro">Kostnadsfri Bankgiro-åtkomst</option></select>
            <div className="grid gap-3 md:grid-cols-2"><input name="starts_at" type="datetime-local" className="h-10 rounded-lg border bg-background px-3 text-sm" /><input name="expires_at" type="datetime-local" className="h-10 rounded-lg border bg-background px-3 text-sm" /></div>
            <input required name="note" placeholder="Orsak / intern anteckning" className="h-10 rounded-lg border bg-background px-3 text-sm" />
            <Button type="submit" size="sm">Bevilja åtkomst</Button>
          </form>
          <div className="mt-5 space-y-3">
            {detail.grants.map((grant) => (
              <div key={String(grant.id)} className="rounded-2xl border bg-background/60 p-4 text-sm">
                <div className="flex flex-wrap items-center gap-2"><Badge variant={grant.status === 'active' ? 'success' : 'secondary'}>{text(grant.status)}</Badge><span>{text(grant.grant_type)}</span></div>
                <p className="mt-1 text-muted-foreground">{text(grant.note)} · {dateTime(grant.created_at)} → {dateTime(grant.expires_at)}</p>
                {grant.status === 'active' || grant.status === 'scheduled' ? (
                  <form action={revokeCompanyAccessFromCardAction} className="mt-3 flex flex-wrap gap-2">
                    <input type="hidden" name="company_id" value={company.id} />
                    <input type="hidden" name="grant_id" value={String(grant.id)} />
                    <input required name="reason" placeholder="Orsak" className="h-9 rounded-lg border bg-card px-3 text-sm" />
                    <Button type="submit" size="sm" variant="outline">Återkalla</Button>
                  </form>
                ) : null}
              </div>
            ))}
            {detail.grants.length === 0 ? <p className="text-sm text-muted-foreground">Ingen särskild åtkomst finns.</p> : null}
          </div>
        </section>
      </div>

      <section className="rounded-3xl border bg-card p-6 shadow-sm">
        <div className="flex items-start gap-3"><BookOpenCheck className="mt-1 h-5 w-5 text-primary" /><div><h2 className="text-xl font-semibold">Bokföringskontroll</h2><p className="mt-1 text-sm text-muted-foreground">Kontrollerar att underlag, kvitto, utlägg, leverantörsfaktura, verifikation och bankhändelse hänger ihop.</p></div></div>
        <div className="mt-5 grid gap-4 md:grid-cols-4">
          <NordklartStatCard label="O-länkade underlag" value={operational?.unlinked_document_count || 0} description="Dokument utan verifikation" tone={(operational?.unlinked_document_count || 0) > 0 ? 'warning' : 'success'} />
          <NordklartStatCard label="Inkorg" value={operational?.pending_inbox_count || 0} description="Väntar/tolkade/fel" tone={(operational?.pending_inbox_count || 0) > 0 ? 'warning' : 'success'} />
          <NordklartStatCard label="Bankhändelser" value={operational?.unbooked_transaction_count || 0} description="Saknar verifikation" tone={(operational?.unbooked_transaction_count || 0) > 0 ? 'warning' : 'success'} />
          <NordklartStatCard label="Verifikationer" value={operational?.journal_entry_count || 0} description={`Senast ${dateTime(operational?.last_journal_entry_at)}`} />
        </div>
        <div className="mt-5 space-y-3">
          {detail.integrityIssues.map((issue) => (
            <div key={`${String(issue.source_type)}-${String(issue.source_id)}`} className="rounded-2xl border bg-background/60 p-4">
              <div className="flex flex-wrap items-center gap-2"><AlertTriangle className="h-4 w-4 text-warning" /><Badge variant={issue.lifecycle_status === 'requires_repair' ? 'warning' : 'secondary'}>{text(issue.lifecycle_status)}</Badge><span className="font-medium">{sourceTypeLabel(issue.source_type)}</span><span className="text-sm text-muted-foreground">{text(issue.source_label)}</span></div>
              <p className="mt-2 text-sm text-muted-foreground">{text(issue.issue_message)}</p>
            </div>
          ))}
          {detail.integrityIssues.length === 0 ? <div className="rounded-2xl border border-success/30 bg-success/10 p-4 text-sm text-success">Inga bokföringskontrollpunkter hittades.</div> : null}
        </div>
      </section>
    </NordklartPageShell>
  )
}

function Info({ label, value }: { label: string; value: unknown }) {
  return <div><dt className="text-muted-foreground">{label}</dt><dd className="mt-1 font-medium">{text(value)}</dd></div>
}
