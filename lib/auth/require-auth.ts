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
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (aal?.nextLevel === 'aal2' && aal?.currentLevel !== 'aal2') {
      return {
        user: null,
        supabase,
        error: NextResponse.json({ error: 'MFA verification required' }, { status: 403 }),
      }
    }
  }

  return { user, supabase, error: null }
}
