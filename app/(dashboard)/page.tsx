import type { Metadata } from 'next'
import { NordklartPublicDashboard } from '@/components/marketing/NordklartPublicDashboard'

export const metadata: Metadata = {
  title: 'Nordklart – bokföring, bokslut och Bankgiro',
  description:
    'Välj bokföring, gör enbart bokslut, ansök om Bankgiro via partner eller samla allt i Nordklart.',
}

export default function HomePage() {
  return <NordklartPublicDashboard />
}
