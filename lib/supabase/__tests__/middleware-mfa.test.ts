import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * Middleware MFA enforcement.
 *
 * This is one of exactly two places MFA is enforced application-side — the
 * other is requireAuth() on API routes — and until now it had no test at all.
 * The gap mattered enough to close when Next was upgraded to 16.3.2 partly for
 * an advisory titled "Middleware / Proxy bypass in App Router applications
 * using Turbopack and single locale": a bypass here silently removes the AAL2
 * redirect for every UI page, and nothing would have failed.
 *
 * These pin the redirect decisions rather than the implementation, so they
 * survive refactors and still fail if enforcement is lost.
 */

function makeQuery(): Record<string, unknown> {
  const result = { data: [], error: null }
  const q: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
    maybeSingle: async () => ({ data: null, error: null }),
    single: async () => ({ data: null, error: null }),
  }
  for (const m of ['select', 'eq', 'in', 'order', 'limit', 'neq', 'is']) {
    q[m] = () => q
  }
  return q
}

const getUser = vi.fn()
const getAuthenticatorAssuranceLevel = vi.fn()
const listFactors = vi.fn()
const signOut = vi.fn().mockResolvedValue({ error: null })
const rpc = vi.fn()

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { getUser, signOut, mfa: { getAuthenticatorAssuranceLevel, listFactors } },
    // Chainable stub: every builder method returns the same object, and the
    // chain is awaitable. resolveCompanyForMiddleware chains
    // select/eq/in/order/limit in varying combinations, so mirroring the exact
    // sequence would make the test brittle against a harmless reorder.
    from: () => makeQuery(),
    rpc: (...args: unknown[]) => rpc(...args),
  }),
}))

vi.mock('@/lib/auth/route-access', () => ({
  // Keep the route classification out of these cases: every path under test is
  // an authenticated dashboard page, not marketing or an auth entry point.
  isPublicMarketingPath: () => false,
  isPublicAuthPath: () => false,
}))

import { updateSession } from '../middleware'

function req(path: string): NextRequest {
  return new NextRequest(new URL(`https://app.nordklart.se${path}`))
}

const passwordUser = {
  id: 'user-1',
  app_metadata: { has_password: true },
}

describe('middleware MFA enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', '')
    rpc.mockResolvedValue({ data: null, error: null })
    getUser.mockResolvedValue({ data: { user: passwordUser } })
    listFactors.mockResolvedValue({ data: { totp: [{ status: 'verified' }] } })
  })

  it('redirects an AAL1 session to /mfa/verify', async () => {
    getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal2' },
      error: null,
    })

    const res = await updateSession(req('/dashboard'))

    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('/mfa/verify')
  })

  it('fails closed when the assurance level cannot be resolved', async () => {
    // An unresolvable AAL must not be read as "no step-up needed".
    getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: null,
      error: { message: 'network' },
    })

    const res = await updateSession(req('/dashboard'))

    expect(res.headers.get('location')).toContain('/mfa/verify')
  })

  it('does not send an AAL2 session to an MFA page', async () => {
    getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: 'aal2', nextLevel: 'aal2' },
      error: null,
    })

    const res = await updateSession(req('/dashboard'))

    // Asserted as "not an MFA redirect" rather than "no redirect": this user
    // has no company in the stub, so company resolution legitimately sends
    // them to /onboarding. Pinning the absence of a redirect would be pinning
    // the fixture, not the MFA decision.
    expect(res.headers.get('location') ?? '').not.toContain('/mfa/')
  })

  it('keeps /account/set-password reachable at AAL1', async () => {
    // The documented escape hatch from the BankID/MFA lockout. Redirecting it
    // to /mfa/verify would strand the user with no way to set a password.
    getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal2' },
      error: null,
    })

    const res = await updateSession(req('/account/set-password'))

    expect(res.headers.get('location') ?? '').not.toContain('/mfa/')
  })
})

describe('middleware session lifetime', () => {
  const nowSeconds = () => Math.floor(Date.now() / 1000)

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', '')
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    rpc.mockResolvedValue({ data: null, error: null })
    getUser.mockResolvedValue({ data: { user: passwordUser } })
  })

  function withCookie(path: string, cookie: string): NextRequest {
    return new NextRequest(new URL(`https://app.nordklart.se${path}`), { headers: { cookie } })
  }

  it('signs the browser out once the absolute lifetime has passed', async () => {
    getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal1', currentAuthenticationMethods: [{ method: 'password', timestamp: nowSeconds() - 8 * 24 * 3600 }] },
      error: null,
    })
    const res = await updateSession(req('/dashboard'))
    expect(res.headers.get('location')).toContain('/login?reason=session_expired')
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('signs the browser out after the idle timeout', async () => {
    getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal1', currentAuthenticationMethods: [{ method: 'password', timestamp: nowSeconds() - 3600 }] },
      error: null,
    })
    const res = await updateSession(withCookie('/dashboard', `nordklart-last-activity=${Date.now() - 13 * 3600 * 1000}`))
    expect(res.headers.get('location')).toContain('reason=session_expired')
  })

  it('keeps an active session and refreshes the activity cookie', async () => {
    getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal1', currentAuthenticationMethods: [{ method: 'password', timestamp: nowSeconds() - 3600 }] },
      error: null,
    })
    // /settings/account passes through without a company, so the response is
    // the session response that carries the refreshed cookie.
    const res = await updateSession(withCookie('/settings/account', `nordklart-last-activity=${Date.now() - 60_000}`))
    expect(res.headers.get('location')).toBeNull()
    expect(signOut).not.toHaveBeenCalled()
    expect(res.cookies.get('nordklart-last-activity')?.value).toMatch(/^\d+$/)
  })

  it('does not revoke sessions on a transient auth error', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: new Error('fetch failed') })
    await updateSession(req('/dashboard'))
    expect(signOut).not.toHaveBeenCalled()
  })
})

describe('middleware terms re-acceptance', () => {
  const nowSeconds = () => Math.floor(Date.now() / 1000)
  const pendingTerms = [{ legal_text_version_id: 'v-terms', document_type: 'terms', version: '2026-10-01' }]

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', '')
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-key')
    getUser.mockResolvedValue({ data: { user: passwordUser } })
    getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal1', currentAuthenticationMethods: [{ method: 'password', timestamp: nowSeconds() - 60 }] },
      error: null,
    })
  })

  it('sends a user with pending documents to the acceptance page and keeps the destination', async () => {
    rpc.mockResolvedValue({ data: pendingTerms, error: null })
    const res = await updateSession(req('/invoices?status=open'))
    const location = new URL(res.headers.get('location')!)
    expect(location.pathname).toBe('/villkor/godkann')
    expect(location.searchParams.get('next')).toBe('/invoices?status=open')
    expect(rpc).toHaveBeenCalledWith('pending_legal_documents')
  })

  it('lets the acceptance page and account settings through while documents are pending', async () => {
    rpc.mockResolvedValue({ data: pendingTerms, error: null })
    const gate = await updateSession(req('/villkor/godkann'))
    expect(gate.headers.get('location')).toBeNull()
    const account = await updateSession(req('/settings/account'))
    expect(account.headers.get('location') ?? '').not.toContain('/villkor/godkann')
  })

  it('caches a clean result in a signed cookie that skips the lookup next time', async () => {
    rpc.mockResolvedValue({ data: [], error: null })
    const first = await updateSession(req('/settings/account'))
    const ack = first.cookies.get('nordklart-legal-ack')?.value
    expect(ack).toMatch(/^2026-10-01\.[0-9a-f]{64}$/)

    rpc.mockClear()
    await updateSession(new NextRequest(new URL('https://app.nordklart.se/settings/account'), {
      headers: { cookie: `nordklart-legal-ack=${ack}` },
    }))
    expect(rpc).not.toHaveBeenCalledWith('pending_legal_documents')
  })

  it('ignores a cookie signed for another user', async () => {
    rpc.mockResolvedValue({ data: pendingTerms, error: null })
    getUser.mockResolvedValue({ data: { user: { ...passwordUser, id: 'user-2' } } })
    const { signLegalAck } = await import('@/lib/legal/acceptance-gate')
    const forged = await signLegalAck('user-1')
    const res = await updateSession(new NextRequest(new URL('https://app.nordklart.se/dashboard'), {
      headers: { cookie: `nordklart-legal-ack=${forged}` },
    }))
    expect(res.headers.get('location')).toContain('/villkor/godkann')
  })

  it('does not lock users out when the lookup fails', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '57014' } })
    const res = await updateSession(req('/settings/account'))
    expect(res.headers.get('location')).toBeNull()
    expect(res.cookies.get('nordklart-legal-ack')).toBeUndefined()
  })
})
