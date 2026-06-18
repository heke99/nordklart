import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { provisionVerifiedSignupDraft } from '@/lib/signup/provision'
import { createLogger } from '@/lib/logger'

const log = createLogger('api/auth/signup-draft')

/**
 * Activates only the authenticated user's verified signup draft. The database
 * owns draft selection and idempotency; the browser never provides a draft id.
 */
export async function POST() {
  const auth = await requireAuth()
  if (auth.error) return auth.error

  const { user } = auth

  try {
    const result = await provisionVerifiedSignupDraft(user.id)

    if (result.state === 'not_required') return new NextResponse(null, { status: 204 })

    if (result.state === 'in_progress') {
      return NextResponse.json(
        { state: result.state, reference: result.reference, error: 'Installationen pågår redan.' },
        { status: 409 },
      )
    }

    if (result.state === 'failed') {
      return NextResponse.json(
        {
          state: result.state,
          reference: result.reference,
          error: 'Vi kunde inte skapa arbetsytan just nu. Du kan försöka igen utan att skapa ett nytt konto.',
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
      // Provisioning is already complete and draft selection is server-owned.
      // Stale metadata cannot create another workspace.
    }

    return NextResponse.json({ ...result.workspace, reference: result.reference })
  } catch (error) {
    log.error('unexpected provisioning transport failure', {
      userId: user.id,
      message: error instanceof Error ? error.message : 'unknown',
    })
    return NextResponse.json(
      { state: 'failed', error: 'Vi kunde inte starta installationen just nu. Försök igen.' },
      { status: 503 },
    )
  }
}
