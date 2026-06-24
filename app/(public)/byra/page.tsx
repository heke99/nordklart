import type { Metadata } from 'next'
import { MarketingInfoPage } from '@/components/marketing/MarketingInfoPage'

export const metadata: Metadata = {
  title: 'Nordklart för redovisningsbyråer',
  description: 'Hantera kundbolag, deadlines, moms, bokslut och Bankgirostatus i en tydlig byråöversikt.',
}

export default function ByraPage() {
  return (
    <MarketingInfoPage
      eyebrow="Redovisningsbyrå"
      title="En tydlig översikt för alla kundbolag."
      description="Nordklart hjälper byråer att se vad som behöver göras per kund: transaktioner, moms, bokslut, deadlines och Bankgirostatus."
      primaryCta={{ label: 'Boka byrådemo', href: '/boka-demo?intent=agency' }}
      secondaryCta={{ label: 'Se priser', href: '/priser' }}
      highlights={['Kundbolag och ansvarig konsult', 'Granskningskö och deadlines', 'Moms- och bokslutsstatus', 'Bankgirostatus per kund']}
      sections={[
        {
          title: 'Byrån ser helheten',
          body: 'Istället för att leta per kund ska byrån snabbt se vilka bolag som behöver åtgärd och vem som ansvarar för nästa steg.',
          points: ['Kundlista med status', 'Ansvarig konsult', 'Kommande deadlines'],
        },
        {
          title: 'Kunden kan arbeta separat',
          body: 'Kundbolaget ska bara se sin egen data medan byrån får rätt åtkomst till de kunder den arbetar med.',
          points: ['Rollstyrd åtkomst', 'Läsbehörighet för revisor', 'Tydlig separation mellan bolag'],
        },
      ]}
    />
  )
}
