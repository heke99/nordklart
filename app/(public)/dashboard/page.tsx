import type { Metadata } from 'next'
import { NordklartPublicDashboard } from '@/components/marketing/NordklartPublicDashboard'

export const metadata: Metadata = {
  title: 'Nordklart – automatiserad bokföring, fakturor och bokslut',
  description:
    'Nordklart automatiserar bokföring, verifikationer och fakturor för svenska företag. Bokslut och Bankgiro via partner finns när du behöver det.',
}

export default function PublicDashboardPage() {
  return <NordklartPublicDashboard />
}
