import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { provisionVerifiedSignupDraft } from '@/lib/signup/provision'
import { createLogger } from '@/lib/logger'

const log = createLogger('api/auth/signup-draft')

/**
 * Safe recovery endpoint for a verified account whose workspace setup failed.
 * It has no browser-controlled draft id and the database returns an existing
 * workspace instead of ever creating a duplicate.
 */
export async function POST() {
  const auth = await requireAuth()
  if (auth.error) return auth.error

  const { user } = auth

  try {
    const result = await provisionVerifiedSignupDraft(user.id)

    if (result.state === 'not_required') {
      return NextResponse.json({ state: 'not_required', error: 'Det finns ingen installation att fortsätta.' }, { status: 404 })
    }

    if (result.state === 'in_progress') {
      return NextResponse.json({ state: result.state, reference: result.reference }, { status: 409 })
    }

    if (result.state === 'failed') {
      return NextResponse.json(
        {
          state: result.state,
          reference: result.reference,
          error: 'Installationen kunde inte slutföras ännu. Försök igen om en stund.',
        },
        { status: 422 },
      )
    }

    const metadata = { ...(user.user_metadata ?? {}) }
    delete metadata.signup_draft_id
    delete metadata.signup_draft_token
    delete metadata.signup_state

    try {
      await createServiceClient().auth.admin.updateUserById(user.id, { user_metadata: metadata })
    } catch {
      // Recovery must not fail because metadata cleanup is unavailable.
    }

    return NextResponse.json({ ...result.workspace, reference: result.reference })
  } catch (error) {
    log.error('unexpected provisioning transport failure', {
      userId: user.id,
      message: error instanceof Error ? error.message : 'unknown',
    })
    return NextResponse.json({ error: 'Vi kunde inte fortsätta installationen just nu.' }, { status: 503 })
  }
}
