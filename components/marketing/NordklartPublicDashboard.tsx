import Link from 'next/link'
import {
  ArrowRight,
  Banknote,
  Building2,
  CheckCircle2,
  FileCheck2,
  Layers3,
  LineChart,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { BrandWordmark } from '@/components/branding/BrandWordmark'

const primaryCta =
  'inline-flex items-center justify-center rounded-full bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground shadow-md transition hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background'

const secondaryCta =
  'inline-flex items-center justify-center rounded-full border border-border bg-card/80 px-5 py-3 text-sm font-semibold text-foreground shadow-sm transition hover:-translate-y-0.5 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background'

const sectionLabel = 'text-sm font-semibold uppercase tracking-[0.22em] text-primary'

const paths = [
  {
    title: 'Bokföring',
    eyebrow: 'För löpande arbete',
    description: 'Sköt verifikationer, fakturor, moms och rapporter i ett svenskt system byggt runt BAS och tydliga kontroller.',
    href: '/register?intent=bookkeeping',
    cta: 'Starta bokföring',
    icon: LineChart,
    points: ['BAS-konton', 'Momsrapport', 'Resultat och balans', 'SIE-import/export'],
  },
  {
    title: 'Enbart bokslut',
    eyebrow: 'Engångsflöde',
    description: 'Behöver du bara göra bokslut? Importera SIE, välj räkenskapsår och få kontroller, justeringar och rapportpaket.',
    href: '/register?intent=year-end',
    cta: 'Gör bokslut',
    icon: FileCheck2,
    points: ['SIE-import', 'Periodiseringar', 'Avskrivningar', 'Exportpaket'],
  },
  {
    title: 'Bankgiro',
    eyebrow: 'Via Leslie/partner',
    description: 'Saknar du Bankgiro? Nordklart hjälper dig samla uppgifter, följa ansökan och koppla betalflödet till bokföringen.',
    href: '/register?intent=bankgiro',
    cta: 'Ansök om Bankgiro',
    icon: Banknote,
    points: ['Ansökan', 'Dokument', 'Status', 'Avstämning'],
  },
  {
    title: 'Allt i ett',
    eyebrow: 'Komplett paket',
    description: 'Använd bokföring, bokslut, bankkoppling och Bankgiro i ett sammanhängande flöde när du vill ha hela kedjan på plats.',
    href: '/register?intent=all-in-one',
    cta: 'Kom igång med allt',
    icon: Layers3,
    points: ['Bokföring', 'Bokslut', 'Bankgiro', 'Rapporter'],
  },
]

const bankgiroStatuses = [
  'Utkast',
  'Inskickad',
  'Behöver komplettering',
  'Under granskning',
  'Godkänd',
  'Aktiveras',
  'Aktiv',
]

const dashboardItems = [
  { label: 'Bokföring', value: '18 transaktioner', detail: 'att granska innan momsperioden stängs' },
  { label: 'Bokslut', value: '68% klart', detail: '4 kontroller kvar för räkenskapsåret' },
  { label: 'Bankgiro', value: 'Under granskning', detail: '1 dokument behöver kompletteras' },
  { label: 'Byrå', value: '3 kundbolag', detail: 'har åtgärder som väntar' },
]

const allInOneFeatures = [
  'Banktransaktioner kan matchas mot fakturor och verifikationer',
  'Bokslutet använder samma bokföringsdata och audit-spår',
  'Bankgirostatus syns tillsammans med betalningar och avstämning',
  'Byråer kan följa kundernas arbete från en gemensam översikt',
]

export function NordklartPublicDashboard() {
  return (
    <div className="min-h-screen overflow-hidden bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 md:px-8">
          <Link href="/dashboard" aria-label="Nordklart dashboard" className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary text-sm font-bold text-primary-foreground shadow-sm">
              N
            </span>
            <BrandWordmark size="inline" lowercase={false} className="text-xl" />
          </Link>

          <nav className="hidden items-center gap-7 text-sm font-medium text-muted-foreground lg:flex" aria-label="Huvudmeny">
            <a className="transition hover:text-foreground" href="#bokforing">Bokföring</a>
            <a className="transition hover:text-foreground" href="#bokslut">Bokslut</a>
            <a className="transition hover:text-foreground" href="#bankgiro">Bankgiro</a>
            <a className="transition hover:text-foreground" href="#allt-i-ett">Allt i ett</a>
            <a className="transition hover:text-foreground" href="#byra">Byrå</a>
          </nav>

          <div className="flex items-center gap-2">
            <Link href="/login" className="hidden rounded-full px-4 py-2 text-sm font-semibold text-muted-foreground transition hover:text-foreground sm:inline-flex">
              Logga in
            </Link>
            <Link href="/register" className="rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
              Starta
            </Link>
          </div>
        </div>
      </header>

      <main>
        <section className="relative px-5 py-16 md:px-8 md:py-24">
          <div className="absolute inset-x-0 top-0 -z-10 h-[34rem] bg-[radial-gradient(circle_at_20%_0%,hsl(var(--accent)/0.8),transparent_28rem),radial-gradient(circle_at_86%_12%,hsl(var(--secondary)/0.95),transparent_30rem)]" />
          <div className="mx-auto grid max-w-7xl items-center gap-12 lg:grid-cols-[1.05fr_0.95fr]">
            <div className="space-y-8">
              <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-card/80 px-4 py-2 text-sm font-semibold text-primary shadow-sm backdrop-blur">
                <Sparkles className="h-4 w-4" aria-hidden="true" />
                Välj en del – eller samla allt i ett
              </div>

              <div className="space-y-5">
                <h1 className="max-w-4xl text-balance font-display text-5xl font-semibold leading-[0.95] tracking-tight text-foreground md:text-7xl">
                  Bokföring, bokslut och Bankgiro – tydligt från start.
                </h1>
                <p className="max-w-2xl text-lg leading-8 text-muted-foreground md:text-xl">
                  Nordklart hjälper svenska företag och redovisningsbyråer att sköta löpande bokföring, göra enbart bokslut eller få hjälp med Bankgiro via partner. Du väljer själv om du vill börja med en del eller ha hela kedjan kopplad.
                </p>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                <Link href="/register?intent=bookkeeping" className={primaryCta}>
                  Starta bokföring <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
                </Link>
                <Link href="/register?intent=year-end" className={secondaryCta}>
                  Gör enbart bokslut
                </Link>
                <Link href="/register?intent=bankgiro" className={secondaryCta}>
                  Ansök om Bankgiro
                </Link>
              </div>

              <div className="grid gap-3 text-sm text-muted-foreground sm:grid-cols-2 lg:max-w-2xl">
                {['BAS-kontoplan', 'Momsrapport', 'SIE-import/export', 'Bankgiro via partner'].map((item) => (
                  <div key={item} className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
                    {item}
                  </div>
                ))}
              </div>
            </div>

            <DashboardPreview />
          </div>
        </section>

        <section className="px-5 py-12 md:px-8" aria-labelledby="valj-behov">
          <div className="mx-auto max-w-7xl space-y-8">
            <div className="max-w-3xl space-y-3">
              <p className={sectionLabel}>Vad behöver du?</p>
              <h2 id="valj-behov" className="text-balance text-3xl font-semibold md:text-5xl">
                Starta där behovet är störst.
              </h2>
              <p className="text-lg leading-8 text-muted-foreground">
                Nordklart är byggt för att du ska kunna välja rätt väg direkt: löpande bokföring, ett fristående bokslut, Bankgiroansökan eller hela systemet samlat.
              </p>
            </div>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {paths.map((path) => {
                const Icon = path.icon
                return (
                  <article key={path.title} id={path.title === 'Bokföring' ? 'bokforing' : undefined} className="group flex min-h-full flex-col rounded-[2rem] border border-border bg-card/88 p-6 shadow-sm transition hover:-translate-y-1 hover:shadow-lg">
                    <div className="mb-5 flex items-center justify-between gap-4">
                      <span className="rounded-full bg-secondary px-3 py-1 text-xs font-semibold text-secondary-foreground">
                        {path.eyebrow}
                      </span>
                      <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                        <Icon className="h-5 w-5" aria-hidden="true" />
                      </span>
                    </div>
                    <h3 className="text-2xl font-semibold tracking-tight">{path.title}</h3>
                    <p className="mt-3 flex-1 leading-7 text-muted-foreground">{path.description}</p>
                    <ul className="mt-6 space-y-2 text-sm text-muted-foreground">
                      {path.points.map((point) => (
                        <li key={point} className="flex items-center gap-2">
                          <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
                          {point}
                        </li>
                      ))}
                    </ul>
                    <Link href={path.href} className="mt-7 inline-flex items-center text-sm font-semibold text-primary">
                      {path.cta} <ArrowRight className="ml-2 h-4 w-4 transition group-hover:translate-x-1" aria-hidden="true" />
                    </Link>
                  </article>
                )
              })}
            </div>
          </div>
        </section>

        <section id="bokslut" className="px-5 py-14 md:px-8">
          <div className="mx-auto grid max-w-7xl gap-8 rounded-[2.25rem] border border-border bg-card/90 p-6 shadow-md md:p-10 lg:grid-cols-[0.9fr_1.1fr]">
            <div className="space-y-5">
              <p className={sectionLabel}>Enbart bokslut</p>
              <h2 className="text-balance text-3xl font-semibold md:text-5xl">Behöver du bara göra bokslut?</h2>
              <p className="text-lg leading-8 text-muted-foreground">
                Du behöver inte byta hela bokföringssystemet. Importera SIE, välj räkenskapsår och gå igenom bokslutskontroller, periodiseringar, justeringar och rapportpaket i Nordklart.
              </p>
              <Link href="/register?intent=year-end" className={primaryCta}>
                Starta bokslut <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
              </Link>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {['SIE-import från befintlig bokföring', 'Bokslutskontroller per räkenskapsår', 'Periodiseringar och avskrivningar', 'Resultat, balans och exportpaket', 'Underlag för årsredovisning', 'Kan köpas som separat bokslutsflöde'].map((item) => (
                <div key={item} className="rounded-3xl border border-border bg-background/70 p-5">
                  <CheckCircle2 className="mb-4 h-5 w-5 text-success" aria-hidden="true" />
                  <p className="font-semibold leading-6">{item}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="bankgiro" className="px-5 py-14 md:px-8">
          <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
            <div className="space-y-6">
              <p className={sectionLabel}>Bankgiro via partner</p>
              <h2 className="text-balance text-3xl font-semibold md:text-5xl">Saknar du Bankgiro?</h2>
              <p className="text-lg leading-8 text-muted-foreground">
                Nordklart hjälper dig att samla in bolagsuppgifter, ägare, dokument och volymuppgifter och följa ansökan via Leslie/partnerflöde. När Bankgiro är aktivt kan det kopplas till betalningar, avstämning och bokföring.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {['Inbetalningar kan följas upp', 'Betalningar kan matchas mot fakturor', 'Avstämning blir enklare', 'Bokföringen får bättre underlag'].map((item) => (
                  <div key={item} className="flex items-center gap-3 rounded-2xl border border-border bg-card/80 px-4 py-3 text-sm font-semibold">
                    <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
                    {item}
                  </div>
                ))}
              </div>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Link href="/register?intent=bankgiro" className={primaryCta}>
                  Ansök om Bankgiro <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
                </Link>
                <Link href="/register?intent=all-in-one" className={secondaryCta}>
                  Koppla med bokföring
                </Link>
              </div>
            </div>

            <div className="rounded-[2rem] border border-border bg-card p-6 shadow-md">
              <div className="mb-5 flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold text-primary">Ansökningsflöde</p>
                  <h3 className="mt-1 text-2xl font-semibold">Från saknat Bankgiro till aktivt flöde</h3>
                </div>
                <Banknote className="h-8 w-8 text-primary" aria-hidden="true" />
              </div>
              <ol className="space-y-3">
                {bankgiroStatuses.map((status, index) => (
                  <li key={status} className="flex items-center gap-3 rounded-2xl border border-border bg-background/70 p-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                      {index + 1}
                    </span>
                    <span className="font-semibold">{status}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        <section id="allt-i-ett" className="px-5 py-14 md:px-8">
          <div className="mx-auto max-w-7xl rounded-[2.5rem] bg-primary p-6 text-primary-foreground shadow-lg md:p-10">
            <div className="grid gap-10 lg:grid-cols-[0.95fr_1.05fr] lg:items-center">
              <div className="space-y-5">
                <p className="text-sm font-semibold uppercase tracking-[0.22em] text-primary-foreground/75">Allt i ett</p>
                <h2 className="text-balance text-3xl font-semibold md:text-5xl">Vill du ha hela kedjan samlad?</h2>
                <p className="text-lg leading-8 text-primary-foreground/82">
                  Använd Nordklart som ett komplett system där bokföring, banktransaktioner, bokslut, Bankgiro, rapporter och byråarbete hänger ihop från början.
                </p>
                <Link href="/register?intent=all-in-one" className="inline-flex items-center justify-center rounded-full bg-primary-foreground px-5 py-3 text-sm font-semibold text-primary shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
                  Starta med allt i ett <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
                </Link>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {allInOneFeatures.map((item) => (
                  <div key={item} className="rounded-3xl border border-primary-foreground/18 bg-primary-foreground/10 p-5">
                    <CheckCircle2 className="mb-4 h-5 w-5" aria-hidden="true" />
                    <p className="font-semibold leading-6">{item}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section id="byra" className="px-5 py-14 md:px-8">
          <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
            <div className="rounded-[2rem] border border-border bg-card p-6 shadow-md">
              <div className="mb-6 flex items-center gap-3">
                <Building2 className="h-7 w-7 text-primary" aria-hidden="true" />
                <div>
                  <p className="text-sm font-semibold text-primary">Byråöversikt</p>
                  <h3 className="text-2xl font-semibold">Kundbolag i kontroll</h3>
                </div>
              </div>
              <div className="space-y-3">
                {['Moms klar att kontrollera', 'Bokslut pågår', 'Bankgirostatus väntar', 'Transaktioner att granska'].map((item, index) => (
                  <div key={item} className="flex items-center justify-between rounded-2xl bg-background/75 p-4">
                    <span className="font-medium">{item}</span>
                    <span className="rounded-full bg-secondary px-3 py-1 text-xs font-semibold text-secondary-foreground">{index + 2} bolag</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-5">
              <p className={sectionLabel}>För redovisningsbyråer</p>
              <h2 className="text-balance text-3xl font-semibold md:text-5xl">Se bokföring, bokslut och Bankgirostatus per kund.</h2>
              <p className="text-lg leading-8 text-muted-foreground">
                Byråer kan samla kundbolag, ansvariga konsulter, deadlines, moms, bokslut och betalstatus på en tydlig översikt. Kunden kan arbeta i sitt bolag, medan byrån behåller kontroll.
              </p>
              <Link href="/register?intent=agency" className={secondaryCta}>
                Boka byrådemo
              </Link>
            </div>
          </div>
        </section>

        <section className="px-5 py-14 md:px-8">
          <div className="mx-auto max-w-7xl rounded-[2.5rem] border border-border bg-card/90 p-6 text-center shadow-md md:p-12">
            <p className={sectionLabel}>Nästa steg</p>
            <h2 className="mx-auto mt-3 max-w-3xl text-balance text-3xl font-semibold md:text-5xl">Vad vill du göra först?</h2>
            <p className="mx-auto mt-4 max-w-2xl text-lg leading-8 text-muted-foreground">
              Börja med bokföring, gör ett fristående bokslut, ansök om Bankgiro – eller koppla ihop allt i ett flöde.
            </p>
            <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row sm:flex-wrap">
              <Link href="/register?intent=bookkeeping" className={primaryCta}>Starta bokföring</Link>
              <Link href="/register?intent=year-end" className={secondaryCta}>Gör bokslut</Link>
              <Link href="/register?intent=bankgiro" className={secondaryCta}>Ansök om Bankgiro</Link>
              <Link href="/register?intent=all-in-one" className={secondaryCta}>Allt i ett</Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border bg-card/80 px-5 py-12 md:px-8">
        <div className="mx-auto grid max-w-7xl gap-10 md:grid-cols-[1.4fr_repeat(3,1fr)]">
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary text-sm font-bold text-primary-foreground">N</span>
              <BrandWordmark size="inline" lowercase={false} className="text-xl" />
            </div>
            <p className="max-w-sm leading-7 text-muted-foreground">
              Svensk bokföring, fristående bokslut och Bankgiro via partner – byggt för företag och redovisningsbyråer.
            </p>
            <p className="text-sm text-muted-foreground">© Nordklart. Alla rättigheter förbehållna.</p>
          </div>

          <FooterColumn title="Produkt" links={['Bokföring', 'Bokslut', 'Bankgiro', 'Allt i ett']} />
          <FooterColumn title="Kom igång" links={['Starta bokföring', 'Gör bokslut', 'Ansök om Bankgiro', 'Boka demo']} />
          <FooterColumn title="Juridik" links={['Integritetspolicy', 'Villkor', 'Personuppgifter', 'Cookies']} />
        </div>
      </footer>
    </div>
  )
}

function DashboardPreview() {
  return (
    <div className="relative rounded-[2.25rem] border border-border bg-card/92 p-4 shadow-lg backdrop-blur md:p-5">
      <div className="rounded-[1.8rem] border border-border bg-background/75 p-5">
        <div className="mb-6 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-primary">Nordklart översikt</p>
            <h2 className="mt-1 text-2xl font-semibold">Allt som behöver åtgärdas</h2>
          </div>
          <span className="rounded-full bg-success/10 px-3 py-1 text-xs font-semibold text-success">Liveflöde</span>
        </div>

        <div className="grid gap-3">
          {dashboardItems.map((item) => (
            <div key={item.label} className="rounded-3xl border border-border bg-card p-4 shadow-sm">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">{item.label}</p>
                  <p className="mt-2 text-2xl font-semibold tracking-tight">{item.value}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{item.detail}</p>
                </div>
                <CheckCircle2 className="mt-1 h-5 w-5 text-success" aria-hidden="true" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function FooterColumn({ title, links }: { title: string; links: string[] }) {
  return (
    <div>
      <h3 className="mb-4 text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">{title}</h3>
      <ul className="space-y-3 text-sm font-medium text-foreground">
        {links.map((link) => (
          <li key={link}>
            <a href="#" className="text-muted-foreground transition hover:text-foreground">
              {link}
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}
