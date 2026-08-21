import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import DashboardNav from '@/components/dashboard/DashboardNav'
import { MainContainer } from '@/components/dashboard/MainContainer'
import CompanyTabSync from '@/components/dashboard/CompanyTabSync'
import { RecaptIdentify } from '@/components/RecaptIdentify'
import { AgentSheetProvider } from '@/components/agent/AgentSheetProvider'
import AgentTrigger from '@/components/agent/AgentTrigger'
import CommandPalette from '@/components/common/CommandPalette'
import { SettingsHotkey } from '@/components/settings/SettingsHotkey'
import { SandboxBanner } from '@/components/dashboard/SandboxBanner'
import { MaintenanceBanner } from '@/components/dashboard/MaintenanceBanner'
import { getMaintenanceMode, getMaintenanceMessage } from '@/lib/ops/maintenance'
import { getExtensionNavItems } from '@/lib/extensions/sectors'
import { CompanyProvider } from '@/contexts/CompanyContext'
import { getActiveCompanyId, getUserCompanies } from '@/lib/company/context'
import { legacyRoleFromEffectiveRole, resolveCompanyAccess } from '@/lib/access/company'
import { getBranding } from '@/lib/branding/service'
import { ensureSandboxAgentProfile } from '@/lib/sandbox/ensure-agent'
import { countPendingOperations, countUnbookedTransactions } from '@/lib/worklist'
import { PLATFORM_ROLES } from '@/lib/auth/platform'
import { checkFeatureAccess, listCompanyFeatureAccess } from '@/lib/platform/entitlements'
import { hasActiveOneTimePurchase, type OneTimePurchaseRow } from '@/lib/year-end/period-access'
import { featureForDashboardPath, purchaseHrefForFeature } from '@/lib/navigation/feature-access-routing'
import { resolveWorkspaceType } from '@/lib/workspace/resolve'
import type { EntityType, CompanyRole, Team } from '@/types'

/**
 * Routes inside the dashboard group that must remain reachable when the
 * user has no active company. Keep in sync with the middleware's
 * no-company allowlist.
 */
const NO_COMPANY_ALLOWED_PATHS = ['/settings/account']

export default async function DashboardLayout({
  children,
  settingsModal,
}: {
  children: React.ReactNode
  // `@settingsModal` parallel slot — renders the routed settings modal over the
  // current page on in-app navigation to /settings/*; null otherwise.
  settingsModal: React.ReactNode
}) {
  const headerStore = await headers()
  const pathname = headerStore.get('x-pathname') ?? ''

  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  // Resolve active company from user_preferences (authoritative). The
  // `nordklart-company-id` cookie is intentionally no longer consulted here —
  // `getActiveCompanyId` reads from user_preferences and validates access
  // through resolve_company_access. Keeping both sides on the same source
  // avoids cross-tab / cookie divergence.
  const companyId = await getActiveCompanyId(supabase, user.id)

  // Read the pathname forwarded by middleware so we can branch on it.
  const isNoCompanyAllowed = NO_COMPANY_ALLOWED_PATHS.some((p) =>
    pathname.startsWith(p)
  )

  // Fetch team membership + team info
  const { data: teamMembership } = await supabase
    .from('team_members')
    .select('team_id, role')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  let team: Team | null = null
  if (teamMembership?.team_id) {
    const { data: teamRow } = await supabase
      .from('teams')
      .select('*')
      .eq('id', teamMembership.team_id)
      .single()
    team = teamRow
  }

  const isTeamMember = !!teamMembership

  // No companies — redirect to onboarding, except for allowed escape-hatch
  // routes (so the user can still reach /settings/account to delete their
  // account after archiving their last company).
  if (!companyId) {
    if (!isNoCompanyAllowed) {
      redirect('/onboarding')
    }

    return (
      <CompanyProvider
        value={{
          company: null,
          role: null,
          canWrite: false,
          companies: [],
          isTeamMember,
          team,
          isSandbox: false,
          workspaceType: 'company',
          agencyId: null,
          canManageAgency: false,
          canManagePlatform: false,
        }}
      >
        <AgentSheetProvider>
          <CompanyTabSync />
          <div className="min-h-screen bg-background">
            <DashboardNav
              companyName={getBranding().appName.toLowerCase()}
              entityType="enskild_firma"
              uncategorizedTransactionCount={0}
              pendingOperationsCount={0}
              isSandbox={false}
              extensionNavItems={getExtensionNavItems()}
            />
            <main
              id="main-content"
              className="safe-area-main-padding md:!pb-0 md:pl-64"
              role="main"
            >
              <div className="max-w-5xl mx-auto px-5 py-8 md:px-8 md:py-10">
                {children}
              </div>
            </main>
            {settingsModal}
            <SettingsHotkey />
          </div>
        </AgentSheetProvider>
      </CompanyProvider>
    )
  }

  // Resolve company access centrally. Agency staff and platform admins are
  // legitimate company contexts even when they do not have a direct
  // company_members row.
  const [
    { data: companyRow },
    activeAccess,
    accessibleCompanies,
  ] = await Promise.all([
    supabase.from('companies').select('*').eq('id', companyId).single(),
    resolveCompanyAccess(supabase, companyId),
    getUserCompanies(supabase, user.id),
  ])

  if (!companyRow || !activeAccess) {
    const companyContextValue = {
      company: null,
      role: null,
      canWrite: false,
      companies: accessibleCompanies.map((item) => ({
        company: {
          id: item.companyId,
          name: item.name,
          org_number: item.orgNumber,
          entity_type: item.entityType,
          accounting_framework: 'k2',
          created_by: '',
          team_id: null,
          archived_at: item.archivedAt,
          created_at: '',
          updated_at: '',
        } as import('@/types').Company,
        role: legacyRoleFromEffectiveRole(item.effectiveRole),
      })),
      isTeamMember,
      team,
      isSandbox: false,
      workspaceType: 'company' as const,
      agencyId: null,
      canManageAgency: false,
      canManagePlatform: false,
    }

    return (
      <CompanyProvider value={companyContextValue}>
        <AgentSheetProvider>
          <CompanyTabSync />
          <div className="min-h-screen bg-background">
            <DashboardNav
              companyName={getBranding().appName.toLowerCase()}
              entityType="enskild_firma"
              uncategorizedTransactionCount={0}
              pendingOperationsCount={0}
              isSandbox={false}
              extensionNavItems={getExtensionNavItems()}
            />
            <main id="main-content" className="safe-area-main-padding md:!pb-0 md:pl-64" role="main">
              <div className="max-w-5xl mx-auto px-5 py-8 md:px-8 md:py-10">{children}</div>
            </main>
            {settingsModal}
            <SettingsHotkey />
          </div>
        </AgentSheetProvider>
      </CompanyProvider>
    )
  }

  const [
    { data: settings },
    uncategorizedCount,
    pendingOpsCount,
    { data: agentProfileIdentity },
    { data: userProfile },
    { data: workspacePrefs },
    { data: platformRole },
    { data: agencyMembership },
  ] = await Promise.all([
    supabase
      .from('company_settings')
      .select('company_name, onboarding_complete, entity_type, is_sandbox')
      .eq('company_id', companyId)
      .single(),
    // Shared worklist predicates (lib/worklist) — the badge must show the
    // same number as every other "att göra" surface. Notably this excludes
    // is_ignored rows, which the old inline query here did not.
    countUnbookedTransactions(supabase, companyId),
    countPendingOperations(supabase, companyId),
    // Agent identity — name + avatar — surfaced on the FAB and chat
    // surfaces. Null when no agent_profile exists yet (banner CTA path).
    supabase
      .from('agent_profiles')
      .select('display_name, avatar_id, verified_at')
      .eq('company_id', companyId)
      .maybeSingle(),
    // The signed-in user's profile — shown in the bottom-left account
    // popover (full_name + initial) so it's clear which user is logged
    // in, distinct from the active company shown at the top.
    supabase.from('profiles').select('full_name').eq('id', user.id).maybeSingle(),
    supabase.from('user_preferences').select('active_workspace_type, active_agency_id').eq('user_id', user.id).maybeSingle(),
    supabase.from('platform_roles').select('role').eq('user_id', user.id).in('role', PLATFORM_ROLES).is('revoked_at', null).limit(1).maybeSingle(),
    supabase.from('agency_members').select('agency_id, role').eq('user_id', user.id).in('role', ['agency_owner', 'agency_admin', 'accountant', 'payroll', 'reviewer']).limit(1).maybeSingle(),
  ])

  const isSandbox = settings?.is_sandbox === true

  // Feature-aware navigation: enabled feature codes drive which sidebar items
  // render locked (with an upgrade CTA). Year-end additionally honours
  // fiscal-period-bound one-time purchases, which the feature view cannot see.
  const [featureAccessList, { data: yearEndPurchaseRows }] = await Promise.all([
    listCompanyFeatureAccess(supabase, companyId),
    supabase
      .from('one_time_purchases')
      .select('id, fiscal_period_id, permanent_access, access_starts_at, access_expires_at, status')
      .eq('company_id', companyId)
      .eq('purchase_type', 'year_end')
      .in('status', ['paid', 'active', 'fulfilled']),
  ])
  const enabledFeatures = featureAccessList.length > 0
    ? featureAccessList.filter((f) => f.enabled).map((f) => f.feature_code)
    : null
  // Resolved with the same predicate the API uses (isPurchaseActive), not a
  // bare status count — a count ignores access_starts_at / access_expires_at /
  // permanent_access, so the sidebar and the routes disagreed about whether an
  // expired purchase still granted year-end.
  const hasYearEndAccess = Boolean(
    hasActiveOneTimePurchase(yearEndPurchaseRows as OneTimePurchaseRow[] | null)
      || enabledFeatures?.includes('year_end.projects'),
  )

  // Direct URL access follows the same commercial matrix as the sidebar. A
  // missing feature is routed to a purchase surface that knows which exact
  // plan, add-on or one-time product contains the requested feature. Full
  // Access is resolved by company_feature_access(), so it never needs a plan.
  const requiredRouteFeature = featureForDashboardPath(pathname)
  if (!isSandbox && requiredRouteFeature) {
    const periodBoundYearEndRoute = requiredRouteFeature === 'year_end.projects'
      || pathname === '/import'
      || pathname.startsWith('/import/')
    let hasRouteAccess = periodBoundYearEndRoute && hasYearEndAccess
    if (!hasRouteAccess) {
      const catalogFeature = featureAccessList.find((feature) => feature.feature_code === requiredRouteFeature)
      // Only a catalogue row that is BOTH enabled and non-degraded may grant
      // access outright. Anything else — feature absent, disabled, or a row
      // from the view fallback that cannot say why — is re-resolved through
      // the canonical RPC, because that is the only path that separates "this
      // company does not have the product" from "the resolver was down".
      // Trusting a bare `enabled === false` here is what turned a transient
      // resolver failure into a paywall for Full Access customers.
      if (catalogFeature?.enabled && !catalogFeature.degraded) {
        hasRouteAccess = true
      } else {
        const routeAccess = await checkFeatureAccess(supabase, companyId, requiredRouteFeature)
        if (routeAccess.reason === 'database_error') {
          throw new Error(`FEATURE_ACCESS_UNAVAILABLE:${requiredRouteFeature}`)
        }
        hasRouteAccess = routeAccess.allowed
      }
    }

    if (!hasRouteAccess) {
      redirect(purchaseHrefForFeature(requiredRouteFeature, pathname))
    }
  }

  // If onboarding incomplete, still render the dashboard — the page component
  // will show the inline onboarding card instead of the normal dashboard content.

  // Use company_name from settings as the display name (companies.name may be stale)
  const displayName = settings?.company_name || companyRow.name
  const companyWithName = { ...companyRow, name: displayName }

  const entityType = (settings?.entity_type as EntityType) || 'enskild_firma'

  // Backfill a verified agent_profile for sandbox sessions that pre-date the
  // seed change. Without this an old anonymous session shows the "Bygg din
  // bokföringsassistent" CTA in multiple places (dashboard hero and /chat
  // layout redirect) and the user can still kick off a build
  // flow that the server now 403s. Best-effort; doesn't block the layout
  // even if the insert fails.
  let resolvedAgentIdentity = agentProfileIdentity
  if (isSandbox && !agentProfileIdentity?.verified_at) {
    await ensureSandboxAgentProfile(supabase, companyId)
    const { data: refreshed } = await supabase
      .from('agent_profiles')
      .select('display_name, avatar_id, verified_at')
      .eq('company_id', companyId)
      .maybeSingle()
    resolvedAgentIdentity = refreshed ?? agentProfileIdentity
  }

  const canManagePlatform = Boolean(platformRole)
  const canManageAgency = Boolean(agencyMembership)
  // URL wins over the saved preference: company-only routes always render the
  // company sidebar (see lib/workspace/resolve.ts for the full rule).
  const workspaceType = resolveWorkspaceType({
    pathname,
    preferredWorkspaceType: workspacePrefs?.active_workspace_type,
    canManagePlatform,
    canManageAgency,
  })

  const companyContextValue = {
    company: companyWithName,
    role: legacyRoleFromEffectiveRole(activeAccess.effectiveRole) as CompanyRole,
    canWrite: activeAccess.canWrite,
    companies: accessibleCompanies.map((item) => {
      const c = {
        id: item.companyId,
        name: item.companyId === companyId ? displayName : item.name,
        org_number: item.orgNumber,
        entity_type: item.entityType,
        accounting_framework: 'k2',
        created_by: '',
        team_id: null,
        archived_at: item.archivedAt,
        created_at: '',
        updated_at: '',
      } as import('@/types').Company
      return { company: c, role: legacyRoleFromEffectiveRole(item.effectiveRole) as CompanyRole }
    }),
    isTeamMember,
    team,
    isSandbox,
    workspaceType,
    agencyId: agencyMembership?.agency_id ?? workspacePrefs?.active_agency_id ?? null,
    canManageAgency,
    canManagePlatform,
  }

  return (
    <CompanyProvider value={companyContextValue}>
      <AgentSheetProvider
        identity={{
          displayName: resolvedAgentIdentity?.display_name ?? null,
          avatarId: resolvedAgentIdentity?.avatar_id ?? null,
          isVerified: Boolean(resolvedAgentIdentity?.verified_at),
        }}
      >
        <CompanyTabSync />
        <div className="min-h-screen bg-background">
          {/* Skip to content link for keyboard/screen reader users */}
          <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[100] focus:px-4 focus:py-2 focus:bg-primary focus:text-primary-foreground focus:rounded-lg focus:text-sm focus:font-medium"
          >
            Hoppa till innehåll
          </a>
          {getMaintenanceMode() !== 'off' && (
            <MaintenanceBanner
              message={getMaintenanceMessage()}
              readOnly={getMaintenanceMode() === 'read_only'}
            />
          )}
          {isSandbox && <SandboxBanner />}
          <DashboardNav
            companyName={settings?.company_name || 'Min verksamhet'}
            entityType={entityType}
            uncategorizedTransactionCount={uncategorizedCount}
            pendingOperationsCount={pendingOpsCount}
            isSandbox={isSandbox}
            extensionNavItems={getExtensionNavItems()}
            userName={userProfile?.full_name ?? null}
            userEmail={user.email ?? null}
            enabledFeatures={enabledFeatures}
            hasYearEndAccess={hasYearEndAccess}
          />
          <main id="main-content" className="safe-area-main-padding md:!pb-0 md:pl-64" role="main">
            <MainContainer companyId={companyId}>{children}</MainContainer>
          </main>
          <AgentTrigger />
          <CommandPalette />
          <SettingsHotkey />
          {settingsModal}
        </div>
        {!isSandbox && (
          <RecaptIdentify
            userId={user.id}
            email={user.email}
            displayName={settings?.company_name || undefined}
          />
        )}
      </AgentSheetProvider>
    </CompanyProvider>
  )
}
