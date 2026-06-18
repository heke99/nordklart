import { NextResponse } from 'next/server'
import { createServiceClient, createClient } from '@/lib/supabase/server'
import { provisionVerifiedSignupDraft } from '@/lib/signup/provision'

/**
 * Called immediately after a normal password login. It never accepts a draft
 * id from the browser; the database resolves the authenticated user's own
 * ready draft and provisions it at most once.
 */
export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const workspace = await provisionVerifiedSignupDraft(user.id)
    if (!workspace) return new NextResponse(null, { status: 204 })

    const metadata = { ...(user.user_metadata ?? {}) }
    delete metadata.signup_draft_id
    delete metadata.signup_draft_token
    delete metadata.signup_state

    try {
      await createServiceClient().auth.admin.updateUserById(user.id, { user_metadata: metadata })
    } catch {
      // The draft is already atomically claimed; stale metadata has no power.
    }

    return NextResponse.json(workspace)
  } catch (error) {
    console.error('[signup-draft/claim] failed', error)
    return NextResponse.json({ error: 'Kunde inte aktivera arbetsytan.' }, { status: 500 })
  }
}
