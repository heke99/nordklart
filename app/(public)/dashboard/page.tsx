import type { Metadata } from 'next'
import { NordklartPublicDashboard } from '@/components/marketing/NordklartPublicDashboard'

export const metadata: Metadata = {
  title: 'Nordklart dashboard – bokföring, bokslut och Bankgiro',
  description:
    'Välj bokföring, enbart bokslut, Bankgiro via partner eller allt i ett. Nordklart är byggt för svenska företag och redovisningsbyråer.',
}

export default function PublicDashboardPage() {
  return <NordklartPublicDashboard />
}
