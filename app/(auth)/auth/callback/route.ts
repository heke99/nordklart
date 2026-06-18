import { createServerClient } from '@supabase/ssr'
import { type NextRequest, NextResponse } from 'next/server'
import { hashInviteToken } from '@/lib/auth/invite-tokens'
import {
  authCallbackErrorParam,
  classifyAuthCallbackFailure,
  defaultRedirectForAuthFlow,
  isAuthOtpType,
  resolveAuthCallbackFlow,
  safeAuthRedirectPath,
  type AuthCallbackMethod,
} from '@/lib/auth/auth-callback'
import { recordAuthCallbackAudit } from '@/lib/auth/callback-audit'
import { createLogger } from '@/lib/logger'
import { markSignupDraftEmailVerified } from '@/lib/signup/provision'
import { createServiceClient } from '@/lib/supabase/server'

const log = createLogger('auth/callback')

type PendingCookie = {
  name: string
  value: string
  options: Record<string, unknown>
}

function applyPendingCookies(response: NextResponse, cookies: PendingCookie[]) {
  for (const { name, value, options } of cookies) {
    response.cookies.set({ name, value, ...options })
  }
  return response
}

function callbackFailureResponse(origin: string, errorParam: string, cookies: PendingCookie[]) {
  const url = new URL('/login', origin)
  url.searchParams.set('auth_error', errorParam)
  return applyPendingCookies(NextResponse.redirect(url), cookies)
}

async function transitionSignupMetadata(user: {
  id: string
  user_metadata?: Record<string, unknown> | null
}, draftId: string) {
  const metadata = { ...(user.user_metadata ?? {}) }
  metadata.signup_draft_id = draftId
  metadata.signup_state = 'password_required'
  delete metadata.signup_draft_token

  await createServiceClient().auth.admin.updateUserById(user.id, {
    user_metadata: metadata,
  })
}


export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const tokenHash = searchParams.get('token_hash')
  const otpType = searchParams.get('type')
  const requestedNext = searchParams.get('next')
  const flow = resolveAuthCallbackFlow({
    type: otpType,
    flow: searchParams.get('flow'),
    next: requestedNext,
  })
  const fallbackPath = defaultRedirectForAuthFlow(flow)
  const safeNext = safeAuthRedirectPath(requestedNext, fallbackPath)

  // Supabase can rotate session cookies while handling a verification. Copy
  // them onto every redirect response, including errors.
  const pendingCookies: PendingCookie[] = []

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          pendingCookies.length = 0
          cookiesToSet.forEach((cookie) => {
            request.cookies.set(cookie.name, cookie.value)
            pendingCookies.push(cookie)
          })
        },
      },
    },
  )

  let method: AuthCallbackMethod = 'none'
  let authError: unknown = null

  if (code) {
    method = 'pkce_code'
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    authError = error
  } else if (tokenHash && isAuthOtpType(otpType)) {
    method = 'token_hash'
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: otpType,
    })
    authError = error
  } else {
    authError = { message: 'Missing or unsupported auth callback parameters' }
  }

  if (authError) {
    const reason = classifyAuthCallbackFailure(authError)
    await recordAuthCallbackAudit({
      request,
      flow,
      method,
      status: 'failed',
      redirectPath: safeNext,
      reason,
    })
    log.warn('auth callback verification failed', { flow, method, reason })
    return callbackFailureResponse(origin, authCallbackErrorParam(flow), pendingCookies)
  }

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser()

  if (userError || !user) {
    const reason = classifyAuthCallbackFailure(userError ?? { message: 'No authenticated user after callback' })
    await recordAuthCallbackAudit({
      request,
      flow,
      method,
      status: 'failed',
      redirectPath: safeNext,
      reason,
    })
    log.warn('auth callback has no authenticated user', { flow, method, reason })
    return callbackFailureResponse(origin, authCallbackErrorParam(flow), pendingCookies)
  }

  await recordAuthCallbackAudit({
    request,
    flow,
    method,
    status: 'success',
    redirectPath: safeNext,
    userId: user.id,
    email: user.email,
  })

  // A recovery session is deliberately limited to selecting a new password.
  // It must never continue through signup/onboarding or an invite flow.
  if (flow === 'recovery') {
    return applyPendingCookies(
      NextResponse.redirect(new URL('/reset-password', origin)),
      pendingCookies,
    )
  }

  // Confirmation verifies the email only. It must not create a company,
  // team or onboarding session on the device where the email was opened.
  const signupDraftId = typeof user.user_metadata?.signup_draft_id === 'string'
    ? user.user_metadata.signup_draft_id
    : null
  const signupDraftToken = typeof user.user_metadata?.signup_draft_token === 'string'
    ? user.user_metadata.signup_draft_token
    : null

  if (flow === 'signup' && signupDraftId && signupDraftToken) {
    try {
      const verified = await markSignupDraftEmailVerified({
        draftId: signupDraftId,
        userId: user.id,
        token: signupDraftToken,
      })
      if (!verified) throw new Error('signup draft could not be verified')

      await transitionSignupMetadata(user, signupDraftId)
      return applyPendingCookies(
        NextResponse.redirect(new URL('/account/set-password?mode=signup', origin)),
        pendingCookies,
      )
    } catch (error) {
      log.error('signup email verification transition failed', error, { userId: user.id })
      await recordAuthCallbackAudit({
        request,
        flow: 'signup',
        method,
        status: 'failed',
        redirectPath: '/account/set-password?mode=signup',
        reason: 'signup_activation_transition_failed',
        userId: user.id,
        email: user.email,
      })
      return callbackFailureResponse(origin, 'signup_confirmation_failed', pendingCookies)
    }
  }


  if (flow === 'signup') {
    return applyPendingCookies(
      NextResponse.redirect(new URL('/account/set-password?mode=signup', origin)),
      pendingCookies,
    )
  }

  // Keep the legacy company-invitation handoff during the migration to the
  // unified workspace model. This cookie is set by the invite landing page.
  const inviteToken = request.cookies.get('nordklart-invite-token')?.value
  if (inviteToken) {
    try {
      const tokenHash = hashInviteToken(inviteToken)
      const serviceClient = createServiceClient()

      const { data: invite } = await serviceClient
        .from('company_invitations')
        .select('id, company_id, email, role, status, expires_at')
        .eq('token_hash', tokenHash)
        .single()

      if (
        invite &&
        invite.status === 'pending' &&
        new Date(invite.expires_at) > new Date() &&
        user.email?.toLowerCase() === invite.email.toLowerCase()
      ) {
        await serviceClient.from('company_members').insert({
          company_id: invite.company_id,
          user_id: user.id,
          role: invite.role,
          source: 'direct',
        })

        await serviceClient.from('user_preferences').upsert({
          user_id: user.id,
          active_company_id: invite.company_id,
        }, { onConflict: 'user_id' })

        await serviceClient
          .from('company_invitations')
          .update({ status: 'accepted' })
          .eq('id', invite.id)

        const response = applyPendingCookies(
          NextResponse.redirect(new URL('/app', origin)),
          pendingCookies,
        )
        response.cookies.set('nordklart-company-id', invite.company_id, {
          path: '/',
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: 60 * 60 * 24 * 365,
        })
        response.cookies.delete('nordklart-invite-token')
        return response
      }
    } catch (error) {
      log.error('invite acceptance failed', error, { userId: user.id })
      // The user still has a valid session; normal destination handling below
      // avoids turning a non-critical invite retry into an auth failure.
    }
  }

  // Existing team records are still required by legacy paths. Create the
  // silent personal team only for accounts that do not yet have one.
  const { data: teamMembership } = await supabase
    .from('team_members')
    .select('team_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (!teamMembership) {
    const serviceClient = createServiceClient()
    const teamId = crypto.randomUUID()
    await serviceClient.from('teams').insert({
      id: teamId,
      name: 'Personal',
      created_by: user.id,
    })
    await serviceClient.from('team_members').insert({
      team_id: teamId,
      user_id: user.id,
      role: 'owner',
    })
  }

  const { data: membership } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  const redirectPath = membership
  ? '/app'
  : safeNext === '/app'
    ? '/onboarding'
    : safeNext

  return applyPendingCookies(
    NextResponse.redirect(new URL(redirectPath, origin)),
    pendingCookies,
  )
}
