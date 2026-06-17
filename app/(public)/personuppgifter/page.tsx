import type { Metadata } from 'next'
import { MarketingInfoPage } from '@/components/marketing/MarketingInfoPage'

export const metadata: Metadata = {
  title: 'Personuppgifter – Nordklart',
  description: 'Information om personuppgiftsansvar, biträde, rättigheter och kontaktvägar i Nordklart.',
}

export default function PersonuppgifterPage() {
  return (
    <MarketingInfoPage
      eyebrow="Personuppgifter"
      title="Personuppgifter och dataskydd"
      description="Den här sidan sammanfattar hur personuppgifter hanteras i Nordklart och hur du kan begära åtkomst, rättelse, export eller radering."
      sections={[
        {
          title: 'Ansvar och roller',
          body: 'Beroende på kundens användning kan Nordklart agera leverantör, personuppgiftsbiträde eller självständig ansvarig för vissa administrativa uppgifter.',
        },
        {
          title: 'Bokföringsdata',
          body: 'Bokföringsunderlag och historiska affärshändelser kan behöva sparas enligt bokföringsregler även om ett konto avslutas.',
          points: ['Lagstadgad lagring kan gälla', 'Radering kan begränsas av bokföringskrav', 'Export ska kunna begäras när det är möjligt'],
        },
        {
          title: 'Bankgiroflöden',
          body: 'Vid Bankgiroansökan kan uppgifter om bolag, firmatecknare och verklig huvudman behöva delas med partner för granskning och aktivering.',
        },
        {
          title: 'Kontakt',
          body: 'Kontakta Nordklart om du vill begära information, rättelse, export eller annan hantering av personuppgifter.',
        },
      ]}
    />
  )
}
