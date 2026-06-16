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
    .select('agency_id, role, agencies:agency_id(id, name, status)')
    .eq('user_id', user.id)

  const agencyIds = (memberships || []).map((m) => m.agency_id)
  const [{ count: clientCount }, { count: activeClientCount }] = agencyIds.length
    ? await Promise.all([
        supabase.from('agency_clients').select('*', { count: 'exact', head: true }).in('agency_id', agencyIds),
        supabase.from('agency_clients').select('*', { count: 'exact', head: true }).in('agency_id', agencyIds).eq('status', 'active'),
      ])
    : [{ count: 0 }, { count: 0 }]

  return (
    <NordklartPageShell
      eyebrow="Byråläge"
      title="Kunder, deadlines och granskning på ett ställe"
      description="Nordklart skiljer tydligt på plattform, redovisningsbyrå och klientbolag. Byrån får översikt över sina kunder utan att klientdata blandas mellan tenants."
      actions={<Button>Skapa byrå</Button>}
    >
      <div className="grid gap-4 md:grid-cols-3">
        <NordklartStatCard label="Byråer" value={memberships?.length || 0} description="Byråkopplingar där du har behörighet." tone="primary" />
        <NordklartStatCard label="Klientbolag" value={clientCount || 0} description="Alla klienter kopplade till dina byråer." />
        <NordklartStatCard label="Aktiva klienter" value={activeClientCount || 0} description="Klienter med aktiv byrårelation." tone="success" />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <NordklartActionCard meta="Batch 3" title="Riktig byråmodell" description="Nya tabeller för agencies, agency_members och agency_clients gör att byråer kan hantera flera kundbolag utan att duplicera bokföringsdata." />
        <NordklartActionCard meta="Tenant-säkert" title="Direkt och byråbaserad access" description="company_access-vyn kombinerar befintliga company_members med byråkopplingar. Det gör framtida guards enklare och snabbare." />
        <NordklartActionCard meta="Nästa batch" title="Byrådashboard byggs vidare" description="Nästa steg blir arbetskö, deadlines per kund, ansvarig konsult och kundstatuskort för moms, bank, bokslut och rapportering." />
      </div>
    </NordklartPageShell>
  )
}
