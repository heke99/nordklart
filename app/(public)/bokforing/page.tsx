import type { Metadata } from 'next'
import { MarketingInfoPage } from '@/components/marketing/MarketingInfoPage'

export const metadata: Metadata = {
  title: 'Bokföring i Nordklart',
  description: 'Sköt verifikationer, fakturor, moms, rapporter och SIE i ett svenskt bokföringssystem.',
}

export default function BokforingPage() {
  return (
    <MarketingInfoPage
      eyebrow="Bokföring"
      title="Löpande bokföring som håller ihop reglerna."
      description="Nordklart hjälper dig att bokföra, fakturera, följa moms och ta ut rapporter utan att tappa kontrollen över BAS-konton, verifikationsserier och spårbarhet."
      primaryCta={{ label: 'Starta bokföring', href: '/register?intent=bookkeeping' }}
      secondaryCta={{ label: 'Boka demo', href: '/boka-demo?intent=bookkeeping' }}
      highlights={['Verifikationer med debet och kredit', 'Fakturor och kundreskontra', 'Momsrapport, resultat och balans', 'SIE-import och export']}
      sections={[
        {
          title: 'Byggt för svensk bokföring',
          body: 'Nordklart utgår från svenska bokföringsflöden med BAS-kontoplan, räkenskapsår, momsperioder och tydliga kontroller innan något låses.',
          points: ['BAS-konton och verifikationsserier', 'Låsta perioder och rättningsspår', 'Rapporter som följer bokföringsdata'],
        },
        {
          title: 'Från faktura till rapport',
          body: 'Fakturor, betalningar, verifikationer och rapporter ska hänga ihop så att du slipper dubbelarbete och osäkra siffror.',
          points: ['Fakturor och betalstatus', 'Matchning mot banktransaktioner när bank är kopplad', 'Resultat, balans och huvudbok'],
        },
      ]}
    />
  )
}
