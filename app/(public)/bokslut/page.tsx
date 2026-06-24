import type { Metadata } from 'next'
import { MarketingInfoPage } from '@/components/marketing/MarketingInfoPage'

export const metadata: Metadata = {
  title: 'Gör bokslut i Nordklart',
  description: 'Gör enbart bokslut via SIE-import eller använd Nordklart som komplett bokslutsflöde.',
}

export default function BokslutPage() {
  return (
    <MarketingInfoPage
      eyebrow="Bokslut"
      title="Gör enbart bokslut – utan att byta hela systemet."
      description="Importera SIE, välj räkenskapsår och gå igenom bokslutskontroller, periodiseringar, avskrivningar och rapportpaket i Nordklart."
      primaryCta={{ label: 'Gör bokslut', href: '/register?intent=year-end' }}
      secondaryCta={{ label: 'Se allt i ett', href: '/register?intent=all-in-one' }}
      highlights={['Kan användas som separat bokslutsflöde', 'SIE-import från befintlig bokföring', 'Kontroller och justeringar', 'Rapport- och exportpaket']}
      sections={[
        {
          title: 'När du bara behöver bokslut',
          body: 'Du ska inte behöva flytta hela bokföringen för att få ordning på årsslutet. Nordklart kan starta från SIE och fokusera på bokslutsarbetet.',
          points: ['Välj räkenskapsår', 'Importera underlag', 'Följ kontroller steg för steg'],
        },
        {
          title: 'När bokslut är del av allt',
          body: 'Om du använder hela Nordklart kan bokslutet bygga direkt på samma bokföringsdata, spårbar historik, periodiseringar och rapporter.',
          points: ['Samma data från bokföringen', 'Mindre dubbelarbete', 'Tydlig status för byrå och kund'],
        },
      ]}
    />
  )
}
