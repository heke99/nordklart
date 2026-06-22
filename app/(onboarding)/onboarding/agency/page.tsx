import Link from 'next/link'
import type { ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { Building2, CheckCircle2, UsersRound } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Button } from '@/components/ui/button'

export const dynamic = 'force-dynamic'

export default async function AgencyOnboardingPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: agencyMember } = await supabase
    .from('agency_members')
    .select('agency_id, agencies:agency_id(name, company_id)')
    .eq('user_id', user.id)
    .eq('role', 'agency_owner')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!agencyMember) redirect('/register?workspace=agency')

  const agency = Array.isArray(agencyMember.agencies) ? agencyMember.agencies[0] : agencyMember.agencies
  const agencyName = agency?.name ?? 'Din redovisningsbyrå'

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,hsl(var(--primary)/0.16),transparent_34%),hsl(var(--background))] px-5 py-10 md:px-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <section className="rounded-[2rem] border bg-card p-6 shadow-sm md:p-9">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Building2 className="h-6 w-6" /></div>
          <p className="mt-5 text-sm font-medium text-primary">Byråarbetsyta skapad</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">{agencyName} är redo att konfigureras</h1>
          <p className="mt-3 max-w-2xl leading-7 text-muted-foreground">Byrån har nu ett eget bolag för sin egen bokföring och en separat byråarbetsyta för team, kundbolag och granskning. Kunddata är fortfarande isolerad per bolag.</p>
          <div className="mt-7 grid gap-3 md:grid-cols-3">
            <Step title="1. Bjud in teamet" icon={<UsersRound className="h-4 w-4" />} />
            <Step title="2. Lägg till kundbolag" icon={<Building2 className="h-4 w-4" />} />
            <Step title="3. Öppna granskningskön" icon={<CheckCircle2 className="h-4 w-4" />} />
          </div>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild><Link href="/agency">Öppna byråöversikten</Link></Button>
            <Button asChild variant="secondary"><Link href="/app">Öppna byråns eget bolag</Link></Button>
          </div>
        </section>
      </div>
    </main>
  )
}

function Step({ title, icon }: { title: string; icon: ReactNode }) {
  return <div className="rounded-2xl border bg-background/70 p-4 text-sm font-medium"><span className="mb-3 flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary">{icon}</span>{title}</div>
}
