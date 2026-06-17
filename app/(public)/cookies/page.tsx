import type { Metadata } from 'next'
import { MarketingInfoPage } from '@/components/marketing/MarketingInfoPage'

export const metadata: Metadata = {
  title: 'Cookies – Nordklart',
  description: 'Information om cookies och liknande tekniker i Nordklart.',
}

export default function CookiesPage() {
  return (
    <MarketingInfoPage
      eyebrow="Cookies"
      title="Cookies och lokal lagring"
      description="Nordklart använder nödvändiga cookies och lokal lagring för inloggning, säkerhet, språkval och grundläggande funktioner."
      sections={[
        {
          title: 'Nödvändiga cookies',
          body: 'Dessa används för att hålla dig inloggad, skydda sessionen, spara språk och se till att tjänsten fungerar korrekt.',
          points: ['Inloggning och session', 'Säkerhet', 'Språk och grundläggande inställningar'],
        },
        {
          title: 'Analys och förbättring',
          body: 'Om analysverktyg används ska de beskrivas tydligt och hanteras enligt gällande samtycke och inställningar.',
        },
        {
          title: 'Ändra inställningar',
          body: 'Du kan begränsa cookies i webbläsaren. Vissa delar av tjänsten kan sluta fungera om nödvändiga cookies blockeras.',
        },
      ]}
    />
  )
}
