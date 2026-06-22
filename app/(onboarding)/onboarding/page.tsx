import { createClient, createServiceClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import WelcomeOnboarding from '@/components/dashboard/WelcomeOnboarding'
import NordklartOnboardingRouter from '@/components/onboarding/NordklartOnboardingRouter'
import type { EntityType } from '@/types'
import type { EnrichmentCompanyRole } from '@/lib/company-lookup/types'
import { mapEntityType as mapTicEntityType } from '@/lib/company-lookup/entity-type-map'
import { flowFromIntent } from '@/lib/onboarding/intents'
import { getActiveCompanyId } from '@/lib/company/context'

export const dynamic = 'force-dynamic'

export async function findCompanyRoleByOrgNumber(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  orgNumber: string,
): Promise<{ legalName: string; legalEntityType: string } | null> {
  const { data } = await supabase
    .from('bankid_enrichment')
    .select('company_roles')
    .eq('user_id', userId)
    .maybeSingle()

  const roles = (data?.company_roles ?? []) as EnrichmentCompanyRole[]
  if (!Array.isArray(roles) || roles.length === 0) return null

  const match = roles.find(
    (role) => role.companyRegistrationNumber.replace(/[\s-]/g, '') === orgNumber,
  )
  return match ? { legalName: match.legalName, legalEntityType: match.legalEntityType } : null
}

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ org_number?: string; flow?: string; intent?: string; workspace?: string; add?: string }>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const params = await searchParams
  const activeCompanyId = await getActiveCompanyId(supabase, user.id)
  const flow = params.flow ?? flowFromIntent(params.intent) ?? undefined
  const initialOrgNumber = params.org_number?.replace(/[\s-]/g, '') ?? undefined

  // A claimed signup must always recover through the provisioning flow instead
  // of reopening the legacy company creator.
  if (!activeCompanyId) {
    const service = createServiceClient()
    const { data: pendingDraft } = await service
      .from('signup_drafts')
      .select('status')
      .eq('claimed_by_user_id', user.id)
      .in('status', ['ready_for_first_login', 'provisioning', 'failed'])
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (pendingDraft) redirect('/onboarding/problem')
  }

  // An existing company uses the flexible start router. It never returns an
  // authenticated user to /register; product choices become workspace actions.
  if (activeCompanyId && params.add !== 'company' && !initialOrgNumber) {
    const [{ data: company }, { data: agencyMembership }, { data: session }] = await Promise.all([
      supabase.from('companies').select('name').eq('id', activeCompanyId).maybeSingle(),
      supabase.from('agency_members').select('agency_id').eq('user_id', user.id).eq('status', 'active').limit(1).maybeSingle(),
      supabase
        .from('onboarding_sessions')
        .select('path')
        .eq('company_id', activeCompanyId)
        .eq('user_id', user.id)
        .in('status', ['draft', 'in_progress'])
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])

    return (
      <NordklartOnboardingRouter
        selectedFlow={flow ?? session?.path ?? null}
        isAgencyWorkspace={Boolean(agencyMembership)}
        companyName={company?.name ?? null}
      />
    )
  }

  // Legacy creation remains available only when a signed-in user explicitly
  // asks to add another accounting company.
  const [{ data: profile }, { data: teamMembership }] = await Promise.all([
    supabase.from('profiles').select('full_name').eq('id', user.id).single(),
    supabase.from('team_members').select('team_id').eq('user_id', user.id).limit(1).maybeSingle(),
  ])

  let teamId = teamMembership?.team_id
  if (!teamId) {
    const { data: newTeamId } = await supabase.rpc('ensure_user_team')
    teamId = newTeamId
  }
  if (!teamId) redirect('/login')

  let initialEntityType: EntityType | undefined
  let initialLegalName: string | undefined
  let preverifiedOrgNumber: string | undefined
  if (initialOrgNumber) {
    const match = await findCompanyRoleByOrgNumber(supabase, user.id, initialOrgNumber)
    if (match) {
      initialEntityType = mapTicEntityType(match.legalEntityType) ?? undefined
      initialLegalName = match.legalName
      preverifiedOrgNumber = initialOrgNumber
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center px-5 py-8">
      <WelcomeOnboarding
        firstName={profile?.full_name?.split(' ')[0] || null}
        teamId={teamId}
        skipWelcome
        hasExistingCompanies={Boolean(activeCompanyId)}
        initialOrgNumber={initialOrgNumber}
        initialEntityType={initialEntityType}
        initialLegalName={initialLegalName}
        preverifiedOrgNumber={preverifiedOrgNumber}
      />
    </main>
  )
}
