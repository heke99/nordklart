import Link from 'next/link'
import { createServiceClient } from '@/lib/supabase/server'
import { requirePlatformRole } from '@/lib/auth/platform'
import { NordklartActionCard, NordklartPageShell, NordklartStatCard } from '@/components/nordklart/NordklartShell'
import { Button } from '@/components/ui/button'

export const dynamic = 'force-dynamic'

export default async function PlatformYearEndPage() {
  // All platform roles may inspect these cross-tenant stats. The service
  // client is required: RLS-scoped reads silently return zeros for
  // platform_support / platform_auditor (only platform_admin bypasses RLS).
  await requirePlatformRole()
  const supabase = createServiceClient()

  const [projects, checks, deliverables, purchases, access] = await Promise.all([
    supabase.from('year_end_projects').select('*', { count: 'exact', head: true }),
    supabase.from('year_end_checks').select('*', { count: 'exact', head: true }).in('status', ['warning', 'error']),
    supabase.from('year_end_deliverables').select('*', { count: 'exact', head: true }).in('status', ['generated', 'approved', 'sent', 'archived']),
    supabase.from('one_time_purchases').select('*', { count: 'exact', head: true }).eq('purchase_type', 'year_end'),
    supabase.from('year_end_purchase_access').select('*', { count: 'exact', head: true }).eq('access_status', 'active'),
  ])

  return (
    <NordklartPageShell
      eyebrow="Bokslut"
      title="Bokslut som produkt"
      description="Överblick över bokslutsprojekt, engångsköp, access och exportpaket utan att röra bokföringsmotorns låsningsregler."
      actions={<Button asChild variant="secondary"><Link href="/platform">Till plattform</Link></Button>}
    >
      <div className="grid gap-4 md:grid-cols-5">
        <NordklartStatCard label="Projekt" value={projects.count ?? 0} description="Alla bolag." />
        <NordklartStatCard label="Öppna kontroller" value={checks.count ?? 0} description="Varning/fel/open." tone={(checks.count ?? 0) > 0 ? 'warning' : 'success'} />
        <NordklartStatCard label="Exportpaket" value={deliverables.count ?? 0} description="Redo." tone="primary" />
        <NordklartStatCard label="Engångsköp" value={purchases.count ?? 0} description="year_end." />
        <NordklartStatCard label="Aktiv access" value={access.count ?? 0} description="year_end_purchase_access." tone="success" />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <NordklartActionCard meta="Data" title="year_end_projects" description="Utökat med source, readiness, access source, exportstatus och next_action." />
        <NordklartActionCard meta="Commerce" title="one_time_purchase + access" description="Engångsköp kan ge permanent eller tidsstyrd bokslutsaccess." />
        <NordklartActionCard meta="UI" title="Kundvy finns länkad" description="Sidomenyn och hero-flöden pekar in till rätt boksluts/onboardingväg.">
          <Button asChild size="sm"><Link href="/year-end">Öppna kundvy</Link></Button>
        </NordklartActionCard>
      </div>
    </NordklartPageShell>
  )
}
