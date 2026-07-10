import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { shouldEnforceMfa } from '@/lib/auth/mfa'
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale } from '@/i18n/config'
import { userHasPassword } from '@/lib/auth/has-password'
import { isPublicAuthPath, isPublicMarketingPath } from '@/lib/auth/route-access'

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

  // If the refresh token is stale/invalid, clear the session cookies
  // so the browser stops sending them on every request.
  // Skip on auth routes — the callback needs PKCE cookies intact.
  if (authError && !user && !pathname.startsWith('/auth')) {
    await supabase.auth.signOut()
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
    const { companyId: companyIdForMfa } = await resolveCompanyForMiddleware(supabase, user.id, request)
    if (companyIdForMfa) {
      const { data: factors } = await supabase.auth.mfa.listFactors()
      const hasVerifiedFactor = factors?.totp?.some(f => f.status === 'verified')

      if (!hasVerifiedFactor) {
        return NextResponse.redirect(new URL('/mfa/enroll', request.url))
      }
    }
  }

  // Forward the pathname so server layouts can branch on it (e.g. render a
  // no-company shell for /settings/account).
  supabaseResponse.headers.set('x-pathname', pathname)

  // Company context resolution
  const cookieCompanyId = request.cookies.get('nordklart-company-id')?.value
  const { companyId, locale: dbLocale } = await resolveCompanyForMiddleware(supabase, user.id, request)

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

    const { data: enrichmentRow } = await supabase
      .from('extension_data')
      .select('id')
      .eq('user_id', user.id)
      .eq('extension_id', 'tic')
      .eq('key', 'bankid_enrichment')
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
