import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { NordklartActionCard, NordklartPageShell, NordklartStatCard } from '@/components/nordklart/NordklartShell'
import { Button } from '@/components/ui/button'

export const dynamic = 'force-dynamic'

export default async function PlatformSkatteverketPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [settings, submissions, waiting, failed, deadlines] = await Promise.all([
    supabase.from('skatteverket_company_settings').select('*', { count: 'exact', head: true }).eq('connection_status', 'connected'),
    supabase.from('tax_submissions').select('*', { count: 'exact', head: true }),
    supabase.from('tax_submissions').select('*', { count: 'exact', head: true }).eq('status', 'waiting_for_signature'),
    supabase.from('tax_submissions').select('*', { count: 'exact', head: true }).eq('status', 'failed'),
    supabase.from('skatteverket_deadlines').select('*', { count: 'exact', head: true }).in('status', ['open', 'prepared']),
  ])

  return (
    <NordklartPageShell
      eyebrow="Skatteverket"
      title="Skatteverket-status över alla tenants"
      description="Koppling, tokenstatus, väntande signering, kvittenser och fel hanteras som separata statusar så inget framstår som inlämnat innan kvittens finns."
      actions={<Button asChild variant="secondary"><Link href="/platform">Till plattform</Link></Button>}
    >
      <div className="grid gap-4 md:grid-cols-5">
        <NordklartStatCard label="Kopplade bolag" value={settings.count ?? 0} description="connection_status=connected." tone="success" />
        <NordklartStatCard label="Inlämningar" value={submissions.count ?? 0} description="Alla tax_submissions." />
        <NordklartStatCard label="Väntar signering" value={waiting.count ?? 0} description="Kräver åtgärd." tone={(waiting.count ?? 0) > 0 ? 'warning' : 'success'} />
        <NordklartStatCard label="Fel" value={failed.count ?? 0} description="Misslyckade ärenden." tone={(failed.count ?? 0) > 0 ? 'warning' : 'success'} />
        <NordklartStatCard label="Deadlines" value={deadlines.count ?? 0} description="Öppna/prepared." />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <NordklartActionCard meta="Status" title="Ingen falsk inlämning" description="prepared, sent, waiting_for_signature, signed_submitted och receipt_received är separata steg." />
        <NordklartActionCard meta="Audit" title="tax_submission_events" description="Varje statusbyte, fel och kvittens kan loggas per bolag och submission." />
        <NordklartActionCard meta="Kundvy" title="Moms & skatt" description="Tenant-admin ser bara sitt bolags Skatteverket-status.">
          <Button asChild size="sm"><Link href="/skatteverket">Öppna kundvy</Link></Button>
        </NordklartActionCard>
      </div>
    </NordklartPageShell>
  )
}
