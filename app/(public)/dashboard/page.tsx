import type { Metadata } from 'next'
import { NordklartPublicDashboard } from '@/components/marketing/NordklartPublicDashboard'

export const metadata: Metadata = {
  title: 'Nordklart – bokföring, bokslut och Bankgiro',
  description:
    'Nordklart hjälper svenska företag med bokföring, fristående bokslut och Bankgiro via partner.',
}

export default function PublicDashboardPage() {
  return <NordklartPublicDashboard />
}
