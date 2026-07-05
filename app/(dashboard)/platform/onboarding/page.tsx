import Link from 'next/link'
import { createServiceClient } from '@/lib/supabase/server'
import { requirePlatformRole } from '@/lib/auth/platform'
import { ONBOARDING_PATHS } from '@/lib/onboarding/paths'
import { NordklartActionCard, NordklartPageShell, NordklartStatCard } from '@/components/nordklart/NordklartShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

export const dynamic = 'force-dynamic'

type SessionRow = {
  id: string
  path: string
  status: string
  current_step: string | null
  progress_percent: number
  created_at: string
}

function flowLabel(path: string) {
  return ONBOARDING_PATHS.find((item) => item.code === path)?.title ?? path.replaceAll('_', ' ')
}

export default async function PlatformOnboardingPage() {
  // All platform roles may inspect these cross-tenant stats. The service
  // client is required: RLS-scoped reads silently return zeros for
  // platform_support / platform_auditor (only platform_admin bypasses RLS).
  await requirePlatformRole()
  const supabase = createServiceClient()

  const [
    { data: sessions },
    { count: inProgress },
    { count: completed },
    { count: blocked },
    { count: bankgiroSessions },
  ] = await Promise.all([
    supabase.from('onboarding_sessions').select('id, path, status, current_step, progress_percent, created_at').order('created_at', { ascending: false }).limit(12),
    supabase.from('onboarding_sessions').select('*', { count: 'exact', head: true }).eq('status', 'in_progress'),
    supabase.from('onboarding_sessions').select('*', { count: 'exact', head: true }).eq('status', 'completed'),
    supabase.from('onboarding_sessions').select('*', { count: 'exact', head: true }).eq('status', 'blocked'),
    supabase.from('onboarding_sessions').select('*', { count: 'exact', head: true }).eq('path', 'bankgiro_autogiro'),
  ])

  return (
    <NordklartPageShell
      eyebrow="Onboarding"
      title="Onboardingvägar utan Bankgiro-friktion"
      description="Vanlig bokföring, bankautomation, engångsbokslut och Bankgiro/Autogiro har egna flöden, statusar, progress och audit-grund."
      actions={<Button asChild variant="secondary"><Link href="/onboarding">Öppna onboarding</Link></Button>}
    >
      <div className="grid gap-4 md:grid-cols-4">
        <NordklartStatCard label="Pågående" value={inProgress ?? 0} description="Aktiva onboarding-sessioner." tone="primary" />
        <NordklartStatCard label="Klara" value={completed ?? 0} description="Slutförda flöden." tone="success" />
        <NordklartStatCard label="Blockerade" value={blocked ?? 0} description="Kräver åtgärd." tone="warning" />
        <NordklartStatCard label="Bankgiroflöden" value={bankgiroSessions ?? 0} description="Separata från vanlig signup." />
      </div>

      <div className="grid gap-4 lg:grid-cols-4">
        {ONBOARDING_PATHS.map((path) => (
          <NordklartActionCard key={path.code} meta={path.shortTitle} title={path.title} description={path.description}>
            <div className="space-y-2">
              {path.steps.map((step, index) => (
                <div key={step} className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">{index + 1}</span>
                  {step}
                </div>
              ))}
            </div>
          </NordklartActionCard>
        ))}
      </div>

      <div className="rounded-3xl border bg-card p-5">
        <h2 className="text-xl font-semibold">Senaste onboarding-sessioner</h2>
        <div className="mt-4 overflow-hidden rounded-2xl border">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <tr><th className="p-3">Flöde</th><th className="p-3">Status</th><th className="p-3">Steg</th><th className="p-3">Progress</th></tr>
            </thead>
            <tbody>
              {((sessions ?? []) as SessionRow[]).map((session) => (
                <tr key={session.id} className="border-t">
                  <td className="p-3 font-medium">{flowLabel(session.path)}</td>
                  <td className="p-3"><Badge variant={session.status === 'completed' ? 'success' : session.status === 'blocked' ? 'warning' : 'secondary'}>{session.status}</Badge></td>
                  <td className="p-3 text-muted-foreground">{session.current_step ?? 'start'}</td>
                  <td className="p-3 tabular-nums">{session.progress_percent}%</td>
                </tr>
              ))}
              {(!sessions || sessions.length === 0) ? (
                <tr><td className="p-6 text-center text-muted-foreground" colSpan={4}>Inga onboarding-sessioner ännu.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </NordklartPageShell>
  )
}
