import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { NordklartActionCard, NordklartPageShell, NordklartStatCard } from '@/components/nordklart/NordklartShell'
import { Button } from '@/components/ui/button'

export const dynamic = 'force-dynamic'

export default async function AgencyPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: memberships } = await supabase
    .from('agency_members')
    .select('agency_id, role, status, agencies:agency_id(id, name, status)')
    .eq('user_id', user.id)
    .eq('status', 'active')

  const agencyIds = (memberships || []).map((m) => m.agency_id)
  const [
    { count: clientCount },
    { count: activeClientCount },
    { count: reviewCount },
    { count: templateCount },
    { data: latestClients },
  ] = agencyIds.length
    ? await Promise.all([
        supabase.from('agency_clients').select('*', { count: 'exact', head: true }).in('agency_id', agencyIds),
        supabase.from('agency_clients').select('*', { count: 'exact', head: true }).in('agency_id', agencyIds).eq('status', 'active'),
        supabase.from('review_queue_items').select('*', { count: 'exact', head: true }).in('agency_id', agencyIds).in('status', ['open', 'in_review']),
        supabase.from('agency_templates').select('*', { count: 'exact', head: true }).in('agency_id', agencyIds).eq('status', 'active'),
        supabase.from('agency_client_overview_v').select('company_id, company_name, bank_status, review_items_count, next_deadline_at').in('agency_id', agencyIds).order('company_name', { ascending: true }).limit(5),
      ])
    : [{ count: 0 }, { count: 0 }, { count: 0 }, { count: 0 }, { data: [] }]

  return (
    <NordklartPageShell
      eyebrow="Redovisningsbyrå"
      title="Byråläge för kunder, deadlines och granskning"
      description="Nordklart ger byrån översikt över kundstatus, ansvariga konsulter, deadlines och granskning utan att kundernas data blandas."
      actions={
        <Button asChild>
          <Link href="/agency/clients">Visa kundstatus</Link>
        </Button>
      }
    >
      <div className="grid gap-4 md:grid-cols-4">
        <NordklartStatCard label="Byråkopplingar" value={memberships?.length || 0} description="Byråkopplingar där du har behörighet." tone="primary" />
        <NordklartStatCard label="Kundbolag" value={clientCount || 0} description="Alla kunder kopplade till dina byråer." />
        <NordklartStatCard label="Aktiva kunder" value={activeClientCount || 0} description="Kunder med aktiv byrårelation." tone="success" />
        <NordklartStatCard label="Att granska" value={reviewCount || 0} description="Öppna ärenden i gemensam kö." tone="warning" />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <NordklartActionCard meta="Kundstatus" title="En vy per byråkund" description="Kundöversikten samlar bankstatus, granskning, moms, bokslut, Bankgiro och nästa deadline.">
          <Button asChild variant="secondary" size="sm"><Link href="/agency/clients">Öppna kundlistan</Link></Button>
        </NordklartActionCard>
        <NordklartActionCard meta="Team" title="Ansvarig konsult" description="Varje kund kan tilldelas ansvarig konsult med rätt behörighet för arbetet." />
        <NordklartActionCard meta="Mallar" title={`${templateCount || 0} aktiva byråmallar`} description="Återanvändbara mallar hjälper byrån att standardisera onboarding, deadlines, granskning och rapporter." />
      </div>

      <div className="rounded-3xl border bg-card p-5 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xl font-semibold">Senaste kundstatus</h2>
          <Button asChild variant="ghost" size="sm"><Link href="/agency/clients">Visa alla</Link></Button>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2 lg:grid-cols-5">
          {(latestClients ?? []).map((client) => (
            <div key={client.company_id} className="rounded-2xl border bg-background/70 p-4">
              <div className="truncate font-medium">{client.company_name}</div>
              <div className="mt-2 text-xs text-muted-foreground">Bank: {client.bank_status}</div>
              <div className="text-xs text-muted-foreground">Granska: {client.review_items_count}</div>
              <div className="text-xs text-muted-foreground">Deadline: {client.next_deadline_at ?? 'ingen'}</div>
            </div>
          ))}
          {(!latestClients || latestClients.length === 0) ? <div className="rounded-2xl border bg-background/70 p-4 text-sm text-muted-foreground">Inga kunder att visa ännu.</div> : null}
        </div>
      </div>
    </NordklartPageShell>
  )
}
