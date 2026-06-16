import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { NordklartActionCard, NordklartPageShell, NordklartStatCard } from '@/components/nordklart/NordklartShell'
import { Button } from '@/components/ui/button'

export const dynamic = 'force-dynamic'

export default async function PlatformPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [{ count: companyCount }, { count: agencyCount }, { count: platformAdminCount }, { data: ownPlatformRole }] = await Promise.all([
    supabase.from('companies').select('*', { count: 'exact', head: true }),
    supabase.from('agencies').select('*', { count: 'exact', head: true }),
    supabase.from('platform_roles').select('*', { count: 'exact', head: true }).is('revoked_at', null),
    supabase.from('platform_roles').select('role').eq('user_id', user.id).is('revoked_at', null).maybeSingle(),
  ])

  const isPlatform = ownPlatformRole?.role === 'platform_admin'

  return (
    <NordklartPageShell
      eyebrow="Platform admin"
      title="Nordklart styrs centralt men isolerar varje bolag"
      description="Batch 1–3 lägger grunden för ny app, ny design och multi-tenant/byråmodell. Kommande batchar bygger prisplaner, entitlements, Bankgiro-onboarding och automatisering ovanpå detta."
      actions={<Button variant={isPlatform ? 'default' : 'secondary'}>{isPlatform ? 'Platform admin aktiv' : 'Begär platform access'}</Button>}
    >
      <div className="grid gap-4 md:grid-cols-4">
        <NordklartStatCard label="Bolag" value={companyCount || 0} description="Befintliga tenants i systemet." />
        <NordklartStatCard label="Byråer" value={agencyCount || 0} description="Nya agency-modellen." tone="primary" />
        <NordklartStatCard label="Platform roles" value={platformAdminCount || 0} description="Aktiva plattformsroller." />
        <NordklartStatCard label="Din roll" value={ownPlatformRole?.role || 'standard'} description="Avgör om globala vyer ska öppnas fullt." tone={isPlatform ? 'success' : 'warning'} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <NordklartActionCard meta="Batch 1" title="Proprietär Nordklart-app" description="tidigare licens-/community-positionering är ersatt med proprietär Nordklart-licens och gammal tidigare projektbranding är rensad i centrala filer." />
        <NordklartActionCard meta="Batch 2" title="Ny designbas" description="Ny färgpalett, glass-cards, tydligare navigation och separata ytor för kund, byrå och plattform." />
        <NordklartActionCard meta="Batch 3" title="Tenant- och byrågrund" description="Platform roles, agencies, agency members, agency clients och company_access-vy är tillagda utan att ändra bokföringsmotorn." />
      </div>
    </NordklartPageShell>
  )
}
