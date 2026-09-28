import type { Metadata } from 'next'
import { NordklartPublicDashboard } from '@/components/marketing/NordklartPublicDashboard'
import { NORDKLART_LEGAL_NAME, NORDKLART_ORG_NUMBER } from '@/lib/branding/legal-identity'

export const metadata: Metadata = {
  title: 'Nordklart – automatiserad bokföring, fakturor och bokslut',
  description:
    `Nordklart är ett system för automatiserad bokföring, fakturor och bokslut som tillhandahålls av ${NORDKLART_LEGAL_NAME}, org.nr ${NORDKLART_ORG_NUMBER}.`,
}

export default function HomePage() {
  return <NordklartPublicDashboard />
}
