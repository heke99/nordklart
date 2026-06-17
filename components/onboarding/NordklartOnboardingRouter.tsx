import Link from 'next/link'
import { ArrowRight, CheckCircle2 } from 'lucide-react'
import { ONBOARDING_PATHS, getOnboardingPath } from '@/lib/onboarding/paths'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

export default function NordklartOnboardingRouter({ selectedFlow }: { selectedFlow?: string | null }) {
  const selected = getOnboardingPath(selectedFlow)

  if (selected && selected.code !== 'bookkeeping_direct') {
    return (
      <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,hsl(var(--primary)/0.16),transparent_34%),hsl(var(--background))] px-5 py-10 md:px-8">
        <div className="mx-auto max-w-4xl space-y-6">
          <div className="rounded-[2rem] border bg-card/90 p-6 shadow-sm md:p-8">
            <Badge>{selected.shortTitle}</Badge>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight md:text-5xl">{selected.title}</h1>
            <p className="mt-3 max-w-2xl text-base leading-7 text-muted-foreground md:text-lg">{selected.description}</p>
            <div className="mt-6 grid gap-3 md:grid-cols-2">
              {selected.steps.map((step, index) => (
                <div key={step} className="flex items-center gap-3 rounded-2xl border bg-background/70 p-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">{index + 1}</div>
                  <span className="text-sm font-medium">{step}</span>
                </div>
              ))}
            </div>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild>
                <Link href={`/onboarding?flow=bookkeeping_direct&intent=${selected.code}`}>
                  Skapa bolag först <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <Button asChild variant="secondary">
                <Link href="/onboarding">Välj annan väg</Link>
              </Button>
            </div>
          </div>

          <div className="rounded-3xl border bg-card p-5 text-sm leading-6 text-muted-foreground">
            Bankgiro/Autogiro och bankautomation ligger som separata vägar. En vanlig bokföringskund behöver inte fylla i Bankgiro-frågor för att komma igång.
          </div>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,hsl(var(--primary)/0.16),transparent_34%),hsl(var(--background))] px-5 py-10 md:px-8">
      <div className="mx-auto max-w-6xl space-y-8">
        <section className="rounded-[2rem] border bg-card/90 p-6 shadow-sm md:p-10">
          <Badge>Nordklart onboarding</Badge>
          <h1 className="mt-4 max-w-3xl text-3xl font-semibold tracking-tight md:text-5xl">Välj hur du vill komma igång</h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-muted-foreground md:text-lg">
            Nordklart har separata startvägar för vanlig bokföring, automatiserad bokföring, bokslut och Bankgiro/Autogiro. Det håller flödet kort och minskar friktion.
          </p>
        </section>

        <section className="grid gap-4 lg:grid-cols-4">
          {ONBOARDING_PATHS.map((path) => {
            const Icon = path.icon
            return (
              <Link key={path.code} href={path.href} className="group rounded-3xl border bg-card p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <Icon className="h-5 w-5" />
                </div>
                <h2 className="mt-5 text-xl font-semibold">{path.title}</h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{path.description}</p>
                <div className="mt-5 space-y-2">
                  {path.steps.slice(0, 4).map((step) => (
                    <div key={step} className="flex items-center gap-2 text-xs text-muted-foreground">
                      <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
                      {step}
                    </div>
                  ))}
                </div>
                <div className="mt-5 flex items-center text-sm font-medium text-primary">
                  Starta <ArrowRight className="ml-2 h-4 w-4 transition group-hover:translate-x-0.5" />
                </div>
              </Link>
            )
          })}
        </section>
      </div>
    </main>
  )
}
