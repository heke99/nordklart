import type { Metadata } from 'next'
import { MarketingInfoPage } from '@/components/marketing/MarketingInfoPage'

export const metadata: Metadata = {
  title: 'Cookies – Nordklart',
  description: 'Information om cookies och liknande tekniker i Nordklart.',
}

export default function CookiesPage() {
  return (
    <MarketingInfoPage
      showLegalEntity
      eyebrow="Cookies"
      title="Cookies och lokal lagring"
      description="Nordklart använder nödvändiga cookies för inloggning, säkerhet och språkval. Analys och sessionsinspelning används bara om du samtycker."
      sections={[
        {
          title: 'Nödvändiga cookies',
          body: 'Dessa krävs för att tjänsten ska fungera och kräver inget samtycke. Inloggningen avslutas efter 12 timmars inaktivitet och senast 7 dagar efter senaste inloggning.',
          points: [
            'Inloggning och session (Supabase, sb-*), högst 7 dagar',
            'Senaste aktivitet (nordklart-last-activity), för automatisk utloggning',
            'Valt företag och språk (nordklart-company-id, språkcookie)',
            'BankID-inloggning bunden till din webbläsare (nordklart-bankid-order), 10 minuter',
            'Inbjudan under pågående inloggning (nordklart-invite-token), 24 timmar',
            'Ditt cookieval (nordklart-consent), 12 månader',
          ],
        },
        {
          title: 'Analys och sessionsinspelning (samtycke)',
          body: 'Med ditt samtycke laddas Recapt, som registrerar hur tjänsten används och låter dig lämna feedback. Det laddas aldrig på inloggnings-, registrerings-, MFA- eller BankID-sidor. Utan samtycke laddas det inte alls.',
        },
        {
          title: 'Ändra ditt val',
          body: 'Radera cookien nordklart-consent i webbläsaren så visas valet igen. Du kan också blockera cookies i webbläsaren, men då slutar inloggningen att fungera.',
        },
      ]}
    />
  )
}
