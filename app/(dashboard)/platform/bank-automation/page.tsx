import Link from 'next/link'
import { createServiceClient } from '@/lib/supabase/server'
import { requirePlatformRole } from '@/lib/auth/platform'
import { NordklartActionCard, NordklartPageShell, NordklartStatCard } from '@/components/nordklart/NordklartShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

export const dynamic = 'force-dynamic'

type ProviderRow = {
  id: string
  code: string
  name: string
  provider_type: string
  status: string
  supports_balance: boolean
  supports_transactions: boolean
  supports_consent_refresh: boolean
}

export default async function PlatformBankAutomationPage() {
  // All platform roles may inspect these cross-tenant stats. The service
  // client is required: RLS-scoped reads silently return zeros for
  // platform_support / platform_auditor (only platform_admin bypasses RLS).
  await requirePlatformRole()
  const supabase = createServiceClient()

  const [
    { data: providers },
    { count: connections },
    { count: bankAccounts },
    { count: rules },
    { count: decisions },
    { count: reviewItems },
    { count: autoBooked },
    { count: suggested },
  ] = await Promise.all([
    supabase.from('bank_data_providers').select('id, code, name, provider_type, status, supports_balance, supports_transactions, supports_consent_refresh').order('name', { ascending: true }),
    supabase.from('bank_connections').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('bank_accounts').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('bookkeeping_automation_rules').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('automation_decisions').select('*', { count: 'exact', head: true }),
    supabase.from('review_queue_items').select('*', { count: 'exact', head: true }).in('status', ['open', 'in_review']),
    supabase.from('automation_decisions').select('*', { count: 'exact', head: true }).eq('decision', 'auto_book'),
    supabase.from('automation_decisions').select('*', { count: 'exact', head: true }).eq('decision', 'suggest'),
  ])

  return (
    <NordklartPageShell
      eyebrow="Bankautomation"
      title="Provider-oberoende bankautomation"
      description="Bankdata, Bankgiro och vanlig bokföring hålls separerade. Transaktioner importeras via provider-modell, dedupe, matchning, confidence och granskningskö."
      actions={<Button asChild variant="secondary"><Link href="/bank-automation">Bolagets bankautomation</Link></Button>}
    >
      <div className="grid gap-4 md:grid-cols-4">
        <NordklartStatCard label="Providers" value={providers?.length ?? 0} description="GoCardless, filimport, manuell upload och framtida providers." tone="primary" />
        <NordklartStatCard label="Bankkopplingar" value={connections ?? 0} description="Aktiva consent/kopplingar." />
        <NordklartStatCard label="Bankkonton" value={bankAccounts ?? 0} description="Normaliserade konton." />
        <NordklartStatCard label="Granska" value={reviewItems ?? 0} description="Öppna/in review." tone="warning" />
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <NordklartStatCard label="Regler" value={rules ?? 0} description="Aktiva automationsregler." />
        <NordklartStatCard label="Beslut" value={decisions ?? 0} description="Alla automation decisions." />
        <NordklartStatCard label="Autobokför" value={autoBooked ?? 0} description=">=95% + godkänd regel." tone="success" />
        <NordklartStatCard label="Förslag" value={suggested ?? 0} description="70–94% confidence." tone="primary" />
      </div>

      <div className="grid gap-4 lg:grid-cols-4">
        {((providers ?? []) as ProviderRow[]).map((provider) => (
          <div key={provider.id} className="rounded-3xl border bg-card p-5 shadow-sm">
            <Badge variant={provider.status === 'active' ? 'success' : 'secondary'}>{provider.status}</Badge>
            <h2 className="mt-4 text-lg font-semibold">{provider.name}</h2>
            <p className="mt-2 font-mono text-xs text-muted-foreground">{provider.code}</p>
            <div className="mt-4 space-y-2 text-sm text-muted-foreground">
              <div>Typ: {provider.provider_type}</div>
              <div>Transaktioner: {provider.supports_transactions ? 'Ja' : 'Nej'}</div>
              <div>Saldo: {provider.supports_balance ? 'Ja' : 'Nej'}</div>
              <div>Consent-refresh: {provider.supports_consent_refresh ? 'Ja' : 'Nej'}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <NordklartActionCard meta="Confidence" title="95/70-regeln är kodad" description=">=95% blir autobokföring först när regeln tillåter det. 70–94% blir förslag. Under 70% hamnar i granskningskö." />
        <NordklartActionCard meta="Audit" title="Varje beslut sparas" description="automation_decisions sparar confidence, risknivå, reason codes, föreslaget verifikat och review-status." />
        <NordklartActionCard meta="Dedupe" title="Provider transaction id är unikt per bolag" description="transactions har unique index på company_id + provider_transaction_id för att skydda mot dubbelimport." />
      </div>
    </NordklartPageShell>
  )
}
