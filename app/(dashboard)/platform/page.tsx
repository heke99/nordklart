import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { NordklartActionCard, NordklartPageShell, NordklartStatCard } from '@/components/nordklart/NordklartShell'
import { Button } from '@/components/ui/button'

export const dynamic = 'force-dynamic'

export default async function PlatformPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [
    { count: companyCount },
    { count: agencyCount },
    { data: ownPlatformRole },
    { count: pricePlanCount },
    { count: activeSubscriptionCount },
    { count: onboardingCount },
    { count: reviewQueueCount },
    { count: providerCount },
  ] = await Promise.all([
    supabase.from('companies').select('*', { count: 'exact', head: true }),
    supabase.from('agencies').select('*', { count: 'exact', head: true }),
    supabase.from('platform_roles').select('role').eq('user_id', user.id).is('revoked_at', null).maybeSingle(),
    supabase.from('platform_price_plans').select('*', { count: 'exact', head: true }),
    supabase.from('company_subscriptions').select('*', { count: 'exact', head: true }).in('status', ['trialing', 'active']),
    supabase.from('onboarding_sessions').select('*', { count: 'exact', head: true }).in('status', ['draft', 'in_progress', 'blocked']),
    supabase.from('review_queue_items').select('*', { count: 'exact', head: true }).in('status', ['open', 'in_review']),
    supabase.from('bank_data_providers').select('*', { count: 'exact', head: true }).eq('status', 'active'),
  ])

  const isPlatform = ownPlatformRole?.role === 'platform_admin'

  return (
    <NordklartPageShell
      eyebrow="Platform admin"
      title="Nordklart styrs centralt men isolerar varje bolag"
      description="Batch 1–3 är foundation. Batch 4–7 bygger prisplaner, onboardingvägar, byråläge och bankautomation ovanpå samma tenant-säkra grund utan att röra bokföringsmotorn."
      actions={<Button variant={isPlatform ? 'default' : 'secondary'}>{isPlatform ? 'Platform admin aktiv' : 'Begär platform access'}</Button>}
    >
      <div className="grid gap-4 md:grid-cols-4">
        <NordklartStatCard label="Bolag" value={companyCount || 0} description="Befintliga tenants i systemet." />
        <NordklartStatCard label="Byråer" value={agencyCount || 0} description="Nya agency-modellen." tone="primary" />
        <NordklartStatCard label="Prisplaner" value={pricePlanCount || 0} description="Batch 4 produktkatalog." />
        <NordklartStatCard label="Din roll" value={ownPlatformRole?.role || 'standard'} description="Avgör om globala vyer ska öppnas fullt." tone={isPlatform ? 'success' : 'warning'} />
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <NordklartStatCard label="Aktiva abonnemang" value={activeSubscriptionCount || 0} description="Trialing eller active." tone="success" />
        <NordklartStatCard label="Onboarding" value={onboardingCount || 0} description="Draft/in progress/blocked." />
        <NordklartStatCard label="Review queue" value={reviewQueueCount || 0} description="Öppna automation-/byråärenden." tone="warning" />
        <NordklartStatCard label="Bankproviders" value={providerCount || 0} description="Aktiva provider-adaptrar." />
      </div>

      <div className="grid gap-4 lg:grid-cols-4">
        <NordklartActionCard meta="Batch 4" title="Prisplaner & features" description="Produkter, prisplaner, plan features, subscriptions, entitlements, engångsköp, usage och feature gate-helper.">
          <Button asChild size="sm"><Link href="/platform/price-plans">Öppna</Link></Button>
        </NordklartActionCard>
        <NordklartActionCard meta="Batch 5" title="Onboardingvägar" description="Bokföring direkt, bankautomation, bokslut engångsköp och Bankgiro/Autogiro hålls som separata flows.">
          <Button asChild size="sm"><Link href="/platform/onboarding">Öppna</Link></Button>
        </NordklartActionCard>
        <NordklartActionCard meta="Batch 6" title="Byråläge" description="Kundstatus, ansvarig konsult, deadlines, moms, bokslut, bankstatus, byråmallar och review queue.">
          <Button asChild size="sm"><Link href="/agency/clients">Öppna</Link></Button>
        </NordklartActionCard>
        <NordklartActionCard meta="Batch 7" title="Bankautomation" description="Provider abstraction, bank accounts, ingest, dedupe, matching, automation rules, decisions och granskningskö.">
          <Button asChild size="sm"><Link href="/platform/bank-automation">Öppna</Link></Button>
        </NordklartActionCard>
      </div>
    </NordklartPageShell>
  )
}
