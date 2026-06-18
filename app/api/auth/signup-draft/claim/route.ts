import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { provisionSignupDraft } from '@/lib/signup/provision'

/** Claims a signup draft for auto-confirmed/local signup sessions. */
export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const draftId = typeof user.user_metadata?.signup_draft_id === 'string'
    ? user.user_metadata.signup_draft_id
    : null
  const draftToken = typeof user.user_metadata?.signup_draft_token === 'string'
    ? user.user_metadata.signup_draft_token
    : null

  if (!draftId || !draftToken) {
    return NextResponse.json({ error: 'Ingen registrering väntar på aktivering.' }, { status: 400 })
  }

  try {
    const workspace = await provisionSignupDraft({ draftId, userId: user.id, token: draftToken })
    if (!workspace) return NextResponse.json({ error: 'Kunde inte aktivera arbetsytan.' }, { status: 409 })
    return NextResponse.json(workspace)
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[signup-draft/claim] failed', error)
    return NextResponse.json({ error: 'Kunde inte aktivera arbetsytan.' }, { status: 500 })
  }
}
