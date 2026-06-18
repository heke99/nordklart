import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowRight, Building2, CheckCircle2, Landmark, ReceiptText, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/server'
import { getActiveCompanyId } from '@/lib/company/context'

export const dynamic = 'force-dynamic'

const PATH_COPY = {
  bookkeeping_direct: {
    eyebrow: 'Företaget är skapat',
    title: 'Fortsätt med din bokföring',
    description: 'Bolagsuppgifterna är sparade. Nästa steg är att välja räkenskapsår, momsperiod och den plan som passar verksamheten.',
    primaryHref: '/app',
    primaryLabel: 'Öppna översikten',
    icon: Building2,
  },
  bank_automation: {
    eyebrow: 'Företaget är skapat',
    title: 'Koppla banken när du är redo',
    description: 'Bolaget är klart. Fortsätt med bankkoppling och import av transaktioner så att Nordklart kan börja föreslå bokföring.',
    primaryHref: '/bank-automation',
    primaryLabel: 'Öppna bankautomation',
    icon: Landmark,
  },
  year_end_one_time: {
    eyebrow: 'Bokslutsarbetsytan är klar',
    title: 'Starta ditt bokslut',
    description: 'Bolaget är skapat. Importera SIE eller använd bokföringen som redan finns i Nordklart för att fortsätta med bokslutet.',
    primaryHref: '/year-end',
    primaryLabel: 'Öppna bokslut',
    icon: ReceiptText,
  },
  bankgiro_autogiro: {
    eyebrow: 'Bolaget är skapat',
    title: 'Fortsätt med Bankgiro och Autogiro',
    description: 'Bokföringen är separerad från betalansökan. Fyll nu i uppgifter om verksamheten, ägare och förväntad användning.',
    primaryHref: '/payments/bankgiro',
    primaryLabel: 'Öppna Bankgiro',
    icon: ShieldCheck,
  },
} as const

type SupportedPath = keyof typeof PATH_COPY

function isSupportedPath(value: string): value is SupportedPath {
  return value in PATH_COPY
}

export default async function ProvisionedWorkspaceOnboardingPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const companyId = await getActiveCompanyId(supabase, user.id)
  if (!companyId) redirect('/onboarding')

  const [{ data: company }, { data: session }] = await Promise.all([
    supabase.from('companies').select('name').eq('id', companyId).single(),
    supabase
      .from('onboarding_sessions')
      .select('id, path')
      .eq('company_id', companyId)
      .eq('user_id', user.id)
      .eq('status', 'in_progress')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  if (!session || !isSupportedPath(session.path)) redirect('/app')

  const { data: steps } = await supabase
    .from('onboarding_steps')
    .select('step_code, title, sort_order, status')
    .eq('session_id', session.id)
    .order('sort_order')
    .limit(5)

  const content = PATH_COPY[session.path]
  const Icon = content.icon
  const orderedSteps = steps ?? []

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,hsl(var(--primary)/0.16),transparent_34%),hsl(var(--background))] px-5 py-10 md:px-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <section className="rounded-[2rem] border bg-card p-6 shadow-sm md:p-9">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Icon className="h-6 w-6" /></div>
          <p className="mt-5 text-sm font-medium text-primary">{content.eyebrow}</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">{content.title}</h1>
          <p className="mt-3 max-w-2xl leading-7 text-muted-foreground">{company?.name ?? 'Ditt företag'} är redo. {content.description}</p>

          {orderedSteps.length > 0 && (
            <ol className="mt-7 grid gap-3 md:grid-cols-2">
              {orderedSteps.map((step, index) => (
                <li key={step.step_code} className="flex items-center gap-3 rounded-2xl border bg-background/70 p-4 text-sm">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{index + 1}</span>
                  <span className="font-medium">{step.title}</span>
                </li>
              ))}
            </ol>
          )}

          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild><Link href={content.primaryHref}>{content.primaryLabel}<ArrowRight className="ml-2 h-4 w-4" /></Link></Button>
            <Button asChild variant="secondary"><Link href="/app"><CheckCircle2 className="mr-2 h-4 w-4" />Öppna översikten</Link></Button>
          </div>
        </section>
      </div>
    </main>
  )
}
