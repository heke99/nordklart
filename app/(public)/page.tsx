import type { Metadata } from 'next'
import { NordklartPublicDashboard } from '@/components/marketing/NordklartPublicDashboard'

export const metadata: Metadata = {
  title: 'Nordklart – automatiserad bokföring, fakturor och bokslut',
  description:
    'Nordklart är ett system för automatiserad bokföring, fakturor och bokslut som tillhandahålls av Gridex El AB, org.nr 559416-7149.',
}

export default function HomePage() {
  return <NordklartPublicDashboard />
}
