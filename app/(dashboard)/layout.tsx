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
import { getExtensionNavItems } from '@/lib/extensions/sectors'
import { CompanyProvider } from '@/contexts/CompanyContext'
import { getActiveCompanyId, getUserCompanies } from '@/lib/company/context'
import { legacyRoleFromEffectiveRole, resolveCompanyAccess } from '@/lib/access/company'
import { getBranding } from '@/lib/branding/service'
import { ensureSandboxAgentProfile } from '@/lib/sandbox/ensure-agent'
import { countPendingOperations, countUnbookedTransactions } from '@/lib/worklist'
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

  // The historical dashboard group owned `/`. Nordklart now uses `/` as the
  // public hero page, while the authenticated app overview lives at `/app`.
  // Keep this branch above auth so first-time visitors never land on login.
  if (pathname === '/' || pathname === '') {
    return <>{children}</>
  }

  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  // Resolve active company from user_preferences (authoritative). The
  // `nordklart-company-id` cookie is intentionally no longer consulted here —
  // `getActiveCompanyId` reads from user_preferences, matching what RLS
  // sees via `current_active_company_id()`. Keeping both sides on the same
  // source avoids cross-tab / cookie divergence.
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
    supabase.from('platform_roles').select('role').eq('user_id', user.id).eq('role', 'platform_admin').is('revoked_at', null).maybeSingle(),
    supabase.from('agency_members').select('agency_id, role').eq('user_id', user.id).in('role', ['agency_owner', 'agency_admin', 'accountant', 'reviewer']).limit(1).maybeSingle(),
  ])

  // If onboarding incomplete, still render the dashboard — the page component
  // will show the inline onboarding card instead of the normal dashboard content.

  // Use company_name from settings as the display name (companies.name may be stale)
  const displayName = settings?.company_name || companyRow.name
  const companyWithName = { ...companyRow, name: displayName }

  const entityType = (settings?.entity_type as EntityType) || 'enskild_firma'

  const isSandbox = settings?.is_sandbox === true

  // Backfill a verified agent_profile for sandbox sessions that pre-date the
  // seed change. Without this an old anonymous session shows the "Bygg din
  // bokföringsassistent" CTA in three places (dashboard hero, NewUserChecklist
  // step 4, /chat layout redirect) and the user can still kick off a build
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
  const workspaceType: 'company' | 'agency' | 'platform' =
    pathname.startsWith('/platform') && canManagePlatform
      ? 'platform'
      : pathname.startsWith('/agency') && canManageAgency
        ? 'agency'
        : workspacePrefs?.active_workspace_type === 'agency' && canManageAgency
          ? 'agency'
          : 'company'

  const companyContextValue = {
    company: companyWithName,
    role: legacyRoleFromEffectiveRole(activeAccess.effectiveRole) as CompanyRole,
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
