import { createServerClient } from '@supabase/ssr'
import { isAuthApiError } from '@supabase/supabase-js'
import { NextResponse, type NextRequest } from 'next/server'
import {
  ACTIVITY_COOKIE,
  evaluateSessionAge,
  latestAuthenticationAt,
  serverCookiesSecure,
  sessionIdleTimeoutMs,
  supabaseCookieOptions,
} from '@/lib/auth/session-policy'
import { shouldEnforceMfa } from '@/lib/auth/mfa'
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale } from '@/i18n/config'
import { userHasPassword } from '@/lib/auth/has-password'
import { isPublicAuthPath, isPublicMarketingPath } from '@/lib/auth/route-access'
import {
  LEGAL_ACCEPT_PATH,
  LEGAL_ACK_COOKIE,
  LEGAL_ACK_MAX_AGE_SECONDS,
  isLegalGateExempt,
  signLegalAck,
  verifyLegalAck,
} from '@/lib/legal/acceptance-gate'

export async function updateSession(request: NextRequest) {
  const pathname = request.nextUrl.pathname

  // Marketing and auth-entry pages must render independently of Supabase.
  // Calling getUser() before classifying the route made `/`, `/login` and
  // `/register` hang whenever the auth endpoint was slow or misconfigured.
  // Auth callbacks handle their own PKCE exchange, and the login/register
  // clients inspect any existing session after the page has rendered.
  if (isPublicMarketingPath(pathname) || isPublicAuthPath(pathname)) {
    const response = NextResponse.next({ request })
    response.headers.set('x-pathname', pathname)

    // The active company is authoritative in user_preferences. Clearing this
    // legacy cookie on auth entry pages prevents a shared browser from carrying
    // stale company context into the next account.
    if (pathname === '/login' || pathname === '/register') {
      response.cookies.set('nordklart-company-id', '', { path: '/', maxAge: 0 })
    }
    return response
  }

  let supabaseResponse = NextResponse.next({
    request,
  })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: supabaseCookieOptions(serverCookiesSecure()),
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = NextResponse.next({
            request,
          })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // IMPORTANT: Avoid writing any logic between createServerClient and
  // supabase.auth.getUser(). A simple mistake could make it very hard to debug
  // issues with users being randomly logged out.

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  supabaseResponse.headers.set('x-pathname', pathname)

  // If the refresh token is stale/invalid, clear this browser's session
  // cookies so it stops sending them on every request. Only for a definite
  // rejection by the auth server, and only locally: the default (global)
  // scope would revoke every session of the user on a transient error.
  // Skip on auth routes — the callback needs PKCE cookies intact.
  if (
    authError && !user && !pathname.startsWith('/auth')
    && isAuthApiError(authError) && [400, 401, 403].includes(authError.status ?? 0)
  ) {
    await supabase.auth.signOut({ scope: 'local' })
  }

  // Invite pages — accessible to everyone, signed in or not. A user who
  // already has an account and is signed in should still be able to land on
  // /invite/[token] to accept the invite with one click (see
  // app/invite/[token]/page.tsx). If we bounce them to '/', they never see
  // the invite at all.
  if (pathname.startsWith('/invite')) {
    return supabaseResponse
  }

  // Reset-password is reachable in both auth states. The recovery flow lands
  // here with a fresh session (created by the OTP exchange in /auth/callback)
  // precisely so the user can call supabase.auth.updateUser({ password }). If
  // we bounce authenticated users to '/', the recovery email link silently
  // fails. An already-logged-in user typing /reset-password directly just gets
  // the same "change password" experience as in settings — no security loss.
  if (pathname.startsWith('/reset-password')) {
    return supabaseResponse
  }

  // Protected routes - require authentication
  if (!user) {
    const requestedPath = `${request.nextUrl.pathname}${request.nextUrl.search}`
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.search = ''
    url.searchParams.set('next', requestedPath)
    const redirect = NextResponse.redirect(url)
    // Session is gone (logout / expiry) — clear the company context cookie so
    // the next account on this browser never inherits a stale company id.
    if (request.cookies.get('nordklart-company-id')) {
      redirect.cookies.set('nordklart-company-id', '', { path: '/', maxAge: 0 })
    }
    return redirect
  }

  // Session lifetime: idle and absolute timeouts on top of Supabase's
  // refresh tokens, which never expire by themselves.
  const { data: aalForAge } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  const lastActivityRaw = Number(request.cookies.get(ACTIVITY_COOKIE)?.value)
  const now = Date.now()
  const verdict = evaluateSessionAge({
    authenticatedAt: latestAuthenticationAt(aalForAge?.currentAuthenticationMethods),
    lastActivityAt: Number.isFinite(lastActivityRaw) && lastActivityRaw > 0 ? lastActivityRaw : null,
    now,
  })
  if (verdict !== 'ok') {
    await supabase.auth.signOut({ scope: 'local' })
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.search = ''
    url.searchParams.set('reason', 'session_expired')
    url.searchParams.set('next', `${request.nextUrl.pathname}${request.nextUrl.search}`)
    const redirect = NextResponse.redirect(url)
    // Carry the cleared auth cookies set by signOut.
    supabaseResponse.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie))
    redirect.cookies.set(ACTIVITY_COOKIE, '', { path: '/', maxAge: 0 })
    redirect.cookies.set('nordklart-company-id', '', { path: '/', maxAge: 0 })
    return redirect
  }
  supabaseResponse.cookies.set(ACTIVITY_COOKIE, String(now), {
    path: '/',
    httpOnly: true,
    secure: serverCookiesSecure(),
    sameSite: 'lax',
    maxAge: Math.floor(sessionIdleTimeoutMs() / 1000),
  })

  // /mfa/enroll: gate behind has-password. BankID-only users who reach this
  // page can lock themselves out — Supabase requires AAL2 to change password
  // or unenroll MFA, and AAL2 needs a prior password sign-in. Force them to
  // set a password first. The /account/set-password page does that and routes
  // back here via ?returnTo. Thread the inner returnTo through so the user
  // ends up on their original destination after the full chain completes.
  if (pathname.startsWith('/mfa/enroll')) {
    if (!userHasPassword(user)) {
      const innerReturnTo = request.nextUrl.searchParams.get('returnTo')
      const mfaTarget = `/mfa/enroll${
        innerReturnTo ? `?returnTo=${encodeURIComponent(innerReturnTo)}` : ''
      }`
      return NextResponse.redirect(
        new URL(
          `/account/set-password?returnTo=${encodeURIComponent(mfaTarget)}`,
          request.url,
        ),
      )
    }
    return supabaseResponse
  }

  // Other MFA pages — accessible to authenticated users (AAL1+), skip MFA enforcement
  if (pathname.startsWith('/mfa/')) {
    return supabaseResponse
  }

  // /account/set-password is the escape hatch from the BankID/MFA lockout
  // and must be reachable even when the user has no company yet (e.g. mid-
  // onboarding) and is at AAL1.
  if (pathname.startsWith('/account/set-password')) {
    return supabaseResponse
  }

  // Resolved once per request: the MFA gate and the company context below both
  // need it, and each resolution is two round trips.
  let resolvedCompany: Awaited<ReturnType<typeof resolveCompanyForMiddleware>> | null = null
  const getResolvedCompany = async () =>
    (resolvedCompany ??= await resolveCompanyForMiddleware(supabase, user.id, request))

  // MFA enforcement (application-side only, not RLS)
  if (shouldEnforceMfa(user)) {
    const { data: aal, error: aalError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()

    // Fail closed: an unresolvable assurance level must not bypass MFA.
    if (aalError) {
      return NextResponse.redirect(new URL('/mfa/verify', request.url))
    }

    // User has MFA enrolled but hasn't verified this session → redirect to verify
    if (aal?.nextLevel === 'aal2' && aal?.currentLevel === 'aal1') {
      return NextResponse.redirect(new URL('/mfa/verify', request.url))
    }

    // MFA required but user has no factor enrolled yet → force enrollment
    // Skip for users with no companies (still setting up)
    const { companyId: companyIdForMfa } = await getResolvedCompany()
    // Agency staff without a client company still hold access to client data
    // through the agency view, so they are not "still setting up".
    const needsFactor = companyIdForMfa
      ? true
      : Boolean((await supabase
          .from('agency_members')
          .select('agency_id')
          .eq('user_id', user.id)
          .eq('status', 'active')
          .limit(1)
          .maybeSingle()).data)
    if (needsFactor) {
      const { data: factors } = await supabase.auth.mfa.listFactors()
      const hasVerifiedFactor = factors?.totp?.some(f => f.status === 'verified')

      if (!hasVerifiedFactor) {
        return NextResponse.redirect(new URL('/mfa/enroll', request.url))
      }
    }
  }

  // Terms re-acceptance: a new version of the terms or privacy policy must be
  // accepted before anything else. Runs before company resolution so a user
  // without a company can still reach the acceptance page.
  if (!(await verifyLegalAck(request.cookies.get(LEGAL_ACK_COOKIE)?.value, user.id))) {
    const { data: pending, error: pendingError } = await supabase.rpc('pending_legal_documents')
    if (pendingError) {
      // Do not lock everyone out on a transient error; no cookie is set, so
      // the next request asks again.
    } else if ((pending?.length ?? 0) > 0) {
      if (!isLegalGateExempt(pathname)) {
        const url = request.nextUrl.clone()
        url.pathname = LEGAL_ACCEPT_PATH
        url.search = ''
        url.searchParams.set('next', `${request.nextUrl.pathname}${request.nextUrl.search}`)
        const redirect = NextResponse.redirect(url)
        supabaseResponse.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie))
        return redirect
      }
    } else {
      const ack = await signLegalAck(user.id)
      if (ack) {
        supabaseResponse.cookies.set(LEGAL_ACK_COOKIE, ack, {
          path: '/',
          httpOnly: true,
          secure: serverCookiesSecure(),
          sameSite: 'lax',
          maxAge: LEGAL_ACK_MAX_AGE_SECONDS,
        })
      }
    }
  }
  if (pathname.startsWith(LEGAL_ACCEPT_PATH)) {
    return supabaseResponse
  }

  // Forward the pathname so server layouts can branch on it (e.g. render a
  // no-company shell for /settings/account).
  supabaseResponse.headers.set('x-pathname', pathname)

  // Company context resolution
  const cookieCompanyId = request.cookies.get('nordklart-company-id')?.value
  const { companyId, locale: dbLocale } = await getResolvedCompany()

  // If the cookie pointed at a company we can no longer resolve (e.g.
  // archived), clear it so the browser stops sending it.
  if (cookieCompanyId && cookieCompanyId !== companyId) {
    supabaseResponse.cookies.set('nordklart-company-id', '', { path: '/', maxAge: 0 })
  }

  // Sync the locale cookie from user_preferences. This keeps next-intl's
  // request config (which reads the cookie) consistent with the DB value
  // without forcing every RSC render to query the database itself.
  const cookieLocale = request.cookies.get(LOCALE_COOKIE)?.value
  const effectiveLocale = isLocale(dbLocale) ? dbLocale : DEFAULT_LOCALE
  if (cookieLocale !== effectiveLocale) {
    supabaseResponse.cookies.set(LOCALE_COOKIE, effectiveLocale, {
      path: '/',
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 60 * 24 * 365,
    })
  }

  // Routes that stay accessible when the user has no active company.
  // Needed so a user who archived their last company can still delete
  // their account without being trapped on /onboarding forever.
  const isNoCompanyAllowed =
    pathname.startsWith('/onboarding') ||
    pathname.startsWith('/select-company') ||
    pathname.startsWith('/settings/account') ||
    pathname.startsWith('/api/account/') ||
    pathname.startsWith('/api/company') ||
    // Users whose signup resolved to a pending access request (duplicate org
    // number) have no company yet — they must be able to reach the pending
    // page instead of being bounced back into /onboarding.
    pathname.startsWith('/access-pending')

  // No companies — redirect to the picker if we have BankID enrichment for
  // this user, otherwise the manual wizard. Either way, allow the escape-hatch
  // routes to pass through.
  if (!companyId) {
    if (isNoCompanyAllowed) {
      return supabaseResponse
    }

    // Agency staff reach client companies only through agency_clients; a new
    // staff member of an agency without clients yet has no company but does
    // have a workspace: the agency view. Never send them to create a company.
    const { data: agencyMembership } = await supabase
      .from('agency_members')
      .select('agency_id')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .limit(1)
      .maybeSingle()
    if (agencyMembership) {
      if (pathname.startsWith('/agency') || pathname.startsWith('/settings/account')) {
        return supabaseResponse
      }
      return NextResponse.redirect(new URL('/agency', request.url))
    }

    // Enrichment lives in its own table since 20260506160000. It used to sit in
    // extension_data, but 20260330130000 re-keyed that table on company_id —
    // and a user with no company has no row there by definition, so this probe
    // matched nothing and every BankID user was sent to the manual wizard
    // instead of the company picker.
    const { data: enrichmentRow } = await supabase
      .from('bankid_enrichment')
      .select('user_id')
      .eq('user_id', user.id)
      .maybeSingle()

    const destination = enrichmentRow ? '/select-company' : '/onboarding'
    return NextResponse.redirect(new URL(destination, request.url))
  }

  // Set company cookie on the response so downstream requests have it
  supabaseResponse.cookies.set('nordklart-company-id', companyId, {
    path: '/',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365,
  })

  // Allow access to onboarding (for adding new companies), select-company, and companies/new
  if (pathname.startsWith('/select-company') || pathname.startsWith('/companies/new') || pathname.startsWith('/onboarding')) {
    return supabaseResponse
  }

  return supabaseResponse
}

/**
 * Resolve the active company for the authenticated user.
 *
 * Resolution: user_preferences → first non-archived membership.
 *
 * `user_preferences.active_company_id` is the authoritative source for
 * the active company on both the Next.js and Postgres side. The
 * `nordklart-company-id` cookie is still refreshed for legacy read paths
 * but it is no longer READ here — the database cannot see cookies, so
 * letting the cookie override user_preferences would re-introduce the
 * divergence this migration exists to fix.
 *
 * When we fall back to "first membership" (no user_preferences row yet),
 * we also upsert user_preferences so subsequent RLS lookups agree with
 * us without needing the fallback scan.
 *
 * Cannot use lib/company/context.ts because middleware runs on Edge.
 */
async function resolveCompanyForMiddleware(
  supabase: ReturnType<typeof createServerClient>,
  userId: string,
  _request: NextRequest
): Promise<{ companyId: string | null; locale: string | null }> {
  const { data: prefs } = await supabase
    .from('user_preferences')
    .select('active_company_id, locale')
    .eq('user_id', userId)
    .maybeSingle()

  const locale = (prefs?.locale as string | undefined) ?? null

  // Prefer the central resolver because it includes agency and platform access.
  // The deployment fallback is deliberately scoped to user_id, rather than
  // relying on RLS alone: a company member can legitimately read fellow
  // members through RLS, which would otherwise make maybeSingle unsafe.
  if (prefs?.active_company_id) {
    const { data: access, error } = await supabase.rpc('resolve_company_access', {
      p_company_id: prefs.active_company_id,
    })
    const row = Array.isArray(access) ? access[0] as { can_read?: boolean } | undefined : undefined
    if (!error && row?.can_read === true) return { companyId: prefs.active_company_id, locale }
  }

  const { data: accessible, error: accessibleError } = await supabase.rpc('list_accessible_companies')
  const first = Array.isArray(accessible)
    ? accessible.find((row) => !(row as { archived_at?: string | null }).archived_at) as { company_id?: string } | undefined
    : undefined

  let companyId = first?.company_id ?? null

  if (!companyId || accessibleError) {
    const { data: memberships } = await supabase
      .from('company_members')
      .select('company_id')
      .eq('user_id', userId)
      .in('status', ['active', 'active_limited'])
      .order('joined_at', { ascending: true })

    const memberIds = Array.from(new Set(
      ((memberships ?? []) as Array<{ company_id: string | null }>)
        .map((membership) => membership.company_id)
        .filter((id): id is string => Boolean(id)),
    ))

    if (memberIds.length > 0) {
      const { data: companies } = await supabase
        .from('companies')
        .select('id')
        .in('id', memberIds)
        .is('archived_at', null)

      const availableIds = new Set(
        ((companies ?? []) as Array<{ id: string }>).map((company) => company.id),
      )
      companyId = prefs?.active_company_id && availableIds.has(prefs.active_company_id)
        ? prefs.active_company_id
        : memberIds.find((id) => availableIds.has(id)) ?? null
    }
  }

  if (!companyId) return { companyId: null, locale }

  await supabase
    .from('user_preferences')
    .upsert(
      { user_id: userId, active_company_id: companyId },
      { onConflict: 'user_id' },
    )

  return { companyId, locale }
}
