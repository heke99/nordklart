import Link from 'next/link'
import { canWritePlatform, PLATFORM_ROLE_LABELS, requirePlatformRole } from '@/lib/auth/platform'
import { createServiceClient } from '@/lib/supabase/server'
import { NordklartActionCard, NordklartPageShell, NordklartStatCard } from '@/components/nordklart/NordklartShell'
import { Button } from '@/components/ui/button'

export const dynamic = 'force-dynamic'

export default async function PlatformPage() {
  const { role } = await requirePlatformRole()
  const supabase = createServiceClient()

  const [
    { count: companyCount },
    { count: agencyCount },
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
    supabase.from('platform_price_plans').select('*', { count: 'exact', head: true }),
    supabase.from('company_subscriptions').select('*', { count: 'exact', head: true }).in('status', ['trialing', 'active']),
    supabase.from('onboarding_sessions').select('*', { count: 'exact', head: true }).in('status', ['draft', 'in_progress', 'blocked']),
    supabase.from('review_queue_items').select('*', { count: 'exact', head: true }).in('status', ['open', 'in_review']),
    supabase.from('bank_data_providers').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('year_end_projects').select('*', { count: 'exact', head: true }),
    supabase.from('tax_submissions').select('*', { count: 'exact', head: true }).eq('status', 'waiting_for_signature'),
    supabase.from('bankgiro_applications').select('*', { count: 'exact', head: true }).in('status', ['submitted', 'needs_information', 'under_review']),
    supabase.from('webhooks').select('*', { count: 'exact', head: true }).eq('active', true).is('disabled_at', null),
  ])

  const isPlatform = canWritePlatform(role)

  return (
    <NordklartPageShell
      eyebrow="Nordklart Plattform"
      title="Nordklart styrs centralt men isolerar varje bolag"
      description="Hantera bolag, byråer, prisplaner, produktåtkomst och drift från en gemensam plattform utan att blanda kunddata mellan bolag."
      actions={<Button variant={isPlatform ? 'default' : 'secondary'}>{isPlatform ? 'Superadmin aktiv' : PLATFORM_ROLE_LABELS[role]}</Button>}
    >
      <div className="grid gap-4 md:grid-cols-4">
        <NordklartStatCard label="Bolag" value={companyCount || 0} description="Alla bolag i plattformen." />
        <NordklartStatCard label="Byråer" value={agencyCount || 0} description="Redovisningsbyråer." tone="primary" />
        <NordklartStatCard label="Prisplaner" value={pricePlanCount || 0} description="Produktkatalog för Nordklart." />
        <NordklartStatCard label="Din roll" value={PLATFORM_ROLE_LABELS[role]} description={isPlatform ? 'Full plattformsbehörighet.' : 'Läsbehörighet i plattformen.'} tone={isPlatform ? 'success' : 'warning'} />
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <NordklartStatCard label="Aktiva abonnemang" value={activeSubscriptionCount || 0} description="Provperiod eller aktiv." tone="success" />
        <NordklartStatCard label="Onboarding" value={onboardingCount || 0} description="Påbörjad eller blockerad." />
        <NordklartStatCard label="Granskningskö" value={reviewQueueCount || 0} description="Öppna ärenden." tone="warning" />
        <NordklartStatCard label="Bankkopplingar" value={providerCount || 0} description="Aktiva betal- och bankkopplingar." />
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <NordklartStatCard label="Bokslut" value={yearEndCount || 0} description="Aktiva bokslutsprojekt." tone="primary" />
        <NordklartStatCard label="Signering" value={taxWaitingCount || 0} description="Skatteverket väntar." tone={(taxWaitingCount || 0) > 0 ? 'warning' : 'success'} />
        <NordklartStatCard label="Bankgiro" value={bankgiroReviewCount || 0} description="Ansökningar att granska." tone={(bankgiroReviewCount || 0) > 0 ? 'warning' : 'success'} />
        <NordklartStatCard label="Webhooks" value={webhookEndpointCount || 0} description="Aktiva endpoints." />
      </div>

      <div className="grid gap-4 lg:grid-cols-4">
        <NordklartActionCard meta="Bolag" title="Bolag och byråer" description="Sök, filtrera och öppna bolagskort för användare, abonnemang, Bankgiro, bokslut och bokföringskontroller.">
          <Button asChild size="sm"><Link href="/platform/companies">Öppna</Link></Button>
        </NordklartActionCard>
        <NordklartActionCard meta="Prisplaner" title="Prisplaner och funktioner" description="Produkter, prisplaner, abonnemang, tillägg, engångsköp och åtkomststyrning.">
          <Button asChild size="sm"><Link href="/platform/price-plans">Öppna</Link></Button>
        </NordklartActionCard>
        <NordklartActionCard meta="Onboarding" title="Onboardingvägar" description="Bokföring, bankkoppling, bokslutsköp och Bankgiro/Autogiro hålls som tydliga flöden.">
          <Button asChild size="sm"><Link href="/platform/onboarding">Öppna</Link></Button>
        </NordklartActionCard>
        <NordklartActionCard meta="Byrå" title="Byråläge" description="Kundstatus, ansvarig konsult, deadlines, moms, bokslut, bankstatus, byråmallar och granskningskö.">
          <Button asChild size="sm"><Link href="/agency/clients">Öppna</Link></Button>
        </NordklartActionCard>
        <NordklartActionCard meta="Bankautomation" title="Bankautomation" description="Bankkonton, import, dubblettskydd, matchning, automationsregler och granskningskö.">
          <Button asChild size="sm"><Link href="/platform/bank-automation">Öppna</Link></Button>
        </NordklartActionCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-4">
        <NordklartActionCard meta="Bokslut" title="Bokslut som produkt" description="Bokslutsprojekt, kontrollstatus, engångsköp, åtkomst och exportpaket.">
          <Button asChild size="sm"><Link href="/platform/year-end">Öppna</Link></Button>
        </NordklartActionCard>
        <NordklartActionCard meta="Skatteverket" title="Skatteverket" description="Momsdeklarationer, signeringsstatus, kvittenser, deadlines och audit.">
          <Button asChild size="sm"><Link href="/platform/skatteverket">Öppna</Link></Button>
        </NordklartActionCard>
        <NordklartActionCard meta="Bankgiro" title="Bankgiro / Autogiro" description="Ansökan, granskning, medgivanden, betalningar och avstämning.">
          <Button asChild size="sm"><Link href="/platform/bankgiro">Öppna</Link></Button>
        </NordklartActionCard>
        <NordklartActionCard meta="API & webhooks" title="API & Webhooks" description="API-klienter, scopes, OpenAPI, eventkatalog, signering, retries och logs.">
          <Button asChild size="sm"><Link href="/platform/api-webhooks">Öppna</Link></Button>
        </NordklartActionCard>
        <NordklartActionCard meta="Behörigheter" title="Plattformsteam" description="Tilldela och återkalla plattformsroller med audit-logg. Kostnadsfri bolagsåtkomst hanteras på bolagskortet.">
          <Button asChild size="sm"><Link href="/platform/access">Öppna</Link></Button>
        </NordklartActionCard>
        <NordklartActionCard meta="Integrationer" title="Go-live-status" description="Miljövalidering per integration: Stripe, Resend, bank, Skatteverket, Bolagsverket, Peppol och fler.">
          <Button asChild size="sm"><Link href="/platform/integrations">Öppna</Link></Button>
        </NordklartActionCard>
        <NordklartActionCard meta="Drift" title="Företagsoperationer" description="Cross-tenant backlog: misslyckade operationer, webhooks, obetalda perioder och supportprioritering.">
          <Button asChild size="sm"><Link href="/platform/company-operations">Öppna</Link></Button>
        </NordklartActionCard>
      </div>

    </NordklartPageShell>
  )
}
