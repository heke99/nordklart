import type { Metadata } from 'next'
import { MarketingInfoPage } from '@/components/marketing/MarketingInfoPage'

export const metadata: Metadata = {
  title: 'Bankgiro via partner i Nordklart',
  description: 'Saknar du Bankgiro? Nordklart hjälper dig med ansökan via partner och koppling till betalningar och bokföring.',
}

export default function BankgiroPage() {
  return (
    <MarketingInfoPage
      eyebrow="Bankgiro"
      title="Saknar du Bankgiro? Vi hjälper dig komma vidare."
      description="Nordklart samlar bolagsuppgifter, ägarinformation och dokument för ansökan via partner. När Bankgiro är aktivt kan flödet kopplas till betalningar, avstämning och bokföring."
      primaryCta={{ label: 'Ansök om Bankgiro', href: '/register?intent=bankgiro' }}
      secondaryCta={{ label: 'Boka demo', href: '/boka-demo?intent=bankgiro' }}
      highlights={['Ansökan via partner', 'Bolags- och ägaruppgifter', 'Status och kompletteringar', 'Koppling till avstämning']}
      sections={[
        {
          title: 'Tydligt ansökningsflöde',
          body: 'Kunden ska förstå vad som saknas, vad som är inskickat och när ansökan går vidare till granskning och aktivering.',
          points: ['Utkast och inskickad ansökan', 'Kompletteringar och dokument', 'Status från partnerflödet'],
        },
        {
          title: 'Kopplat till bokföringen',
          body: 'Bankgiro är inte bara ett nummer. Värdet kommer när inbetalningar kan följas upp, matchas och stämmas av mot fakturor och verifikationer.',
          points: ['Följ inbetalningar', 'Matcha mot fakturor', 'Få bättre bokföringsunderlag'],
        },
      ]}
    />
  )
}
