import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getActiveCompanyId } from '@/lib/company/context'
import { NordklartPageShell, NordklartStatCard } from '@/components/nordklart/NordklartShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatDate } from '@/lib/utils'
import { getPeppolReadiness } from '@/lib/peppol/provider'
import { getFinancingReadiness } from '@/lib/invoice-financing/provider'
import { TAX_SUBMISSION_STATUS_SV } from '@/lib/skatteverket/submission-pipeline'

export const dynamic = 'force-dynamic'

interface RecommendedAction {
  label: string
  href: string
  tone: 'warning' | 'default'
}

/**
 * /automation — the Automation Center.
 *
 * One page that answers "what is the system doing for me, and what does it
 * need from me?": bank sync state, review queue, Skatteverket periods,
 * integration readiness and failed jobs, with concrete recommended actions.
 */
export default async function AutomationCenterPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const companyId = await getActiveCompanyId(supabase, user.id)
  if (!companyId) redirect('/onboarding')

  const [
    { data: bankConnections },
    { data: latestSync },
    { count: needsReview },
    { count: suggested },
    { count: autoBooked },
    { count: unbooked },
    { data: taxSubmissions },
    { data: skv },
    { data: bankgiro },
    { count: activeConsents },
    { count: activeWebhooks },
    { count: failedWebhookDeliveries },
    { count: failedOperations },
    { count: pendingInbox },
  ] = await Promise.all([
    supabase.from('bank_connections').select('id, bank_name, status, consent_status, sync_status, last_synced_at, consent_expires').eq('company_id', companyId),
    supabase.from('bank_sync_runs').select('started_at, status, trigger_source, transactions_imported').eq('company_id', companyId).order('started_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('transactions').select('*', { count: 'exact', head: true }).eq('company_id', companyId).eq('automation_status', 'needs_review'),
    supabase.from('transactions').select('*', { count: 'exact', head: true }).eq('company_id', companyId).eq('automation_status', 'suggested'),
    supabase.from('transactions').select('*', { count: 'exact', head: true }).eq('company_id', companyId).eq('automation_status', 'auto_booked'),
    // "Unbooked" mirrors lib/worklist countUnbookedTransactions: no
    // categorisation decision yet (is_business null) and not ignored.
    supabase.from('transactions').select('*', { count: 'exact', head: true }).eq('company_id', companyId).is('is_business', null).eq('is_ignored', false),
    supabase.from('tax_submissions').select('submission_type, period_key, status, updated_at').eq('company_id', companyId).order('updated_at', { ascending: false }).limit(5),
    supabase.from('skatteverket_company_settings').select('connection_status').eq('company_id', companyId).maybeSingle(),
    supabase.from('bankgiro_applications').select('status').eq('company_id', companyId).order('updated_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('signed_consents').select('*', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'active'),
    supabase.from('webhooks').select('*', { count: 'exact', head: true }).eq('company_id', companyId).eq('active', true),
    supabase.from('webhook_deliveries').select('*', { count: 'exact', head: true }).eq('company_id', companyId).in('status', ['failed', 'dead']),
    supabase.from('operations').select('*', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'failed'),
    supabase.from('invoice_inbox_items').select('*', { count: 'exact', head: true }).eq('company_id', companyId).in('status', ['pending', 'processing', 'ready', 'error']),
  ])

  const activeBank = (bankConnections ?? []).filter((c) => c.status === 'active')
  const expiredBank = (bankConnections ?? []).filter(
    (c) => c.status === 'expired' || c.consent_status === 'expired' || c.consent_status === 'consent_required',
  )
  const skvConnected = (skv as { connection_status?: string } | null)?.connection_status === 'connected'

  // ── Recommended actions (ordered by importance) ─────────────────────────
  const actions: RecommendedAction[] = []
  if (expiredBank.length > 0) {
    actions.push({ label: `Förnya bankmedgivandet (${expiredBank.length} koppling${expiredBank.length === 1 ? '' : 'ar'} har gått ut)`, href: '/settings/banking', tone: 'warning' })
  }
  if ((needsReview ?? 0) > 0) {
    actions.push({ label: `Granska ${needsReview} transaktion${needsReview === 1 ? '' : 'er'} som automatiken inte kunde boka säkert`, href: '/bank-automation', tone: 'warning' })
  }
  if ((suggested ?? 0) > 0) {
    actions.push({ label: `Bekräfta ${suggested} bokföringsförslag`, href: '/transactions', tone: 'default' })
  }
  if ((pendingInbox ?? 0) > 0) {
    actions.push({ label: `Hantera ${pendingInbox} dokument i inkorgen`, href: '/inbox', tone: 'default' })
  }
  if ((failedOperations ?? 0) > 0) {
    actions.push({ label: `${failedOperations} bakgrundsjobb misslyckades — kontrollera och kör om`, href: '/settings/api', tone: 'warning' })
  }
  if ((failedWebhookDeliveries ?? 0) > 0) {
    actions.push({ label: `${failedWebhookDeliveries} webhook-leveranser misslyckades`, href: '/settings/webhooks', tone: 'warning' })
  }
  if (activeBank.length === 0 && (bankConnections ?? []).length === 0) {
    actions.push({ label: 'Koppla banken (eller importera en bankfil) för automatisk bokföring', href: '/settings/banking', tone: 'default' })
  }
  if (!skvConnected) {
    actions.push({ label: 'Anslut Skatteverket för att förbereda deklarationer direkt från bokföringen', href: '/skatteverket', tone: 'default' })
  }

  return (
    <NordklartPageShell
      eyebrow="Automationscenter"
      title="Vad systemet gör åt dig — och vad det behöver"
      description="Banksynk, automatisk bokföring, deklarationsstatus och integrationer på ett ställe, med konkreta rekommenderade åtgärder."
      actions={<Button asChild variant="secondary"><Link href="/bank-automation">Bankautomation</Link></Button>}
    >
      <div className="grid gap-4 md:grid-cols-4">
        <NordklartStatCard label="Automatbokfört" value={autoBooked ?? 0} description="Transaktioner bokförda av automatiken." tone="success" />
        <NordklartStatCard label="Att granska" value={(needsReview ?? 0) + (suggested ?? 0)} description="Förslag och osäkra händelser." tone={((needsReview ?? 0) + (suggested ?? 0)) > 0 ? 'warning' : 'success'} />
        <NordklartStatCard label="Obokat" value={unbooked ?? 0} description="Transaktioner som väntar på bokföring." />
        <NordklartStatCard label="Misslyckade jobb" value={(failedOperations ?? 0) + (failedWebhookDeliveries ?? 0)} description="Operationer + webhook-leveranser." tone={((failedOperations ?? 0) + (failedWebhookDeliveries ?? 0)) > 0 ? 'warning' : 'success'} />
      </div>

      {/* Recommended actions */}
      <div className="rounded-3xl border bg-card p-5 shadow-sm">
        <h2 className="text-xl font-semibold">Rekommenderade åtgärder</h2>
        {actions.length > 0 ? (
          <ul className="mt-4 space-y-2">
            {actions.map((action) => (
              <li key={action.label}>
                <Link
                  href={action.href}
                  className="flex items-center justify-between gap-3 rounded-2xl border bg-background/70 p-4 transition-colors hover:bg-accent/50"
                >
                  <span className="text-sm">{action.label}</span>
                  <Badge variant={action.tone === 'warning' ? 'warning' : 'secondary'}>
                    {action.tone === 'warning' ? 'Åtgärd' : 'Förslag'}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">Allt är i fas — inga åtgärder behövs just nu.</p>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Bank */}
        <div className="rounded-3xl border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Bank</h2>
            <Link href="/settings/banking" className="text-sm text-primary underline-offset-4 hover:underline">Hantera</Link>
          </div>
          <div className="mt-3 space-y-1 text-sm text-muted-foreground">
            <p>{activeBank.length > 0 ? `${activeBank.length} aktiv koppling` : 'Ingen aktiv bankkoppling'}</p>
            {latestSync ? (
              <p>
                Senaste synk: {formatDate((latestSync as { started_at: string }).started_at)} — {(latestSync as { status: string }).status}
                {typeof (latestSync as { transactions_imported?: number }).transactions_imported === 'number'
                  ? `, ${(latestSync as { transactions_imported: number }).transactions_imported} transaktioner`
                  : ''}
              </p>
            ) : (
              <p>Ingen synk har körts ännu.</p>
            )}
            {expiredBank.length > 0 ? <p className="text-amber-600 dark:text-amber-500">{expiredBank.length} koppling(ar) behöver förnyat medgivande.</p> : null}
          </div>
        </div>

        {/* Skatteverket */}
        <div className="rounded-3xl border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Skatteverket</h2>
            <Link href="/skatteverket" className="text-sm text-primary underline-offset-4 hover:underline">Öppna</Link>
          </div>
          <div className="mt-3 space-y-1 text-sm text-muted-foreground">
            <p>{skvConnected ? 'Ansluten — deklarationer kan förberedas och laddas upp.' : 'Inte ansluten — underlag kan fortfarande skapas och lämnas via Mina sidor.'}</p>
            {(taxSubmissions ?? []).slice(0, 3).map((sub) => (
              <p key={`${(sub as { submission_type: string }).submission_type}-${(sub as { period_key: string }).period_key}`}>
                {(sub as { submission_type: string }).submission_type.toUpperCase()} {(sub as { period_key: string }).period_key}:{' '}
                {TAX_SUBMISSION_STATUS_SV[(sub as { status: string }).status as keyof typeof TAX_SUBMISSION_STATUS_SV] ?? (sub as { status: string }).status}
              </p>
            ))}
          </div>
        </div>

        {/* Integrations */}
        <div className="rounded-3xl border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Integrationer</h2>
            <Link href="/settings/integrations" className="text-sm text-primary underline-offset-4 hover:underline">Visa alla</Link>
          </div>
          <div className="mt-3 space-y-1 text-sm text-muted-foreground">
            <p>Bankgiro: {(bankgiro as { status?: string } | null)?.status ?? 'ingen ansökan'}</p>
            <p>Peppol e-faktura: {getPeppolReadiness() === 'sandbox_ready' ? 'testläge' : 'kräver avtal med accesspunkt'}</p>
            <p>Fakturafinansiering: {getFinancingReadiness() === 'sandbox_ready' ? 'testläge' : 'kräver avtal'}</p>
            <p>BankID-samtycken: {activeConsents ?? 0} aktiva</p>
          </div>
        </div>

        {/* API & webhooks */}
        <div className="rounded-3xl border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">API & webhooks</h2>
            <Link href="/settings/webhooks" className="text-sm text-primary underline-offset-4 hover:underline">Hantera</Link>
          </div>
          <div className="mt-3 space-y-1 text-sm text-muted-foreground">
            <p>{activeWebhooks ?? 0} aktiva webhook-mottagare</p>
            <p>{(failedWebhookDeliveries ?? 0) > 0 ? `${failedWebhookDeliveries} misslyckade leveranser att åtgärda` : 'Inga misslyckade leveranser'}</p>
          </div>
        </div>
      </div>
    </NordklartPageShell>
  )
}
