'use server'

import { createClient, createServiceClient } from '@/lib/supabase/server'
import { setActiveCompany } from '@/lib/company/context'
import { revalidatePath } from 'next/cache'
import { normalizeOrgNumber } from '@/lib/company-lookup/normalize-org-number'
import { verifyFounder } from '@/lib/company/verify-signatory'

export async function switchCompany(companyId: string): Promise<{ error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return { error: 'Unauthorized' }
  }

  try {
    await setActiveCompany(supabase, user.id, companyId)
    // No revalidatePath — the client performs a hard navigation
    // (window.location.assign) after this action returns, which wipes
    // every React/router/fetch cache wholesale. revalidatePath would be a
    // no-op and would just race with the hard reload.
    return {}
  } catch {
    return { error: 'Du har inte tillgång till detta företag.' }
  }
}

/**
 * Create a company from onboarding wizard data.
 *
 * The founder is verified first (lib/company/verify-signatory.ts): on hosted
 * Nordklart that means BankID, and for an aktiebolag a current representative
 * position in Bolagsverket's register. Everything the company needs — the
 * company row with its org.nr, the owner membership carrying that
 * verification, cash account, chart of accounts, settings, first fiscal year
 * and active company — is then created by ONE database function in one
 * transaction (create_company_for_founder). A failure leaves nothing behind;
 * there is no client-side rollback to go wrong.
 */
export async function createCompanyFromOnboarding(params: {
  teamId: string
  settings: Record<string, unknown>
  fiscalPeriod: {
    startDate: string
    endDate: string
    name: string
  }
  /**
   * Accepted for compatibility with older wizard builds and ignored: company
   * facts are never taken from the browser. companies.tic_snapshot is fetched
   * server-side (ensureTicSnapshot) when a feature needs it.
   */
  ticLookup?: unknown
}): Promise<{ companyId?: string; error?: string; accessRequestPending?: boolean; bankIdRequired?: boolean; verificationPending?: boolean }> {
  try {
    return await createCompanyFromOnboardingImpl(params)
  } catch (err) {
    // A thrown error escapes to the client as an opaque server-action
    // exception; log it here and return a localized message instead.
    console.error('[createCompanyFromOnboarding] unexpected error', err)
    return { error: 'Något gick fel när företaget skulle skapas. Försök igen.' }
  }
}

async function createCompanyFromOnboardingImpl(params: {
  teamId: string
  settings: Record<string, unknown>
  fiscalPeriod: { startDate: string; endDate: string; name: string }
}): Promise<{ companyId?: string; error?: string; accessRequestPending?: boolean; bankIdRequired?: boolean; verificationPending?: boolean }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return { error: 'Unauthorized' }
  }

  const entityType = params.settings.entity_type as string | undefined
  if (entityType !== 'enskild_firma' && entityType !== 'aktiebolag') {
    return { error: 'Ogiltig företagsform.' }
  }

  const companyName = (params.settings.company_name as string | undefined) || 'Mitt företag'

  // normalizeOrgNumber returns null for malformed input — refuse rather than
  // store a value that would break SIE/SRU exports later.
  const rawOrgNumber = params.settings.org_number as string | undefined
  const cleanedOrgNumber = normalizeOrgNumber(rawOrgNumber)
  if (rawOrgNumber && rawOrgNumber.trim() && !cleanedOrgNumber) {
    return { error: 'org_number_invalid' }
  }

  const service = createServiceClient()

  const verification = await verifyFounder(service, {
    userId: user.id,
    entityType,
    orgNumber: cleanedOrgNumber,
  })
  if (verification.kind === 'bankid_required') {
    return { bankIdRequired: true, error: 'Identifiera dig med BankID innan företaget skapas.' }
  }

  // An org.nr already in Nordklart: a member simply switches to it; anyone
  // else asks for access. The existing company's name is not disclosed.
  if (cleanedOrgNumber) {
    const { data: existingCompany } = await service
      .from('companies')
      .select('id')
      .eq('org_number', cleanedOrgNumber)
      .is('archived_at', null)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()

    if (existingCompany?.id) {
      const { data: existingMembership } = await service
        .from('company_members')
        .select('id')
        .eq('company_id', existingCompany.id)
        .eq('user_id', user.id)
        .in('status', ['active', 'active_limited'])
        .maybeSingle()

      if (existingMembership) {
        await setActiveCompany(supabase, user.id, existingCompany.id)
        return { companyId: existingCompany.id }
      }

      const { data: request } = await service.from('company_access_requests').upsert({
        company_id: existingCompany.id,
        requester_user_id: user.id,
        requester_email: user.email?.toLowerCase() ?? '',
        requested_role: 'admin',
        status: 'pending',
        message: 'Begäran skapad från inloggad onboarding när orgnumret redan fanns i Nordklart.',
      }, { onConflict: 'company_id,requester_user_id' }).select('id').maybeSingle()

      if (request?.id) {
        // A verified signatory is never gated by an unverified owner.
        await service.rpc('flag_access_request_for_verified_founder', {
          p_request_id: request.id,
          p_status: verification.status,
        })
      }

      return {
        accessRequestPending: true,
        error: 'Bolaget finns redan i Nordklart. En ägare eller administratör behöver godkänna din åtkomst.',
      }
    }
  }

  const { data: newCompanyId, error: createError } = await service.rpc('create_company_for_founder', {
    p_user_id: user.id,
    p_name: companyName,
    p_entity_type: entityType,
    p_team_id: params.teamId || null,
    p_org_number: cleanedOrgNumber,
    p_settings: params.settings,
    p_period_start: params.fiscalPeriod.startDate,
    p_period_end: params.fiscalPeriod.endDate,
    p_period_name: params.fiscalPeriod.name,
    p_verification_status: verification.status,
    p_verification_reason: verification.reason,
    p_verification_evidence: verification.evidence,
  })

  if (createError || !newCompanyId) {
    console.error('[createCompanyFromOnboarding] company creation failed', createError)
    if (createError?.code === '23505') {
      return { error: 'Bolaget finns redan i Nordklart. Begär åtkomst till det befintliga bolaget.' }
    }
    if (createError?.code === '42501') {
      return { error: 'Du har inte behörighet att skapa företaget i det valda teamet.' }
    }
    return { error: 'Kunde inte skapa företag. Försök igen.' }
  }

  // The RPC already set user_preferences.active_company_id; this keeps the
  // legacy cookie in sync for readers that still use it.
  try {
    await setActiveCompany(supabase, user.id, newCompanyId as string)
  } catch (err) {
    console.error('[createCompanyFromOnboarding] setActiveCompany failed', err)
  }

  revalidatePath('/')
  return {
    companyId: newCompanyId as string,
    verificationPending: verification.status === 'manual_review',
  }
}
