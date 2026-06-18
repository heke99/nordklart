import 'server-only'

import { createHash } from 'crypto'
import { createServiceClient } from '@/lib/supabase/server'

export type ProvisionedSignupWorkspace = {
  companyId: string
  agencyId: string | null
  workspaceType: 'company' | 'agency'
  onboardingPath: string
}

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
 * Claims a ready signup only after a successful password login. The database
 * function locks the draft and creates company/agency data atomically, making
 * repeated login clicks safe.
 */
export async function provisionVerifiedSignupDraft(userId: string): Promise<ProvisionedSignupWorkspace | null> {
  const service = createServiceClient()
  const { data, error } = await service.rpc('provision_verified_signup_draft', {
    p_user_id: userId,
  })
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : null
  if (!row) return null

  return {
    companyId: String(row.company_id),
    agencyId: typeof row.agency_id === 'string' ? row.agency_id : null,
    workspaceType: row.workspace_type === 'agency' ? 'agency' : 'company',
    onboardingPath: String(row.onboarding_path),
  }
}
