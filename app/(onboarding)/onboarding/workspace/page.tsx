import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Building2, CheckCircle2, Landmark, ReceiptText, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import CompleteCoreOnboardingButton from '@/components/onboarding/CompleteCoreOnboardingButton'
import { createClient } from '@/lib/supabase/server'
import { getActiveCompanyId } from '@/lib/company/context'

export const dynamic = 'force-dynamic'

const PATH_COPY = {
  bookkeeping_direct: {
    eyebrow: 'Arbetsytan är klar',
    title: 'Du kan börja bokföra',
    description: 'Bolag, kontoplan och grundinställningar är klara. Bank, bokslut och fler tjänster kan läggas till senare.',
    primaryHref: '/app',
    primaryLabel: 'Öppna översikten',
    icon: Building2,
  },
  bank_automation: {
    eyebrow: 'Arbetsytan är klar',
    title: 'Koppla banken när du vill',
    description: 'Bokföringen är klar att använda. Nästa rekommenderade steg är att koppla bank och importera transaktioner.',
    primaryHref: '/bank-automation',
    primaryLabel: 'Fortsätt till bankautomation',
    icon: Landmark,
  },
  year_end_one_time: {
    eyebrow: 'Bokslutsarbetsytan är klar',
    title: 'Starta ditt bokslut',
    description: 'Bolaget är klart. Importera SIE eller använd bokföringen som redan finns i Nordklart.',
    primaryHref: '/year-end',
    primaryLabel: 'Öppna bokslut',
    icon: ReceiptText,
  },
  bankgiro_autogiro: {
    eyebrow: 'Arbetsytan är klar',
    title: 'Fortsätt med Bankgiro och Autogiro',
    description: 'Bokföringen är redan tillgänglig. Betalansansökan är ett separat och valfritt flöde.',
    primaryHref: '/payments/bankgiro',
    primaryLabel: 'Öppna Bankgiro',
    icon: ShieldCheck,
  },
  agency_setup: {
    eyebrow: 'Byråarbetsytan är klar',
    title: 'Öppna byråöversikten',
    description: 'Byrån har ett eget bolag för sin bokföring och en separat yta för team, kundbolag och granskning.',
    primaryHref: '/agency',
    primaryLabel: 'Öppna byråöversikten',
    icon: Building2,
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

  const [{ data: company }, { data: session }, { data: steps }] = await Promise.all([
    supabase.from('companies').select('name').eq('id', companyId).single(),
    supabase
      .from('onboarding_sessions')
      .select('id, path')
      .eq('company_id', companyId)
      .eq('user_id', user.id)
      .in('status', ['draft', 'in_progress'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('onboarding_steps')
      .select('step_code, title, sort_order, status')
      .eq('company_id', companyId)
      .order('sort_order')
      .limit(6),
  ])

  if (!session || !isSupportedPath(session.path)) redirect('/onboarding')

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

          {orderedSteps.length > 0 ? (
            <ol className="mt-7 grid gap-3 md:grid-cols-2">
              {orderedSteps.map((step, index) => (
                <li key={step.step_code} className="flex items-center gap-3 rounded-2xl border bg-background/70 p-4 text-sm">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{index + 1}</span>
                  <span className="font-medium">{step.title}</span>
                </li>
              ))}
            </ol>
          ) : null}

          <div className="mt-8 flex flex-wrap gap-3">
            <CompleteCoreOnboardingButton href={content.primaryHref} label={content.primaryLabel} />
            <Button asChild variant="secondary"><Link href="/onboarding"><CheckCircle2 className="mr-2 h-4 w-4" />Välj annat senare</Link></Button>
          </div>
        </section>
      </div>
    </main>
  )
}
