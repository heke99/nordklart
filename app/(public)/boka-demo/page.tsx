import type { Metadata } from 'next'
import Link from 'next/link'
import { MarketingInfoPage } from '@/components/marketing/MarketingInfoPage'
import { marketingPrimaryCta, marketingSecondaryCta } from '@/components/marketing/MarketingChrome'

export const metadata: Metadata = {
  title: 'Boka demo av Nordklart',
  description: 'Boka demo för bokföring, bokslut, Bankgiro eller byråläge i Nordklart.',
}

export default function BokaDemoPage() {
  return (
    <MarketingInfoPage
      eyebrow="Boka demo"
      title="Se hur Nordklart passar ditt flöde."
      description="Vi visar hur du kan börja med bokföring, göra enbart bokslut, ansöka om Bankgiro eller samla allt i ett system."
      highlights={['För företag', 'För redovisningsbyråer', 'För bokslut som engångsflöde', 'För Bankgiro via partner']}
      sections={[
        {
          title: 'Demo för företag',
          body: 'Passar dig som vill förstå hur bokföring, fakturor, moms, bokslut och Bankgiro kan kopplas ihop.',
          points: ['Löpande bokföring', 'Fristående bokslut', 'Bankgiro och avstämning'],
        },
        {
          title: 'Demo för byrå',
          body: 'Passar byråer som vill se kundbolag, granskningsköer, deadlines och bokslutsstatus i ett tydligare arbetsflöde.',
          points: ['Kundöversikt', 'Teamroller', 'Deadlines och status'],
        },
      ]}
    >
      <section className="px-5 pb-16 text-center md:px-8">
        <div className="mx-auto max-w-3xl rounded-[2rem] border border-border bg-card/90 p-8 shadow-sm">
          <h2 className="text-3xl font-semibold">Redo att prata?</h2>
          <p className="mt-3 leading-7 text-muted-foreground">Mejla oss med vad du vill se: bokföring, bokslut, Bankgiro, byrå eller allt i ett.</p>
          <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
            <a href="mailto:hej@nordklart.se?subject=Boka%20demo%20av%20Nordklart" className={marketingPrimaryCta}>Mejla för demo</a>
            <Link href="/kontakt" className={marketingSecondaryCta}>Kontakta oss</Link>
          </div>
        </div>
      </section>
    </MarketingInfoPage>
  )
}
