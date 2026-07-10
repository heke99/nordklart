import Link from 'next/link'
import {
  ArrowRight,
  Banknote,
  Building2,
  CheckCircle2,
  FileCheck2,
  LineChart,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import {
  MarketingChrome,
  marketingPrimaryCta,
  marketingSecondaryCta,
  marketingSectionLabel,
} from '@/components/marketing/MarketingChrome'
import { NORDKLART_LEGAL_NAME, NORDKLART_SHORT_DISCLOSURE } from '@/lib/branding/legal-identity'

const mainPaths = [
  {
    title: 'Automatiserad bokföring',
    eyebrow: 'Huvudflöde',
    description:
      'Koppla bank, fakturor och regler så att Nordklart kan matcha transaktioner, föreslå bokföring och skapa verifikationer med spårbarhet.',
    href: '/register?intent=auto',
    cta: 'Starta automatiserad bokföring',
    icon: Sparkles,
    points: ['Banktransaktioner', 'Fakturamatchning', 'Verifikationsförslag', 'Granskningskö'],
  },
  {
    title: 'Fakturor och betalningar',
    eyebrow: 'Från skickad till betald',
    description:
      'Skapa fakturor, följ betalstatus och låt betalningar kopplas till rätt kund, faktura och bokföringsunderlag.',
    href: '/register?intent=auto',
    cta: 'Kom igång med fakturor',
    icon: FileCheck2,
    points: ['Kundfakturor', 'Betalstatus', 'Momsunderlag', 'Reskontra'],
  },
  {
    title: 'Enbart bokslut',
    eyebrow: 'Separat engångsflöde',
    description:
      'Behöver du bara göra bokslut? Importera SIE, välj räkenskapsår och få kontroller, justeringar och rapportpaket.',
    href: '/register?intent=year_end',
    cta: 'Gör bokslut',
    icon: LineChart,
    points: ['SIE-import', 'Periodiseringar', 'Avskrivningar', 'Exportpaket'],
  },
  {
    title: 'Bankgiro',
    eyebrow: 'Via partner',
    description:
      'Saknar du Bankgiro? Nordklart hjälper dig samla uppgifter, följa ansökan och koppla betalflödet till bokföringen.',
    href: '/register?intent=bankgiro',
    cta: 'Ansök om Bankgiro',
    icon: Banknote,
    points: ['Ansökan', 'Dokument', 'Status', 'Avstämning'],
  },
]

const automationSteps = [
  {
    title: 'Banken synkas',
    body: 'Transaktioner hämtas in och dedupliceras innan de hamnar i granskningsflödet.',
  },
  {
    title: 'Fakturor matchas',
    body: 'Belopp, OCR, motpart och betalstatus jämförs mot kundfakturor och leverantörsunderlag.',
  },
  {
    title: 'Verifikation föreslås',
    body: 'Regler och tidigare mönster skapar bokföringsförslag med tydlig säkerhetsnivå och spårbar historik.',
  },
  {
    title: 'Du godkänner eller låter reglerna arbeta',
    body: 'Säkra träffar kan automatiseras. Osäkra poster hamnar i att-göra-listan för kontroll.',
  },
]

const dashboardItems = [
  { label: 'Automatisering', value: '24 matchade', detail: 'bankhändelser redo för kontroll eller autobokföring' },
  { label: 'Verifikationer', value: '9 förslag', detail: 'med konto, moms och bilaga kopplad' },
  { label: 'Fakturor', value: '7 betalningar', detail: 'matchade mot kundfakturor och reskontra' },
  { label: 'Bankgiro', value: 'Under granskning', detail: 'ansökan följs upp i samma översikt' },
]

const bankgiroStatuses = ['Utkast', 'Inskickad', 'Behöver komplettering', 'Under granskning', 'Godkänd', 'Aktiveras', 'Aktiv']

const allInOneFeatures = [
  'Banktransaktioner matchas mot fakturor och verifikationer',
  'Automatiska förslag skapas med regler, tydlig säkerhetsnivå och spårbar historik',
  'Moms, rapporter och bokslut bygger på samma bokföringsdata',
  'Bankgiro kopplas till betalningar, avstämning och bokföring',
]

export function NordklartPublicDashboard() {
  return (
    <MarketingChrome>
      <main>
        <section className="relative px-5 py-16 md:px-8 md:py-24">
          <div className="absolute inset-x-0 top-0 -z-10 h-[34rem] bg-[radial-gradient(circle_at_20%_0%,hsl(var(--accent)/0.8),transparent_28rem),radial-gradient(circle_at_86%_12%,hsl(var(--secondary)/0.95),transparent_30rem)]" />
          <div className="mx-auto grid max-w-7xl items-center gap-12 lg:grid-cols-[1.05fr_0.95fr]">
            <div className="space-y-8">
              <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-card/80 px-4 py-2 text-sm font-semibold text-primary shadow-sm backdrop-blur">
                <Sparkles className="h-4 w-4" aria-hidden="true" />
                Automatiserad bokföring med mänsklig kontroll
              </div>

              <div className="space-y-5">
                <h1 className="max-w-4xl text-balance font-display text-5xl font-semibold leading-[0.95] tracking-tight text-foreground md:text-7xl">
                  Automatiserad bokföring från bank till verifikation.
                </h1>
                <p className="max-w-2xl text-lg leading-8 text-muted-foreground md:text-xl">
                  Nordklart matchar banktransaktioner, fakturor och regler så att bokföringen går snabbare. Du får verifikationsförslag, tydlig granskning, momsunderlag och rapporter utan att tappa kontrollen.
                </p>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                <Link href="/register?intent=auto" className={marketingPrimaryCta}>
                  Starta automatiserad bokföring <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
                </Link>
                <Link href="/register?intent=auto" className={marketingSecondaryCta}>Automatisera fakturor</Link>
                <Link href="/register?intent=year_end" className={marketingSecondaryCta}>Gör bokslut</Link>
                <Link href="/register?intent=bankgiro" className={marketingSecondaryCta}>Ansök om Bankgiro</Link>
              </div>

              <div className="grid gap-3 text-sm text-muted-foreground sm:grid-cols-2 lg:max-w-2xl">
                {['Automatiserad bokföring', 'Verifikationer med spårbarhet', 'Fakturor och betalstatus', 'Moms, rapporter och bokslut'].map((item) => (
                  <div key={item} className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
                    {item}
                  </div>
                ))}
              </div>

              <p className="max-w-2xl rounded-2xl border border-border bg-card/75 px-4 py-3 text-sm leading-6 text-muted-foreground shadow-sm">
                <span className="font-semibold text-foreground">{NORDKLART_SHORT_DISCLOSURE}</span>{' '}
                Nordklart är system- och produktnamnet, inte ett separat bolag.{' '}
                <Link href="/om-oss" className="font-medium text-primary underline underline-offset-2">
                  Läs om {NORDKLART_LEGAL_NAME} och Nordklart
                </Link>.
              </p>
            </div>

            <DashboardPreview />
          </div>
        </section>

        <section className="px-5 py-12 md:px-8" aria-labelledby="automation-flow">
          <div className="mx-auto max-w-7xl space-y-8">
            <div className="max-w-3xl space-y-3">
              <p className={marketingSectionLabel}>Så fungerar det</p>
              <h2 id="automation-flow" className="text-balance text-3xl font-semibold md:text-5xl">
                Mindre manuell bokföring. Mer kontroll på det som faktiskt behöver granskas.
              </h2>
              <p className="text-lg leading-8 text-muted-foreground">
                Nordklart ska inte bara lagra bokföring. Systemet hjälper till att göra arbetet: läsa bankhändelser, matcha fakturor, föreslå konton och skapa verifikationer när reglerna är säkra.
              </p>
            </div>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {automationSteps.map((step, index) => (
                <article key={step.title} className="rounded-[2rem] border border-border bg-card/90 p-6 shadow-sm">
                  <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-sm font-bold text-primary">
                    {index + 1}
                  </span>
                  <h3 className="mt-5 text-xl font-semibold tracking-tight">{step.title}</h3>
                  <p className="mt-3 leading-7 text-muted-foreground">{step.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="px-5 py-12 md:px-8" aria-labelledby="valj-behov">
          <div className="mx-auto max-w-7xl space-y-8">
            <div className="max-w-3xl space-y-3">
              <p className={marketingSectionLabel}>Välj väg</p>
              <h2 id="valj-behov" className="text-balance text-3xl font-semibold md:text-5xl">
                Börja med automatisering – eller välj den del du behöver nu.
              </h2>
              <p className="text-lg leading-8 text-muted-foreground">
                Automatiserad bokföring är huvudspåret. Bokslut, Bankgiro och allt-i-ett finns kvar som tydliga flöden för företag och redovisningsbyråer.
              </p>
            </div>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {mainPaths.map((path) => {
                const Icon = path.icon
                return (
                  <article key={path.title} className="group flex min-h-full flex-col rounded-[2rem] border border-border bg-card/88 p-6 shadow-sm transition hover:-translate-y-1 hover:shadow-lg">
                    <div className="mb-5 flex items-center justify-between gap-4">
                      <span className="rounded-full bg-secondary px-3 py-1 text-xs font-semibold text-secondary-foreground">{path.eyebrow}</span>
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

        <section id="allt-i-ett" className="px-5 py-14 md:px-8">
          <div className="mx-auto max-w-7xl rounded-[2.5rem] bg-primary p-6 text-primary-foreground shadow-lg md:p-10">
            <div className="grid gap-10 lg:grid-cols-[0.95fr_1.05fr] lg:items-center">
              <div className="space-y-5">
                <p className="text-sm font-semibold uppercase tracking-[0.22em] text-primary-foreground/75">Allt i ett</p>
                <h2 className="text-balance text-3xl font-semibold md:text-5xl">
                  Automatisera bokföring, fakturor, Bankgiro och bokslut i samma kedja.
                </h2>
                <p className="text-lg leading-8 text-primary-foreground/82">
                  När allt hänger ihop slipper du dubbelarbete: transaktioner matchas, fakturor följs upp, verifikationer skapas och bokslutet bygger på samma data.
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

        <section id="bokslut" className="px-5 py-14 md:px-8">
          <div className="mx-auto grid max-w-7xl gap-8 rounded-[2.25rem] border border-border bg-card/90 p-6 shadow-md md:p-10 lg:grid-cols-[0.9fr_1.1fr]">
            <div className="space-y-5">
              <p className={marketingSectionLabel}>Enbart bokslut</p>
              <h2 className="text-balance text-3xl font-semibold md:text-5xl">Behöver du bara göra bokslut?</h2>
              <p className="text-lg leading-8 text-muted-foreground">
                Du behöver inte byta hela bokföringssystemet. Importera SIE, välj räkenskapsår och gå igenom bokslutskontroller, periodiseringar, justeringar och rapportpaket i Nordklart.
              </p>
              <Link href="/register?intent=year_end" className={marketingPrimaryCta}>
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
              <p className={marketingSectionLabel}>Bankgiro via partner</p>
              <h2 className="text-balance text-3xl font-semibold md:text-5xl">Saknar du Bankgiro?</h2>
              <p className="text-lg leading-8 text-muted-foreground">
                Nordklart hjälper dig att samla in bolagsuppgifter, ägarinformation och dokument för ansökan via partner. När Bankgiro är aktivt kan det kopplas till betalningar, avstämning och bokföring.
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
                <Link href="/register?intent=bankgiro" className={marketingPrimaryCta}>
                  Ansök om Bankgiro <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
                </Link>
                <Link href="/register?intent=all-in-one" className={marketingSecondaryCta}>Koppla med bokföring</Link>
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
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">{index + 1}</span>
                    <span className="font-semibold">{status}</span>
                  </li>
                ))}
              </ol>
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
                  <h3 className="text-2xl font-semibold">Automatisering per kundbolag</h3>
                </div>
              </div>
              <div className="space-y-3">
                {['Transaktioner att granska', 'Fakturor att matcha', 'Bokslut pågår', 'Bankgirostatus väntar'].map((item, index) => (
                  <div key={item} className="flex items-center justify-between rounded-2xl bg-background/75 p-4">
                    <span className="font-medium">{item}</span>
                    <span className="rounded-full bg-secondary px-3 py-1 text-xs font-semibold text-secondary-foreground">{index + 2} bolag</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-5">
              <p className={marketingSectionLabel}>För redovisningsbyråer</p>
              <h2 className="text-balance text-3xl font-semibold md:text-5xl">Automatisera återkommande arbete för flera kundbolag.</h2>
              <p className="text-lg leading-8 text-muted-foreground">
                Byråer kan samla kundbolag, ansvariga konsulter, deadlines, moms, bokslut, fakturor och betalstatus på en tydlig översikt. Kunden kan arbeta i sitt bolag medan byrån behåller kontroll.
              </p>
              <Link href="/register?intent=agency" className={marketingSecondaryCta}>Boka byrådemo</Link>
            </div>
          </div>
        </section>

        <section className="px-5 py-14 md:px-8">
          <div className="mx-auto max-w-7xl rounded-[2.5rem] border border-border bg-card/90 p-6 text-center shadow-md md:p-12">
            <p className={marketingSectionLabel}>Nästa steg</p>
            <h2 className="mx-auto mt-3 max-w-3xl text-balance text-3xl font-semibold md:text-5xl">
              Vill du automatisera bokföringen från början?
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-lg leading-8 text-muted-foreground">
              Starta med bank, fakturor och verifikationsförslag – eller välj bokslut, Bankgiro eller allt i ett när det passar.
            </p>
            <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row sm:flex-wrap">
              <Link href="/register?intent=auto" className={marketingPrimaryCta}>Starta automatiserad bokföring</Link>
              <Link href="/register?intent=auto" className={marketingSecondaryCta}>Automatisera fakturor</Link>
              <Link href="/register?intent=year_end" className={marketingSecondaryCta}>Gör bokslut</Link>
              <Link href="/register?intent=bankgiro" className={marketingSecondaryCta}>Ansök om Bankgiro</Link>
            </div>
          </div>
        </section>
      </main>
    </MarketingChrome>
  )
}

function DashboardPreview() {
  return (
    <div className="relative rounded-[2.25rem] border border-border bg-card/92 p-4 shadow-lg backdrop-blur md:p-5">
      <div className="rounded-[1.8rem] border border-border bg-background/75 p-5">
        <div className="mb-6 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-primary">Nordklart automation</p>
            <h2 className="mt-1 text-2xl font-semibold">Dagens bokföringsflöde</h2>
          </div>
          <span className="rounded-full bg-success/10 px-3 py-1 text-xs font-semibold text-success">Exempelvy</span>
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
