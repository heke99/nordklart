import type { Metadata } from 'next'
import { MarketingInfoPage } from '@/components/marketing/MarketingInfoPage'

export const metadata: Metadata = {
  title: 'Priser för Nordklart',
  description: 'Välj bokföring, bokslut, Bankgiro, byrå eller allt i ett. Kontakta Nordklart för rätt upplägg.',
}

export default function PriserPage() {
  return (
    <MarketingInfoPage
      eyebrow="Priser"
      title="Välj bara det du behöver – eller samla allt i ett."
      description="Nordklart kan användas för löpande bokföring, fristående bokslut, Bankgiro via partner, byråarbete eller ett komplett allt-i-ett-flöde."
      primaryCta={{ label: 'Boka demo', href: '/boka-demo' }}
      secondaryCta={{ label: 'Kontakta oss', href: '/kontakt' }}
      highlights={['Nordklart Start', 'Nordklart Auto', 'Nordklart Bokslut', 'Nordklart Bankgiro']}
      sections={[
        {
          title: 'För företag',
          body: 'Starta med bokföring, lägg till bankkoppling när du vill automatisera mer, eller välj bara bokslut när årsslutet är behovet.',
          points: ['Löpande bokföring', 'Automatisk matchning', 'Fristående bokslut'],
        },
        {
          title: 'För byråer och Bankgiro',
          body: 'Byråer och Bankgiroflöden varierar mer i omfattning. Därför tar vi fram rätt upplägg utifrån antal kundbolag, behov och aktivering.',
          points: ['Byråpaket', 'Bankgiro via partner', 'Allt-i-ett-upplägg'],
        },
      ]}
    />
  )
}
