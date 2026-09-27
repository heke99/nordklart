import type { SupabaseClient } from '@supabase/supabase-js'
import { hashInviteToken } from '@/lib/auth/invite-tokens'

export type AcceptInvitationResult =
  | { ok: true; type: 'company'; companyId: string; role: string }
  | { ok: true; type: 'agency'; agencyId: string; companyId: string | null; role: string }
  | { ok: false; error: AcceptInvitationError; status: number; message: string }

export type AcceptInvitationError =
  | 'not_found'
  | 'not_pending'
  | 'expired'
  | 'email_mismatch'
  | 'role_not_invitable'
  | 'company_unavailable'
  | 'agency_unavailable'
  | 'membership_suspended'
  | 'user_not_found'
  | 'unavailable'

const ERRORS: Record<AcceptInvitationError, { status: number; message: string }> = {
  not_found: { status: 404, message: 'Inbjudan hittades inte eller är ogiltig.' },
  not_pending: { status: 409, message: 'Inbjudan har redan använts eller återkallats.' },
  expired: { status: 410, message: 'Inbjudan har gått ut. Be om en ny inbjudan.' },
  email_mismatch: { status: 403, message: 'Du är inloggad med en annan e-postadress än den inbjudan gäller.' },
  role_not_invitable: { status: 400, message: 'Inbjudan är ogiltig.' },
  company_unavailable: { status: 410, message: 'Företaget är inte längre aktivt.' },
  agency_unavailable: { status: 410, message: 'Byrån är inte längre aktiv.' },
  membership_suspended: { status: 403, message: 'Din åtkomst är pausad. Kontakta den som bjöd in dig.' },
  user_not_found: { status: 401, message: 'Kontot hittades inte.' },
  unavailable: { status: 503, message: 'Kunde inte acceptera inbjudan just nu. Försök igen.' },
}

export function acceptInvitationFailure(error: AcceptInvitationError): Extract<AcceptInvitationResult, { ok: false }> {
  return { ok: false, error, ...ERRORS[error] }
}

/**
 * Accepts a company or agency invitation for `userId` through the atomic
 * accept_invitation RPC. The caller must already have authenticated the user
 * (and, on hosted, checked MFA); `serviceClient` must be a service-role client.
 */
export async function acceptInvitation(
  serviceClient: SupabaseClient,
  token: string,
  userId: string,
): Promise<AcceptInvitationResult> {
  const { data, error } = await serviceClient.rpc('accept_invitation', {
    p_token_hash: hashInviteToken(token),
    p_user_id: userId,
  })
  if (error || !data || typeof data !== 'object') return acceptInvitationFailure('unavailable')

  const row = data as {
    ok: boolean
    error?: string
    type?: 'company' | 'agency'
    company_id?: string | null
    agency_id?: string
    role?: string
  }
  if (!row.ok) {
    const code = (row.error && row.error in ERRORS ? row.error : 'unavailable') as AcceptInvitationError
    return acceptInvitationFailure(code)
  }
  if (row.type === 'agency') {
    return { ok: true, type: 'agency', agencyId: row.agency_id!, companyId: row.company_id ?? null, role: row.role! }
  }
  return { ok: true, type: 'company', companyId: row.company_id!, role: row.role! }
}
