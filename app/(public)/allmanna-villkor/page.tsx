import type { Metadata } from 'next'
import { MarketingInfoPage } from '@/components/marketing/MarketingInfoPage'

export const metadata: Metadata = {
  title: 'Allmänna villkor – Nordklart',
  description: 'Allmänna villkor för användning av Nordklart.',
}

export default function AllmannaVillkorPage() {
  return (
    <MarketingInfoPage
      showLegalEntity
      eyebrow="Juridik"
      title="Allmänna villkor"
      description="Villkoren beskriver huvudprinciperna för användning av Nordklart. Slutliga kundvillkor ska alltid vara de versioner som presenteras och accepteras vid teckning eller köp."
      sections={[
        {
          title: 'Tjänsten',
          body: 'Nordklart tillhandahåller digitala funktioner för bokföring, bokslut, rapportering, Bankgiroansökan via partner och relaterade administrativa flöden.',
          points: ['Funktioner kan variera beroende på vald tjänst', 'Bankgiro och betalflöden kan hanteras via partner', 'Vissa flöden kräver kompletterande uppgifter eller granskning'],
        },
        {
          title: 'Kundens ansvar',
          body: 'Kunden ansvarar för att uppgifter, underlag och behörigheter är korrekta. Nordklart ska hjälpa till med struktur och kontroller, men ersätter inte kundens ansvar för bokföringsunderlag.',
          points: ['Korrekt bolagsinformation', 'Korrekt bokförings- och betalunderlag', 'Behörighet att dela uppgifter med partner när Bankgiro ansöks'],
        },
        {
          title: 'Betalning och åtkomst',
          body: 'Åtkomst kan baseras på abonnemang, engångsköp eller särskilt avtal. Bokslut kan erbjudas som fristående tjänst medan andra delar kan kräva löpande åtkomst.',
        },
        {
          title: 'Ändringar',
          body: 'Nordklart kan uppdatera tjänsten och villkoren. Väsentliga ändringar kommuniceras enligt den process som gäller för kundens avtal.',
        },
      ]}
    />
  )
}
