import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getActiveCompanyId } from '@/lib/company/context'
import { BANKGIRO_APPLICATION_STEPS, bankgiroStatusLabel, providerSetupLabel } from '@/lib/bankgiro/provider-module'
import { NordklartActionCard, NordklartPageShell, NordklartStatCard } from '@/components/nordklart/NordklartShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

export const dynamic = 'force-dynamic'

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

function providerName(provider: BankgiroApplication['payment_providers']) {
  if (Array.isArray(provider)) return provider[0]?.name ?? null
  return provider?.name ?? null
}

export default async function BankgiroPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const companyId = await getActiveCompanyId(supabase, user.id)
  if (!companyId) redirect('/onboarding?intent=bankgiro')

  const [applicationsRes, providersRes, mandatesRes, collectionsRes, reconciliationRes] = await Promise.all([
    supabase.from('bankgiro_applications').select('id,status,provider_setup_status,documents_status,risk_score,expected_monthly_volume,updated_at,payment_providers(name)').eq('company_id', companyId).order('updated_at', { ascending: false }).limit(5),
    supabase.from('payment_providers').select('id,name,code,status,capabilities').eq('status', 'active').order('name'),
    supabase.from('payment_mandates').select('*', { count: 'exact', head: true }).eq('company_id', companyId).in('status', ['active', 'pending']),
    supabase.from('payment_collections').select('*', { count: 'exact', head: true }).eq('company_id', companyId).in('status', ['pending', 'submitted', 'paid']),
    supabase.from('payment_reconciliation_items').select('*', { count: 'exact', head: true }).eq('company_id', companyId).in('status', ['unmatched', 'needs_review']),
  ])

  const applications = (applicationsRes.data ?? []) as BankgiroApplication[]
  const latest = applications[0]

  return (
    <NordklartPageShell
      eyebrow="Bankgiro / Autogiro"
      title="Betalprovider som tillägg — inte krav för bokföring"
      description="Bankgiro/Autogiro har egen onboarding, review och providerstatus. Vanlig bokföring ska kunna starta utan Bankgiro-friktion."
      actions={<Button asChild><Link href="/onboarding?flow=bankgiro_autogiro">Påbörja ansökan</Link></Button>}
    >
      <div className="grid gap-4 md:grid-cols-4">
        <NordklartStatCard label="Ansökan" value={bankgiroStatusLabel(latest?.status)} description={providerName(latest?.payment_providers) ?? 'Ingen provider vald'} tone={latest?.status === 'active' ? 'success' : 'warning'} />
        <NordklartStatCard label="Mandat" value={mandatesRes.count ?? 0} description="Aktiva eller pending." />
        <NordklartStatCard label="Collections" value={collectionsRes.count ?? 0} description="Pågående inbetalningsflöden." tone="primary" />
        <NordklartStatCard label="Avstämning" value={reconciliationRes.count ?? 0} description="Unmatched/needs review." tone={(reconciliationRes.count ?? 0) > 0 ? 'warning' : 'success'} />
      </div>

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
                <div className="mt-2 text-sm text-muted-foreground">Dokument: {application.documents_status ?? 'not_started'} · Risk: {application.risk_score ?? 'saknas'} · Volym: {application.expected_monthly_volume ?? 'saknas'}</div>
              </div>
            ))}
            {applications.length === 0 ? <p className="text-sm text-muted-foreground">Ingen ansökan ännu. Starta bara om bolaget faktiskt behöver Bankgiro/Autogiro.</p> : null}
          </div>
        </section>

        <section className="rounded-3xl border bg-card p-5 shadow-sm">
          <h2 className="text-xl font-semibold">Providerflöde</h2>
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

      <div className="grid gap-4 lg:grid-cols-3">
        <NordklartActionCard meta="Providers" title="GoCardless, Leslie och filimport" description={`${providersRes.data?.length ?? 0} provider-adaptrar är definierade utan att hårdkoda bokföringskärnan.`}>
          <Button asChild size="sm" variant="secondary"><Link href="/platform/bankgiro">Platformvy</Link></Button>
        </NordklartActionCard>
        <NordklartActionCard meta="Avstämning" title="Matcha betalningar mot fakturor" description="payment_reconciliation_items gör betalflödet granskningsbart innan bokföring skapas.">
          <Button asChild size="sm" variant="secondary"><Link href="/transactions">Visa transaktioner</Link></Button>
        </NordklartActionCard>
        <NordklartActionCard meta="Säker gräns" title="Bankgiro är separat onboarding" description="Bokföring direkt och bankautomation ska kunna användas utan att Bankgiro-ansökan krävs." />
      </div>
    </NordklartPageShell>
  )
}
