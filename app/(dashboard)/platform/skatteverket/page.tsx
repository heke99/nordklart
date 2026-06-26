import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { NordklartActionCard, NordklartPageShell, NordklartStatCard } from '@/components/nordklart/NordklartShell'
import { Button } from '@/components/ui/button'
import { getSkvConfigStatus } from '@/lib/skatteverket/sysorg'

export const dynamic = 'force-dynamic'

export default async function PlatformSkatteverketPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const sysorg = getSkvConfigStatus()

  const [settings, submissions, waiting, failed, deadlines, requestFailures] = await Promise.all([
    supabase.from('skatteverket_company_settings').select('*', { count: 'exact', head: true }).eq('connection_status', 'connected'),
    supabase.from('tax_submissions').select('*', { count: 'exact', head: true }),
    supabase.from('tax_submissions').select('*', { count: 'exact', head: true }).eq('status', 'waiting_for_signature'),
    supabase.from('tax_submissions').select('*', { count: 'exact', head: true }).eq('status', 'failed'),
    supabase.from('skatteverket_deadlines').select('*', { count: 'exact', head: true }).in('status', ['open', 'prepared']),
    supabase.from('skatteverket_api_requests').select('*', { count: 'exact', head: true }).eq('status', 'failed'),
  ])

  return (
    <NordklartPageShell
      eyebrow="Skatteverket"
      title="Skatteverket-status över alla tenants"
      description="Koppling, tokenstatus, CCG sysorg, väntande signering, kvittenser och fel hanteras som separata statusar så inget framstår som inlämnat innan kvittens finns."
      actions={<Button asChild variant="secondary"><Link href="/platform">Till plattform</Link></Button>}
    >
      <div className="grid gap-4 md:grid-cols-5">
        <NordklartStatCard label="Kopplade bolag" value={settings.count ?? 0} description="connection_status=connected." tone="success" />
        <NordklartStatCard label="Inlämningar" value={submissions.count ?? 0} description="Alla tax_submissions." />
        <NordklartStatCard label="Väntar signering" value={waiting.count ?? 0} description="Kräver åtgärd." tone={(waiting.count ?? 0) > 0 ? 'warning' : 'success'} />
        <NordklartStatCard label="Fel" value={failed.count ?? 0} description="Misslyckade ärenden." tone={(failed.count ?? 0) > 0 ? 'warning' : 'success'} />
        <NordklartStatCard label="Deadlines" value={deadlines.count ?? 0} description="Öppna/prepared." />
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <NordklartStatCard label="Sysorg" value={sysorg.enabled ? 'På' : 'Av'} description={`Miljö: ${sysorg.environment}.`} tone={sysorg.enabled ? 'success' : 'warning'} />
        <NordklartStatCard label="Certifikat" value={sysorg.checks.find((c) => c.key === 'org_cert')?.ok ? 'Finns' : 'Saknas'} description="Expisoft .p12 via secret/env." tone={sysorg.checks.find((c) => c.key === 'org_cert')?.ok ? 'success' : 'warning'} />
        <NordklartStatCard label="Scopes" value={sysorg.scopes.length} description={sysorg.scopes.join(', ')} />
        <NordklartStatCard label="API-fel" value={requestFailures.count ?? 0} description="Misslyckade sysorg-anrop." tone={(requestFailures.count ?? 0) > 0 ? 'warning' : 'success'} />
      </div>

      <div className="rounded-3xl border bg-card p-5 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-xl font-semibold">Komplett Testtjänst / CCG sysorg</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
              Nordklart är förberett för Skatteverkets CCG sysorg-flöde med Gridex EL AB som filframställare/API-konsument. Inga hemligheter visas här; nycklar och Expisoft-certifikat ska ligga i miljövariabler.
            </p>
          </div>
          <Button asChild size="sm" variant="secondary"><Link href="/api/skatteverket/sysorg/status">Visa teknisk status</Link></Button>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          {sysorg.checks.map((check) => (
            <div key={check.key} className="rounded-2xl border bg-background/70 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">{check.required ? 'Krav' : 'Valfri'}</div>
              <div className="mt-2 font-semibold">{check.label}</div>
              <div className={check.ok ? 'mt-1 text-sm text-emerald-600' : 'mt-1 text-sm text-amber-600'}>{check.ok ? 'OK' : 'Saknas/av'}</div>
            </div>
          ))}
        </div>
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
