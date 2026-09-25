import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { shouldEnforceMfa } from './mfa'
import type { User, SupabaseClient } from '@supabase/supabase-js'

type AuthResult =
  | { user: User; supabase: SupabaseClient; error: null }
  | { user: null; supabase: SupabaseClient; error: NextResponse }

/**
 * Auth + MFA guard for API routes.
 *
 * Returns the authenticated user and Supabase client, or a JSON error response.
 * When MFA is required (hosted deployment), verifies AAL2 assurance level.
 */
export async function requireAuth(): Promise<AuthResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return {
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    }
  }

  if (shouldEnforceMfa(user)) {
    const { data: aal, error: aalError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()

    // Fail closed: if the assurance level cannot be resolved we must not
    // silently skip MFA enforcement — treat it as unverified.
    if (aalError) {
      return {
        user: null,
        supabase,
        error: NextResponse.json({ error: 'MFA verification required' }, { status: 403 }),
      }
    }

    if (aal?.nextLevel === 'aal2' && aal?.currentLevel !== 'aal2') {
      return {
        user: null,
        supabase,
        error: NextResponse.json({ error: 'MFA verification required' }, { status: 403 }),
      }
    }

    // No verified factor at all (nextLevel stays aal1). The middleware sends
    // such a user to /mfa/enroll, but it does not run for /api, so without this
    // an account that never enrolled could use every API route at AAL1. Same
    // carve-out as the middleware: a user with no company yet is still
    // onboarding and needs the API to create one.
    if (aal?.nextLevel !== 'aal2') {
      const { data: anyCompany, error: companyError } = await supabase
        .from('companies')
        .select('id')
        .is('archived_at', null)
        .limit(1)
        .maybeSingle()

      if (companyError || anyCompany) {
        return {
          user: null,
          supabase,
          error: NextResponse.json(
            { error: 'MFA enrollment required', code: 'mfa_enrollment_required' },
            { status: 403 },
          ),
        }
      }
    }
  }

  return { user, supabase, error: null }
}
