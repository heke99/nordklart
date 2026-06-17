import type { Metadata } from 'next'
import { NordklartPublicDashboard } from '@/components/marketing/NordklartPublicDashboard'

export const metadata: Metadata = {
  title: 'Nordklart – automatiserad bokföring, fakturor och bokslut',
  description:
    'Automatisera bokföring, verifikationer och fakturor. Gör bokslut separat eller koppla Bankgiro via partner.',
}

export default function HomePage() {
  return <NordklartPublicDashboard />
}
