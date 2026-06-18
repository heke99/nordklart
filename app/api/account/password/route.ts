import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { validateBody } from '@/lib/api/validate'
import { createLogger } from '@/lib/logger'

const log = createLogger('api/account/password')

const SetPasswordSchema = z.object({
  password: z
    .string()
    .min(8, 'Lösenordet måste vara minst 8 tecken')
    .refine(
      (v) =>
        /[a-z]/.test(v) &&
        /[A-Z]/.test(v) &&
        /[0-9]/.test(v) &&
        /[^a-zA-Z0-9]/.test(v),
      'Lösenordet måste innehålla versaler, gemener, siffror och specialtecken',
    ),
})

/**
 * POST /api/account/password
 *
 * Server-routed password set/change, then flips `app_metadata.has_password =
 * true` via the service client (clients can't write app_metadata).
 *
 * Two paths depending on whether the user already has a real password:
 *
 *   - First-time set (`app_metadata.has_password !== true`): write via the
 *     admin API. BankID-only users — and legacy users whose `has_password`
 *     flag was set to false by the backfill — sit at AAL1 with a TOTP factor
 *     enrolled, and `updateUser` on the user session would be rejected with
 *     "AAL2 session is required to update email or password when MFA is
 *     enabled". Setting an initial password has no existing credential to
 *     protect, so bypassing AAL2 is safe.
 *
 *   - Change-password (`app_metadata.has_password === true`): write via the
 *     user session so Supabase's AAL2 guard still fires. A stolen AAL1
 *     cookie must not be able to rotate a known password.
 *
 * This route is the single write path for setting a password. SecuritySettings,
 * the reset-password page, and the /account/set-password page all funnel
 * through here so the flag stays in sync — see lib/auth/has-password.ts.
 *
 * If the password update succeeds but the flag write fails, we log and still
 * return success: the user has a working password and the banner will show one
 * more time, but a retry will re-flip the flag.
 */
function requestIp(request: Request): string | null {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || null
}

export async function POST(request: Request) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const result = await validateBody(request, SetPasswordSchema)
  if (!result.success) return result.response
  const { password } = result.data

  const isFirstTimeSet = user.app_metadata?.has_password !== true
  const service = createServiceClient()

  let updateError:
    | { message?: string; status?: number; code?: string }
    | null
    | undefined = null

  if (isFirstTimeSet) {
    const { error } = await service.auth.admin.updateUserById(user.id, {
      password,
    })
    updateError = error
  } else {
    const { error } = await supabase.auth.updateUser({ password })
    updateError = error
  }

  if (updateError) {
    log.warn('password update failed', {
      userId: user.id,
      isFirstTimeSet,
      code: updateError.code,
      status: updateError.status,
    })
    return NextResponse.json(
      {
        error:
          updateError.message ||
          'Kunde inte uppdatera lösenord. Försök igen.',
      },
      { status: 400 },
    )
  }

  // Read-merge-write so we don't wipe sibling app_metadata keys.
  // updateUserById replaces app_metadata wholesale (see lib/auth/has-password.ts
  // and the comment in app/api/account/delete/route.ts).
  let flagWriteOk = false
  try {
    const { data: u } = await service.auth.admin.getUserById(user.id)
    const prior = u?.user?.app_metadata ?? {}
    await service.auth.admin.updateUserById(user.id, {
      app_metadata: { ...prior, has_password: true },
    })
    flagWriteOk = true
  } catch (err) {
    log.error('failed to flip has_password flag after successful password set', {
      userId: user.id,
      err,
    })
    // Don't surface the failure: the user has a working password. The
    // banner will show once more and a retry will succeed.
  }

  const wasFirstTimeSet = isFirstTimeSet
  let signupActivationError = false
  if (wasFirstTimeSet) {
    const { error } = await service.rpc('mark_signup_draft_password_set', {
      p_user_id: user.id,
    })
    if (error) {
      signupActivationError = true
      log.error('signup password activation update failed', error, { userId: user.id })
    }
  }

  try {
    await service.from('auth_audit_events').insert({
      user_id: user.id,
      email: user.email ?? null,
      event_type: wasFirstTimeSet ? 'password_set' : 'password_changed',
      status: signupActivationError ? 'failed' : 'success',
      ip_address: requestIp(request),
      user_agent: request.headers.get('user-agent'),
      metadata: { first_time: wasFirstTimeSet, app_metadata_updated: flagWriteOk },
    })
  } catch {
    // Password writes must not depend on the non-critical audit trail.
  }

  if (signupActivationError) {
    return NextResponse.json({ error: 'Lösenordet sparades, men kontot kunde inte aktiveras. Försök igen.' }, { status: 503 })
  }

  return NextResponse.json({ data: { ok: true } })
}
