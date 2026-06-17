import Link from 'next/link'
import type { ReactNode } from 'react'
import { ArrowRight, CheckCircle2 } from 'lucide-react'
import {
  MarketingChrome,
  marketingPrimaryCta,
  marketingSecondaryCta,
  marketingSectionLabel,
} from '@/components/marketing/MarketingChrome'

type InfoPageProps = {
  eyebrow: string
  title: string
  description: string
  primaryCta?: { label: string; href: string }
  secondaryCta?: { label: string; href: string }
  highlights?: string[]
  sections?: Array<{ title: string; body: string; points?: string[] }>
  children?: ReactNode
}

export function MarketingInfoPage({
  eyebrow,
  title,
  description,
  primaryCta,
  secondaryCta,
  highlights = [],
  sections = [],
  children,
}: InfoPageProps) {
  return (
    <MarketingChrome>
      <main>
        <section className="relative px-5 py-16 md:px-8 md:py-24">
          <div className="absolute inset-x-0 top-0 -z-10 h-[28rem] bg-[radial-gradient(circle_at_20%_0%,hsl(var(--accent)/0.8),transparent_26rem),radial-gradient(circle_at_84%_8%,hsl(var(--secondary)/0.95),transparent_28rem)]" />
          <div className="mx-auto max-w-5xl space-y-7">
            <p className={marketingSectionLabel}>{eyebrow}</p>
            <h1 className="text-balance font-display text-5xl font-semibold leading-[0.98] tracking-tight md:text-7xl">{title}</h1>
            <p className="max-w-3xl text-lg leading-8 text-muted-foreground md:text-xl">{description}</p>
            {(primaryCta || secondaryCta) ? (
              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                {primaryCta ? (
                  <Link href={primaryCta.href} className={marketingPrimaryCta}>
                    {primaryCta.label} <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
                  </Link>
                ) : null}
                {secondaryCta ? <Link href={secondaryCta.href} className={marketingSecondaryCta}>{secondaryCta.label}</Link> : null}
              </div>
            ) : null}
          </div>
        </section>

        {highlights.length ? (
          <section className="px-5 pb-8 md:px-8">
            <div className="mx-auto grid max-w-7xl gap-4 md:grid-cols-2 xl:grid-cols-4">
              {highlights.map((item) => (
                <div key={item} className="rounded-3xl border border-border bg-card/90 p-5 shadow-sm">
                  <CheckCircle2 className="mb-4 h-5 w-5 text-success" aria-hidden="true" />
                  <p className="font-semibold leading-6">{item}</p>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="px-5 py-12 md:px-8">
          <div className="mx-auto grid max-w-7xl gap-5 md:grid-cols-2">
            {sections.map((section) => (
              <article key={section.title} className="rounded-[2rem] border border-border bg-card/90 p-6 shadow-sm md:p-8">
                <h2 className="text-2xl font-semibold tracking-tight">{section.title}</h2>
                <p className="mt-3 leading-7 text-muted-foreground">{section.body}</p>
                {section.points?.length ? (
                  <ul className="mt-6 space-y-3 text-sm text-muted-foreground">
                    {section.points.map((point) => (
                      <li key={point} className="flex gap-2">
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                        <span>{point}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </article>
            ))}
          </div>
        </section>

        {children}
      </main>
    </MarketingChrome>
  )
}
