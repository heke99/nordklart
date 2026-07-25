import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getActiveCompanyId } from '@/lib/company/context'
import { checkFeatureAccess, NORDKLART_FEATURES } from '@/lib/platform/entitlements'
import { BANKGIRO_APPLICATION_STEPS, bankgiroStatusLabel, providerSetupLabel } from '@/lib/bankgiro/provider-module'
import { NordklartActionCard, NordklartPageShell, NordklartStatCard } from '@/components/nordklart/NordklartShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { requestBankgiroApplicationAction } from './actions'

export const dynamic = 'force-dynamic'

type BankgiroPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}

type BankgiroApplication = {
  id: string
  status: string
  provider_setup_status: string | null
  documents_status: string | null
  risk_score: number | null
  expected_monthly_volume: number | null
  updated_at: string
  payment_providers?: { name: string | null } | { name: string | null }[] | null
}

type PaymentProvider = {
  id: string
  name: string | null
  code: string | null
  status: string | null
  capabilities: unknown
}

const ACTIVE_APPLICATION_STATUSES = new Set([
  'draft',
  'submitted',
  'needs_information',
  'under_review',
  'approved',
  'provider_setup',
  'active',
])

const NOTICE_COPY: Record<string, string> = {
  application_created: 'Ansökan är sparad och kan följas här. Nästa steg visas när betalpartnern behöver komplettering eller aktivering.',
}

const ERROR_COPY: Record<string, string> = {
  bankgiro_access_required: 'Bankgiro ingår inte i nuvarande plan eller tillägg. Aktivera Bankgiro innan ansökan skickas.',
  active_application_exists: 'Det finns redan en aktiv Bankgiroansökan för bolaget. Fortsätt med den befintliga ansökan i stället.',
  not_allowed: 'Du saknar behörighet att skapa Bankgiroansökan för det här bolaget.',
  application_failed: 'Ansökan kunde inte sparas just nu. Kontrollera uppgifterna och försök igen.',
  access_unavailable: 'Åtkomsten kunde inte verifieras just nu. Ingen planändring krävs. Försök igen om en stund.',
}

function providerName(provider: BankgiroApplication['payment_providers']) {
  if (Array.isArray(provider)) return provider[0]?.name ?? null
  return provider?.name ?? null
}

function queryValue(params: Record<string, string | string[] | undefined>, key: string) {
  const value = params[key]
  return Array.isArray(value) ? value[0] : value
}

export default async function BankgiroPage({ searchParams }: BankgiroPageProps) {
  const params = await searchParams
  const notice = params ? queryValue(params, 'notice') : undefined
  const error = params ? queryValue(params, 'error') : undefined

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const companyId = await getActiveCompanyId(supabase, user.id)
  if (!companyId) redirect('/onboarding?intent=bankgiro')

  const [applicationsRes, providersRes, mandatesRes, collectionsRes, reconciliationRes, featureAccess] = await Promise.all([
    supabase.from('bankgiro_applications').select('id,status,provider_setup_status,documents_status,risk_score,expected_monthly_volume,updated_at,payment_providers(name)').eq('company_id', companyId).order('updated_at', { ascending: false }).limit(5),
    supabase.from('payment_providers').select('id,name,code,status,capabilities').eq('status', 'active').order('name'),
    supabase.from('payment_mandates').select('*', { count: 'exact', head: true }).eq('company_id', companyId).in('status', ['active', 'pending']),
    supabase.from('payment_collections').select('*', { count: 'exact', head: true }).eq('company_id', companyId).in('status', ['pending', 'submitted', 'paid']),
    supabase.from('payment_reconciliation_items').select('*', { count: 'exact', head: true }).eq('company_id', companyId).in('status', ['unmatched', 'needs_review']),
    checkFeatureAccess(supabase, companyId, NORDKLART_FEATURES.bankgiroApplication),
  ])

  const applications = (applicationsRes.data ?? []) as BankgiroApplication[]
  const providers = (providersRes.data ?? []) as PaymentProvider[]
  const latest = applications[0]
  const hasActiveApplication = applications.some((application) => ACTIVE_APPLICATION_STATUSES.has(application.status))
  const featureResolutionFailed = featureAccess.reason === 'database_error'
  const canStartApplication = featureAccess.allowed && !hasActiveApplication && providers.length > 0

  return (
    <NordklartPageShell
      eyebrow="Bankgiro / Autogiro"
      title="Bankgiro och Autogiro som tillägg"
      description="Bankgiro och Autogiro har en separat ansökan och aktivering. Vanlig bokföring kan starta utan att Bankgiro behöver vara klart."
      actions={
        featureAccess.allowed ? (
          <Button asChild disabled={!providers.length || hasActiveApplication}>
            <Link href="#bankgiro-application-form">Påbörja ansökan</Link>
          </Button>
        ) : featureResolutionFailed ? null : (
          <Button asChild>
            <Link href="/settings/billing">Aktivera Bankgiro</Link>
          </Button>
        )
      }
    >
      {notice && NOTICE_COPY[notice] ? (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          {NOTICE_COPY[notice]}
        </div>
      ) : null}
      {error && ERROR_COPY[error] ? (
        <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {ERROR_COPY[error]}
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-4">
        <NordklartStatCard label="Ansökan" value={bankgiroStatusLabel(latest?.status)} description={providerName(latest?.payment_providers) ?? 'Ingen betalpartner vald'} tone={latest?.status === 'active' ? 'success' : 'warning'} />
        <NordklartStatCard label="Mandat" value={mandatesRes.count ?? 0} description="Aktiva eller väntande." />
        <NordklartStatCard label="Inbetalningar" value={collectionsRes.count ?? 0} description="Pågående betalningar." tone="primary" />
        <NordklartStatCard label="Avstämning" value={reconciliationRes.count ?? 0} description="Behöver matchas eller granskas." tone={(reconciliationRes.count ?? 0) > 0 ? 'warning' : 'success'} />
      </div>

      {!featureAccess.allowed && !featureResolutionFailed ? (
        <section className="rounded-3xl border border-amber-200 bg-amber-50 p-5 text-amber-950 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-wide">Tillägg krävs</p>
              <h2 className="mt-1 text-xl font-semibold">Bankgiro är inte aktiverat för bolaget</h2>
              <p className="mt-2 max-w-3xl text-sm text-amber-900">
                Ansökan blockeras tills rätt plan eller Bankgiro-tillägg är aktiverat. Det skyddar mot halvskapade ansökningar som betalpartnern inte kan behandla.
              </p>
            </div>
            <Button asChild variant="secondary"><Link href="/settings/billing">Hantera plan</Link></Button>
          </div>
        </section>
      ) : null}
      {featureResolutionFailed ? (
        <section className="rounded-3xl border border-destructive/30 bg-destructive/10 p-5 text-destructive shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-wide">Tekniskt fel</p>
          <h2 className="mt-1 text-xl font-semibold">Åtkomsten kunde inte verifieras</h2>
          <p className="mt-2 max-w-3xl text-sm">
            Ingen planändring krävs. Ladda om sidan om en stund. Ansökan är tillfälligt blockerad för att undvika en felaktig åtkomstbedömning.
          </p>
        </section>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <section className="rounded-3xl border bg-card p-5 shadow-sm">
          <h2 className="text-xl font-semibold">Ansökningar</h2>
          <div className="mt-4 space-y-3">
            {applications.map((application) => (
              <div key={application.id} className="rounded-2xl border bg-background/70 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="font-medium">{bankgiroStatusLabel(application.status)}</div>
                  <Badge variant={application.status === 'active' ? 'success' : application.status === 'rejected' ? 'destructive' : 'secondary'}>{providerSetupLabel(application.provider_setup_status)}</Badge>
                </div>
                <div className="mt-2 text-sm text-muted-foreground">Underlag: {application.documents_status ?? 'ej startat'} · Risknivå: {application.risk_score ?? 'saknas'} · Förväntad månadsvolym: {application.expected_monthly_volume ?? 'saknas'}</div>
              </div>
            ))}
            {applications.length === 0 ? <p className="text-sm text-muted-foreground">Ingen ansökan ännu. Starta bara om bolaget faktiskt behöver Bankgiro/Autogiro.</p> : null}
          </div>
        </section>

        <section className="rounded-3xl border bg-card p-5 shadow-sm">
          <h2 className="text-xl font-semibold">Ansökningsflöde</h2>
          <ol className="mt-4 space-y-3">
            {BANKGIRO_APPLICATION_STEPS.map((step, index) => (
              <li key={step} className="flex items-center gap-3 rounded-2xl border bg-background/70 p-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">{index + 1}</span>
                <span className="font-semibold">{step}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>

      {featureAccess.allowed ? (
        <section id="bankgiro-application-form" className="rounded-3xl border bg-card p-5 shadow-sm scroll-mt-24">
          <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
            <div>
              <h2 className="text-xl font-semibold">Ny Bankgiroansökan</h2>
              <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                Fyll i grunduppgifterna här. Ansökan sparas i Nordklart och skickas vidare enligt betalpartnerns krav när den är redo.
              </p>
            </div>
            {hasActiveApplication ? <Badge variant="secondary">Aktiv ansökan finns</Badge> : null}
          </div>

          {!providers.length ? (
            <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
              Ingen aktiv betalpartner är konfigurerad ännu. Aktivera en betalpartner innan ansökan skapas.
            </div>
          ) : null}

          <form action={requestBankgiroApplicationAction} className="mt-5 grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="provider_id">Betalpartner</Label>
              <select
                id="provider_id"
                name="provider_id"
                required
                disabled={!canStartApplication}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="">Välj betalpartner</option>
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>{provider.name ?? provider.code ?? 'Betalpartner'}</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="expected_monthly_volume">Förväntad månadsvolym</Label>
              <Input id="expected_monthly_volume" name="expected_monthly_volume" inputMode="numeric" placeholder="Ex. 250000" disabled={!canStartApplication} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="beneficial_owner_name">Verklig huvudman / ansvarig</Label>
              <Input id="beneficial_owner_name" name="beneficial_owner_name" placeholder="Namn" disabled={!canStartApplication} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="beneficial_owner_role">Roll</Label>
              <Input id="beneficial_owner_role" name="beneficial_owner_role" placeholder="Ex. ägare, firmatecknare" disabled={!canStartApplication} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="customer_type">Kundtyp</Label>
              <Input id="customer_type" name="customer_type" placeholder="Ex. företag, förening, byråkund" disabled={!canStartApplication} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="company_activity">Verksamhet</Label>
              <Input id="company_activity" name="company_activity" placeholder="Kort beskrivning av verksamheten" disabled={!canStartApplication} />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="use_case">Hur ska Bankgiro/Autogiro användas?</Label>
              <Textarea id="use_case" name="use_case" placeholder="Ex. kundinbetalningar, återkommande autogiro, leverantörsbetalningar" disabled={!canStartApplication} />
            </div>
            <div className="flex flex-wrap gap-3 md:col-span-2">
              <Button type="submit" name="status" value="draft" variant="secondary" disabled={!canStartApplication}>Spara utkast</Button>
              <Button type="submit" name="status" value="submitted" disabled={!canStartApplication}>Skicka in ansökan</Button>
              {hasActiveApplication ? <p className="text-sm text-muted-foreground">Fortsätt med den befintliga ansökan i listan ovan innan du skapar en ny.</p> : null}
            </div>
          </form>
        </section>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <NordklartActionCard meta="Betalpartner" title="Betalpartner och filimport" description={`${providers.length} betalvägar är förberedda för Bankgiro, Autogiro eller filbaserad hantering.`}>
          <Button asChild size="sm" variant="secondary"><Link href="/settings/billing">Hantera plan</Link></Button>
        </NordklartActionCard>
        <NordklartActionCard meta="Avstämning" title="Matcha betalningar mot fakturor" description="Betalningar kan granskas och matchas innan bokföring skapas.">
          <Button asChild size="sm" variant="secondary"><Link href="/transactions">Visa transaktioner</Link></Button>
        </NordklartActionCard>
        <NordklartActionCard meta="Tydlig gräns" title="Bankgiro är ett separat tillägg" description="Bokföring och bankautomation kan användas även om Bankgiro-ansökan inte är klar." />
      </div>
    </NordklartPageShell>
  )
}
