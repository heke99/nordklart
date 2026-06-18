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

/**
 * Claims a pre-registration draft only after Supabase has authenticated the
 * user. The database function validates the email and one-time token and then
 * creates the company/agency atomically.
 */
export async function provisionSignupDraft(params: {
  draftId: string
  userId: string
  token: string
}): Promise<ProvisionedSignupWorkspace | null> {
  const service = createServiceClient()
  const { data, error } = await service.rpc('provision_signup_draft', {
    p_draft_id: params.draftId,
    p_user_id: params.userId,
    p_token_hash: hashSignupDraftToken(params.token),
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
