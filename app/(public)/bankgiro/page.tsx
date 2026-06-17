import Link from 'next/link'
import { ArrowRight, Banknote, CheckCircle2, ShieldCheck } from 'lucide-react'
import { MarketingChrome, marketingPrimaryCta, marketingSecondaryCta, marketingSectionLabel } from '@/components/marketing/MarketingChrome'

const steps = ['Bolagsuppgifter', 'Ägare och användning', 'Dokument', 'Superadmin review', 'Provider setup', 'Aktiv betalmodul']

export default function BankgiroMarketingPage() {
  return (
    <MarketingChrome>
      <main className="px-5 py-16 md:px-8 md:py-24">
        <section className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[1fr_0.9fr] lg:items-center">
          <div className="space-y-7">
            <p className={marketingSectionLabel}>Bankgiro / Autogiro via partner</p>
            <h1 className="max-w-4xl text-balance font-display text-5xl font-semibold leading-[0.95] tracking-tight md:text-7xl">
              Bankgiro som separat flöde, kopplat till bokföringen när det är aktivt.
            </h1>
            <p className="max-w-2xl text-lg leading-8 text-muted-foreground md:text-xl">
              Nordklart hjälper bolaget samla rätt uppgifter, följa ansökan och senare koppla betalningar, mandat och avstämning till bokföringen. Vanlig bokföring kan starta utan Bankgiro.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Link href="/register?intent=bankgiro" className={marketingPrimaryCta}>Ansök om Bankgiro <ArrowRight className="ml-2 h-4 w-4" /></Link>
              <Link href="/register?intent=automated-bookkeeping" className={marketingSecondaryCta}>Starta bokföring först</Link>
            </div>
          </div>
          <div className="rounded-[2rem] border bg-card p-6 shadow-md">
            <div className="mb-6 flex items-center gap-3">
              <Banknote className="h-8 w-8 text-primary" />
              <div>
                <p className="text-sm font-semibold text-primary">Ansökningskedja</p>
                <h2 className="text-2xl font-semibold">Från utkast till aktivt flöde</h2>
              </div>
            </div>
            <ol className="space-y-3">
              {steps.map((step, index) => (
                <li key={step} className="flex items-center gap-3 rounded-2xl border bg-background/70 p-3">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">{index + 1}</span>
                  <span className="font-semibold">{step}</span>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="mx-auto mt-16 grid max-w-7xl gap-4 md:grid-cols-3">
          {[
            ['Separat onboarding', 'Bankgiro är ett tillägg och blockerar inte vanlig bokföring.'],
            ['Provider-modell', 'GoCardless, Leslie, filimport eller framtida partner kan kopplas utan att kärnan hårdkodas.'],
            ['Avstämning', 'Mandat, collections och betalningar kan matchas mot fakturor och bokföringsunderlag.'],
          ].map(([title, body]) => (
            <article key={title} className="rounded-[2rem] border bg-card/90 p-6 shadow-sm">
              <ShieldCheck className="mb-5 h-6 w-6 text-primary" />
              <h3 className="text-2xl font-semibold">{title}</h3>
              <p className="mt-3 leading-7 text-muted-foreground">{body}</p>
            </article>
          ))}
        </section>

        <section className="mx-auto mt-16 max-w-7xl rounded-[2.5rem] bg-primary p-6 text-primary-foreground shadow-lg md:p-10">
          <h2 className="text-balance text-3xl font-semibold md:text-5xl">Bokföring först. Bankgiro när bolaget behöver det.</h2>
          <div className="mt-6 grid gap-3 md:grid-cols-2">
            {['Bokföring direkt kräver inte Bankgiro', 'Ansökan kan granskas av superadmin', 'Dokument och ägarfrågor sparas separat', 'Aktiva betalningar kan stämmas av mot fakturor'].map((item) => (
              <div key={item} className="flex items-center gap-3 rounded-2xl bg-primary-foreground/10 p-4 font-semibold">
                <CheckCircle2 className="h-5 w-5" />
                {item}
              </div>
            ))}
          </div>
        </section>
      </main>
    </MarketingChrome>
  )
}
