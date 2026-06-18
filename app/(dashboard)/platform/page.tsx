import Link from 'next/link'
import { requirePlatformAdmin } from '@/lib/auth/platform'
import { NordklartActionCard, NordklartPageShell, NordklartStatCard } from '@/components/nordklart/NordklartShell'
import { Button } from '@/components/ui/button'

export const dynamic = 'force-dynamic'

export default async function PlatformPage() {
  const { supabase, user } = await requirePlatformAdmin()

  const [
    { count: companyCount },
    { count: agencyCount },
    { data: ownPlatformRole },
    { count: pricePlanCount },
    { count: activeSubscriptionCount },
    { count: onboardingCount },
    { count: reviewQueueCount },
    { count: providerCount },
    { count: yearEndCount },
    { count: taxWaitingCount },
    { count: bankgiroReviewCount },
    { count: webhookEndpointCount },
  ] = await Promise.all([
    supabase.from('companies').select('*', { count: 'exact', head: true }),
    supabase.from('agencies').select('*', { count: 'exact', head: true }),
    supabase.from('platform_roles').select('role').eq('user_id', user.id).is('revoked_at', null).maybeSingle(),
    supabase.from('platform_price_plans').select('*', { count: 'exact', head: true }),
    supabase.from('company_subscriptions').select('*', { count: 'exact', head: true }).in('status', ['trialing', 'active']),
    supabase.from('onboarding_sessions').select('*', { count: 'exact', head: true }).in('status', ['draft', 'in_progress', 'blocked']),
    supabase.from('review_queue_items').select('*', { count: 'exact', head: true }).in('status', ['open', 'in_review']),
    supabase.from('bank_data_providers').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('year_end_projects').select('*', { count: 'exact', head: true }),
    supabase.from('tax_submissions').select('*', { count: 'exact', head: true }).eq('status', 'waiting_for_signature'),
    supabase.from('bankgiro_applications').select('*', { count: 'exact', head: true }).in('status', ['submitted', 'needs_information', 'under_review']),
    supabase.from('webhook_endpoints').select('*', { count: 'exact', head: true }).eq('status', 'active'),
  ])

  const isPlatform = ownPlatformRole?.role === 'platform_admin'

  return (
    <NordklartPageShell
      eyebrow="Nordklart Plattform"
      title="Nordklart styrs centralt men isolerar varje bolag"
      description="Hantera bolag, byråer, prisplaner, produktåtkomst och drift från en gemensam plattform utan att blanda kunddata mellan bolag."
      actions={<Button variant={isPlatform ? 'default' : 'secondary'}>{isPlatform ? 'Platform admin aktiv' : 'Begär platform access'}</Button>}
    >
      <div className="grid gap-4 md:grid-cols-4">
        <NordklartStatCard label="Bolag" value={companyCount || 0} description="Befintliga tenants i systemet." />
        <NordklartStatCard label="Byråer" value={agencyCount || 0} description="Nya agency-modellen." tone="primary" />
        <NordklartStatCard label="Prisplaner" value={pricePlanCount || 0} description="Produktkatalog för Nordklart." />
        <NordklartStatCard label="Din roll" value={ownPlatformRole?.role || 'standard'} description="Avgör om globala vyer ska öppnas fullt." tone={isPlatform ? 'success' : 'warning'} />
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <NordklartStatCard label="Aktiva abonnemang" value={activeSubscriptionCount || 0} description="Trialing eller active." tone="success" />
        <NordklartStatCard label="Onboarding" value={onboardingCount || 0} description="Draft/in progress/blocked." />
        <NordklartStatCard label="Review queue" value={reviewQueueCount || 0} description="Öppna automation-/byråärenden." tone="warning" />
        <NordklartStatCard label="Bankproviders" value={providerCount || 0} description="Aktiva provider-adaptrar." />
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <NordklartStatCard label="Bokslut" value={yearEndCount || 0} description="Aktiva bokslutsprojekt." tone="primary" />
        <NordklartStatCard label="Signering" value={taxWaitingCount || 0} description="Skatteverket väntar." tone={(taxWaitingCount || 0) > 0 ? 'warning' : 'success'} />
        <NordklartStatCard label="Bankgiro review" value={bankgiroReviewCount || 0} description="Ansökningar att hantera." tone={(bankgiroReviewCount || 0) > 0 ? 'warning' : 'success'} />
        <NordklartStatCard label="Webhooks" value={webhookEndpointCount || 0} description="Aktiva endpoints." />
      </div>

      <div className="grid gap-4 lg:grid-cols-4">
        <NordklartActionCard meta="Prisplaner" title="Prisplaner & features" description="Produkter, prisplaner, plan features, subscriptions, entitlements, engångsköp, usage och feature gate-helper.">
          <Button asChild size="sm"><Link href="/platform/price-plans">Öppna</Link></Button>
        </NordklartActionCard>
        <NordklartActionCard meta="Onboarding" title="Onboardingvägar" description="Bokföring direkt, bankautomation, bokslut engångsköp och Bankgiro/Autogiro hålls som separata flows.">
          <Button asChild size="sm"><Link href="/platform/onboarding">Öppna</Link></Button>
        </NordklartActionCard>
        <NordklartActionCard meta="Byrå" title="Byråläge" description="Kundstatus, ansvarig konsult, deadlines, moms, bokslut, bankstatus, byråmallar och review queue.">
          <Button asChild size="sm"><Link href="/agency/clients">Öppna</Link></Button>
        </NordklartActionCard>
        <NordklartActionCard meta="Bankautomation" title="Bankautomation" description="Provider abstraction, bank accounts, ingest, dedupe, matching, automation rules, decisions och granskningskö.">
          <Button asChild size="sm"><Link href="/platform/bank-automation">Öppna</Link></Button>
        </NordklartActionCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-4">
        <NordklartActionCard meta="Bokslut" title="Bokslut som produkt" description="Bokslutsprojekt, readiness, engångsköp, access och exportpaket.">
          <Button asChild size="sm"><Link href="/platform/year-end">Öppna</Link></Button>
        </NordklartActionCard>
        <NordklartActionCard meta="Skatteverket" title="Skatteverket" description="Momsdeklarationer, signeringsstatus, kvittenser, deadlines och audit.">
          <Button asChild size="sm"><Link href="/platform/skatteverket">Öppna</Link></Button>
        </NordklartActionCard>
        <NordklartActionCard meta="Bankgiro" title="Bankgiro / Autogiro" description="Separat provider-modul för ansökan, review, mandat, collections och avstämning.">
          <Button asChild size="sm"><Link href="/platform/bankgiro">Öppna</Link></Button>
        </NordklartActionCard>
        <NordklartActionCard meta="API & webhooks" title="API & Webhooks" description="API-klienter, scopes, OpenAPI, eventkatalog, signering, retries och logs.">
          <Button asChild size="sm"><Link href="/platform/api-webhooks">Öppna</Link></Button>
        </NordklartActionCard>
      </div>

    </NordklartPageShell>
  )
}
