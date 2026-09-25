import 'server-only'

import { createHash } from 'crypto'
import { createServiceClient } from '@/lib/supabase/server'
import { verifyFounder } from '@/lib/company/verify-signatory'

export type ProvisionedSignupWorkspace = {
  companyId: string
  agencyId: string | null
  workspaceType: 'company' | 'agency'
  onboardingPath: string
}

export type SignupAccessRequest = {
  companyId: string | null
  companyName: string | null
  accessRequestId: string | null
  workspaceType: 'company' | 'agency'
}

export type SignupProvisioningResult =
  | { state: 'not_required' }
  | { state: 'bankid_required' }
  | { state: 'in_progress'; reference: string | null }
  | { state: 'failed'; reference: string | null }
  | { state: 'access_request_pending'; reference: string | null; request: SignupAccessRequest }
  | { state: 'provisioned'; reference: string | null; workspace: ProvisionedSignupWorkspace }

export function hashSignupDraftToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Marks a verified signup as waiting for its user-chosen password. */
export async function markSignupDraftEmailVerified(params: {
  draftId: string
  userId: string
  token: string
}): Promise<boolean> {
  const service = createServiceClient()
  const { data, error } = await service.rpc('verify_signup_draft_email', {
    p_draft_id: params.draftId,
    p_user_id: params.userId,
    p_token_hash: hashSignupDraftToken(params.token),
  })
  if (error) throw error
  return data === true
}

/**
 * Creates, resumes or converts the authenticated user's verified signup draft.
 * If the requested org number already exists in Nordklart, this returns an
 * access-request state instead of creating another company or owner membership.
 */
export async function provisionVerifiedSignupDraft(userId: string): Promise<SignupProvisioningResult> {
  const service = createServiceClient()

  // Decide the founder verification BEFORE provisioning: the RPC applies it in
  // the same transaction that creates the company (see
  // 20260925112000_company_founder_verification.sql).
  const { data: draft, error: draftError } = await service
    .from('signup_drafts')
    .select('org_number, legal_form, status')
    .eq('claimed_by_user_id', userId)
    .in('status', ['ready_for_first_login', 'provisioning', 'failed', 'provisioned', 'access_request_pending'])
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (draftError) throw draftError
  if (!draft) return { state: 'not_required' }

  let verification: { status: string; reason: string; evidence: Record<string, unknown> } = {
    status: 'self_attested', reason: 'already_provisioned', evidence: {},
  }
  if (draft.status !== 'provisioned' && draft.status !== 'access_request_pending') {
    const decided = await verifyFounder(service, {
      userId,
      entityType: draft.legal_form === 'enskild_firma' ? 'enskild_firma' : 'aktiebolag',
      orgNumber: (draft.org_number as string | null) ?? null,
    })
    if (decided.kind === 'bankid_required') return { state: 'bankid_required' }
    verification = decided
  }

  const { data, error } = await service.rpc('provision_authorized_signup_draft_v5', {
    p_user_id: userId,
    p_verification_status: verification.status,
    p_verification_reason: verification.reason,
    p_verification_evidence: verification.evidence,
  })
  if (error) throw error

  const row = Array.isArray(data) ? data[0] : null
  if (!row) return { state: 'not_required' }

  const reference = typeof row.provision_reference === 'string' ? row.provision_reference : null
  if (row.provision_state === 'in_progress') return { state: 'in_progress', reference }
  if (row.provision_state === 'failed') return { state: 'failed', reference }
  if (row.provision_state === 'access_request_pending') {
    return {
      state: 'access_request_pending',
      reference,
      request: {
        companyId: typeof row.company_id === 'string' ? row.company_id : null,
        companyName: typeof row.existing_company_name === 'string' ? row.existing_company_name : null,
        accessRequestId: typeof row.access_request_id === 'string' ? row.access_request_id : null,
        workspaceType: row.workspace_type === 'agency' ? 'agency' : 'company',
      },
    }
  }

  if (row.provision_state !== 'provisioned' || typeof row.company_id !== 'string' || typeof row.onboarding_path !== 'string') {
    return { state: 'failed', reference }
  }

  return {
    state: 'provisioned',
    reference,
    workspace: {
      companyId: row.company_id,
      agencyId: typeof row.agency_id === 'string' ? row.agency_id : null,
      workspaceType: row.workspace_type === 'agency' ? 'agency' : 'company',
      onboardingPath: row.onboarding_path,
    },
  }
}
