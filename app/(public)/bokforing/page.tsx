import type { Metadata } from 'next'
import { MarketingInfoPage } from '@/components/marketing/MarketingInfoPage'

export const metadata: Metadata = {
  title: 'Automatiserad bokföring i Nordklart',
  description: 'Automatisera banktransaktioner, fakturor, verifikationer, moms och rapporter i ett svenskt bokföringssystem.',
}

export default function BokforingPage() {
  return (
    <MarketingInfoPage
      eyebrow="Bokföring"
      title="Automatiserad bokföring som håller ihop reglerna."
      description="Nordklart hjälper dig att matcha banktransaktioner, fakturor och regler så att verifikationer kan föreslås snabbare utan att tappa kontrollen över BAS-konton, moms och spårbarhet."
      primaryCta={{ label: 'Starta automatiserad bokföring', href: '/register?intent=automated-bookkeeping' }}
      secondaryCta={{ label: 'Boka demo', href: '/boka-demo?intent=automated-bookkeeping' }}
      highlights={['Automatiska verifikationsförslag', 'Fakturor och betalningsmatchning', 'Momsrapport, resultat och balans', 'SIE-import och export']}
      sections={[
        {
          title: 'Automation med svensk bokföringskontroll',
          body: 'Nordklart automatiserar där reglerna är säkra, men utgår fortfarande från BAS-kontoplan, räkenskapsår, momsperioder och tydliga kontroller innan något låses.',
          points: ['Banktransaktioner kan matchas mot fakturor', 'Verifikationsförslag med debet, kredit och moms', 'Låsta perioder och rättningsspår bevaras'],
        },
        {
          title: 'Från faktura och bank till verifikation',
          body: 'Fakturor, betalningar, bankhändelser, verifikationer och rapporter hänger ihop så att du slipper dubbelarbete och snabbare ser vad som behöver granskas.',
          points: ['Fakturor och betalstatus', 'Matchning mot banktransaktioner', 'Resultat, balans och huvudbok uppdateras från bokföringen'],
        },
      ]}
    />
  )
}
