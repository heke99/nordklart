'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowRight,
  Building2,
  CheckCircle2,
  Landmark,
  ReceiptText,
  Settings2,
  UsersRound,
  WalletCards,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'

type PathCode =
  | 'bookkeeping_direct'
  | 'bank_automation'
  | 'year_end_one_time'
  | 'agency_setup'
  | 'bankgiro_autogiro'
  | 'configure_later'

type Option = {
  code: PathCode
  title: string
  description: string
  next: string
  icon: typeof Building2
}

const OPTIONS: Option[] = [
  {
    code: 'bookkeeping_direct',
    title: 'Börja med bokföring',
    description: 'Bokför manuellt, skapa fakturor och få full översikt från första dagen.',
    next: 'Öppnar din översikt och bokföring.',
    icon: ReceiptText,
  },
  {
    code: 'bank_automation',
    title: 'Automatisera med bank',
    description: 'Koppla bank när du är redo och låt Nordklart föreslå bokföring.',
    next: 'Nästa steg: koppla bank.',
    icon: Landmark,
  },
  {
    code: 'year_end_one_time',
    title: 'Gör bokslut',
    description: 'Starta från befintlig bokföring eller importera en SIE-fil.',
    next: 'Nästa steg: välj räkenskapsår.',
    icon: CheckCircle2,
  },
  {
    code: 'agency_setup',
    title: 'Redovisningsbyrå',
    description: 'Arbeta med kunder, team, deadlines och gemensam granskning.',
    next: 'Nästa steg: öppna byråöversikten.',
    icon: UsersRound,
  },
  {
    code: 'bankgiro_autogiro',
    title: 'Bankgiro eller Autogiro',
    description: 'Starta en separat ansökan när betalflöden är aktuella.',
    next: 'Nästa steg: komplettera ansökan.',
    icon: WalletCards,
  },
  {
    code: 'configure_later',
    title: 'Annat eller senare',
    description: 'Öppna översikten först. Du kan lägga till bank, bokslut, fakturering och fler tjänster när du vill.',
    next: 'Öppnar din översikt utan att låsa dig.',
    icon: Settings2,
  },
]

export default function NordklartOnboardingRouter({
  selectedFlow,
  isAgencyWorkspace = false,
  companyName,
}: {
  selectedFlow?: string | null
  isAgencyWorkspace?: boolean
  companyName?: string | null
}) {
  const router = useRouter()
  const [selected, setSelected] = useState<PathCode | null>(
    OPTIONS.some((option) => option.code === selectedFlow)
      ? selectedFlow as PathCode
      : null,
  )
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const visibleOptions = OPTIONS.filter(
    (option) => option.code !== 'agency_setup' || isAgencyWorkspace,
  )

  function choose(option: Option) {
    setSelected(option.code)
    setError(null)
    startTransition(async () => {
      const response = await fetch('/api/onboarding/select-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: option.code }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok || !body?.data?.next_href) {
        setError(body?.error || 'Kunde inte spara valet just nu.')
        return
      }
      router.push(body.data.next_href)
      router.refresh()
    })
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,hsl(var(--primary)/0.16),transparent_34%),hsl(var(--background))] px-5 py-8 md:px-8 md:py-12">
      <div className="mx-auto max-w-7xl space-y-8">
        <section className="rounded-[2rem] border bg-card/90 p-7 shadow-sm md:p-10">
          <Badge>Kom igång</Badge>
          <h1 className="mt-4 max-w-3xl text-3xl font-semibold tracking-tight md:text-5xl">
            Vad vill du börja med{companyName ? ` i ${companyName}` : ''}?
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-muted-foreground md:text-lg">
            Välj det som passar bäst just nu. Du kan alltid lägga till bank, bokslut, Bankgiro och andra funktioner senare.
          </p>
        </section>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {visibleOptions.map((option) => {
            const Icon = option.icon
            const active = selected === option.code
            return (
              <button
                key={option.code}
                type="button"
                disabled={pending}
                onClick={() => choose(option)}
                className={cn(
                  'group flex h-full flex-col rounded-[2rem] border border-border bg-card/90 p-6 shadow-sm text-left transition duration-200 hover:-translate-y-1 hover:border-primary/50 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-wait disabled:opacity-60',
                  active && 'border-primary bg-primary/[0.035] ring-1 ring-primary',
                )}
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <Icon className="h-5 w-5" />
                </span>
                <h2 className="mt-5 text-xl font-semibold tracking-tight">{option.title}</h2>
                <p className="mt-3 flex-1 leading-7 text-muted-foreground">{option.description}</p>
                <div className="mt-6 flex items-start gap-2 text-sm font-medium leading-6 text-primary">
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
                  <span>{option.next}</span>
                </div>
                <div className="mt-7 inline-flex items-center text-sm font-semibold text-primary">
                  {pending && active ? 'Öppnar…' : 'Välj detta'}
                  <ArrowRight className="ml-2 h-5 w-5 transition group-hover:translate-x-1" />
                </div>
              </button>
            )
          })}
        </section>

        {error ? (
          <p role="alert" className="rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </main>
  )
}
