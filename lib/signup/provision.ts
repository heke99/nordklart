import 'server-only'

import { createHash } from 'crypto'
import { createServiceClient } from '@/lib/supabase/server'

export type ProvisionedSignupWorkspace = {
  companyId: string
  agencyId: string | null
  workspaceType: 'company' | 'agency'
  onboardingPath: string
}

export type SignupProvisioningResult =
  | { state: 'not_required' }
  | { state: 'in_progress'; reference: string | null }
  | { state: 'failed'; reference: string | null }
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
 * Creates or resumes the authenticated user's own signup workspace. The
 * database resolves the draft from the user id, locks it and is idempotent;
 * the browser never sends a draft id or an activation token.
 */
export async function provisionVerifiedSignupDraft(userId: string): Promise<SignupProvisioningResult> {
  const service = createServiceClient()
  const { data, error } = await service.rpc('provision_verified_signup_draft_v2', {
    p_user_id: userId,
  })
  if (error) throw error

  const row = Array.isArray(data) ? data[0] : null
  if (!row) return { state: 'not_required' }

  const reference = typeof row.provision_reference === 'string' ? row.provision_reference : null
  if (row.provision_state === 'in_progress') return { state: 'in_progress', reference }
  if (row.provision_state === 'failed') return { state: 'failed', reference }
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
