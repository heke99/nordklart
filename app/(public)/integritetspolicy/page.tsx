import type { Metadata } from 'next'
import { MarketingInfoPage } from '@/components/marketing/MarketingInfoPage'
import { NORDKLART_LEGAL_NAME } from '@/lib/branding/legal-identity'
import { CURRENT_LEGAL_VERSION } from '@/lib/legal/acceptance-gate'

export const metadata: Metadata = {
  title: 'Integritetspolicy – Nordklart',
  description: 'Hur Nordklart hanterar personuppgifter, bolagsuppgifter och uppgifter i Bankgiroflöden.',
}

export default function IntegritetspolicyPage() {
  return (
    <MarketingInfoPage
      showLegalEntity
      effectiveFrom={CURRENT_LEGAL_VERSION}
      eyebrow="Integritet"
      title="Integritetspolicy"
      description={`${NORDKLART_LEGAL_NAME} tillhandahåller Nordklart och behandlar person- och bolagsuppgifter för att tillhandahålla bokföring, bokslut, Bankgiroflöden, support och säker drift.`}
      sections={[
        {
          title: 'Uppgifter vi kan behandla',
          body: 'Vi kan behandla kontaktuppgifter, användarkonto, bolagsuppgifter, bokföringsunderlag, fakturor, rapportdata och teknisk information som behövs för säker användning.',
          points: ['Namn, e-post och roll', 'Bolagsuppgifter och organisationsnummer', 'Bokförings- och rapportunderlag'],
        },
        {
          title: 'Bankgiro och partner',
          body: 'När du ansöker om Bankgiro eller betalflöden kan uppgifter behöva delas med betal- eller Bankgiro-partner för granskning, aktivering och efterlevnadskrav.',
          points: ['Bolagsuppgifter', 'Ägare/verklig huvudman', 'Dokument och kompletteringar', 'Status från partnerflödet'],
        },
        {
          title: 'Varför vi behandlar uppgifter',
          body: 'Uppgifter används för att skapa konto, leverera tjänsten, hantera säkerhet, följa avtal, uppfylla rättsliga krav och förbättra användarupplevelsen.',
        },
        {
          title: 'Dina rättigheter',
          body: 'Du kan begära tillgång, rättelse, export eller radering i den mån det är möjligt enligt lag och avtal. Vissa bokföringsuppgifter kan behöva sparas enligt lagkrav.',
        },
      ]}
    />
  )
}
