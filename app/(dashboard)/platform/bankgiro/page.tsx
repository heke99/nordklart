import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { NordklartActionCard, NordklartPageShell, NordklartStatCard } from '@/components/nordklart/NordklartShell'
import { Button } from '@/components/ui/button'

export const dynamic = 'force-dynamic'

export default async function PlatformBankgiroPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [providers, applications, review, active, mandates, reconciliation] = await Promise.all([
    supabase.from('payment_providers').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('bankgiro_applications').select('*', { count: 'exact', head: true }),
    supabase.from('bankgiro_applications').select('*', { count: 'exact', head: true }).in('status', ['submitted', 'needs_information', 'under_review']),
    supabase.from('bankgiro_applications').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('payment_mandates').select('*', { count: 'exact', head: true }).in('status', ['pending', 'active']),
    supabase.from('payment_reconciliation_items').select('*', { count: 'exact', head: true }).in('status', ['unmatched', 'needs_review']),
  ])

  return (
    <NordklartPageShell
      eyebrow="Bankgiro och Autogiro"
      title="Bankgiro/Autogiro provider-modul"
      description="Ansökningar, provider setup, dokument, ägarfrågor, mandat, collections och avstämning är separat från bokföringskärnan."
      actions={<Button asChild variant="secondary"><Link href="/platform">Till plattform</Link></Button>}
    >
      <div className="grid gap-4 md:grid-cols-6">
        <NordklartStatCard label="Providers" value={providers.count ?? 0} description="GoCardless/Leslie/fil/future." />
        <NordklartStatCard label="Ansökningar" value={applications.count ?? 0} description="Alla tenants." />
        <NordklartStatCard label="Review" value={review.count ?? 0} description="Behöver åtgärd." tone={(review.count ?? 0) > 0 ? 'warning' : 'success'} />
        <NordklartStatCard label="Aktiva" value={active.count ?? 0} description="status=active." tone="success" />
        <NordklartStatCard label="Mandat" value={mandates.count ?? 0} description="Pending/active." />
        <NordklartStatCard label="Avstämning" value={reconciliation.count ?? 0} description="Unmatched/needs review." tone={(reconciliation.count ?? 0) > 0 ? 'warning' : 'success'} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <NordklartActionCard meta="Princip" title="Inte krav för vanlig bokföring" description="Bankgiroflödet är separat från bokföring direkt och bankautomation." />
        <NordklartActionCard meta="Providers" title="Adaptermodell" description="payment_providers bär adapter_key, capabilities och setup_requirements för framtida partnerbyte." />
        <NordklartActionCard meta="Kundvy" title="Ansökan och status" description="Tenant-admin kan se sitt flöde och starta onboarding.">
          <Button asChild size="sm"><Link href="/payments/bankgiro">Öppna kundvy</Link></Button>
        </NordklartActionCard>
      </div>
    </NordklartPageShell>
  )
}
