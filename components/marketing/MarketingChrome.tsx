import Link from 'next/link'
import type { ReactNode } from 'react'
import { ArrowRight, Scale } from 'lucide-react'
import { BrandWordmark } from '@/components/branding/BrandWordmark'

const navItems = [
  { label: 'Automatiserad bokföring', href: '/bokforing' },
  { label: 'Bokslut', href: '/bokslut' },
  { label: 'Bankgiro', href: '/bankgiro' },
  { label: 'Byrå', href: '/byra' },
  { label: 'Priser', href: '/priser' },
  { label: 'Kontakt', href: '/kontakt' },
]

const footerGroups = [
  {
    title: 'Produkt',
    links: [
      { label: 'Automatiserad bokföring', href: '/bokforing' },
      { label: 'Bokslut', href: '/bokslut' },
      { label: 'Bankgiro', href: '/bankgiro' },
      { label: 'Redovisningsbyrå', href: '/byra' },
      { label: 'Priser', href: '/priser' },
    ],
  },
  {
    title: 'Kom igång',
    links: [
      { label: 'Starta automatiserad bokföring', href: '/register?intent=auto' },
      { label: 'Gör bokslut', href: '/register?intent=year_end' },
      { label: 'Ansök om Bankgiro', href: '/register?intent=bankgiro' },
      { label: 'Boka demo', href: '/boka-demo' },
      { label: 'Logga in', href: '/login' },
    ],
  },
  {
    title: 'Juridik',
    links: [
      { label: 'Allmänna villkor', href: '/allmanna-villkor' },
      { label: 'Integritetspolicy', href: '/integritetspolicy' },
      { label: 'Personuppgifter', href: '/personuppgifter' },
      { label: 'Personuppgiftsbiträdesavtal', href: '/personuppgiftsbitradesavtal' },
      { label: 'Ångerrätt', href: '/angerratt' },
      { label: 'Cookies', href: '/cookies' },
    ],
  },
]

export const marketingPrimaryCta =
  'inline-flex items-center justify-center rounded-full bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground shadow-md transition hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background'

export const marketingSecondaryCta =
  'inline-flex items-center justify-center rounded-full border border-border bg-card/90 px-5 py-3 text-sm font-semibold text-foreground shadow-sm transition hover:-translate-y-0.5 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background'

export const marketingSectionLabel = 'text-sm font-semibold uppercase tracking-[0.22em] text-primary'

const NORDKLART_ORG_NUMBER = '559416-7149'

export function MarketingChrome({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen overflow-hidden bg-background text-foreground">
      <MarketingHeader />
      {children}
      <MarketingFooter />
    </div>
  )
}

export function MarketingHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/88 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 md:px-8">
        <Link href="/" aria-label="Nordklart startsida" className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
            <Scale className="h-5 w-5" aria-hidden="true" />
          </span>
          <BrandWordmark size="inline" lowercase={false} className="text-xl" />
        </Link>

        <nav className="hidden items-center gap-7 text-sm font-medium text-muted-foreground lg:flex" aria-label="Huvudmeny">
          {navItems.map((item) => (
            <Link key={item.href} href={item.href} className="transition hover:text-foreground">
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <Link href="/login" className="hidden rounded-full px-4 py-2 text-sm font-semibold text-muted-foreground transition hover:text-foreground sm:inline-flex">
            Logga in
          </Link>
          <Link href="/boka-demo" className="hidden rounded-full border border-border bg-card/80 px-4 py-2 text-sm font-semibold text-foreground shadow-sm transition hover:-translate-y-0.5 hover:bg-secondary md:inline-flex">
            Boka demo
          </Link>
          <Link href="/register?intent=auto" className="inline-flex items-center rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
            Starta <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </header>
  )
}

export function MarketingFooter() {
  return (
    <footer className="border-t border-border bg-card/80 px-5 py-12 md:px-8">
      <div className="mx-auto grid max-w-7xl gap-10 md:grid-cols-[1.35fr_repeat(3,1fr)]">
        <div className="space-y-4">
          <Link href="/" className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
              <Scale className="h-5 w-5" aria-hidden="true" />
            </span>
            <BrandWordmark size="inline" lowercase={false} className="text-xl" />
          </Link>
          <p className="max-w-sm leading-7 text-muted-foreground">
            Automatiserad svensk bokföring med fakturor, verifikationer, fristående bokslut och hjälp med Bankgiro via partner.
          </p>
          <p className="text-sm text-muted-foreground">© Nordklart. Org.nr {NORDKLART_ORG_NUMBER}. Alla rättigheter förbehållna.</p>
        </div>

        {footerGroups.map((group) => (
          <div key={group.title}>
            <h3 className="mb-4 text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">{group.title}</h3>
            <ul className="space-y-3 text-sm font-medium">
              {group.links.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="text-muted-foreground transition hover:text-foreground">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </footer>
  )
}
