import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

const verifierSignIn = vi.fn()
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { signInWithPassword: verifierSignIn, signOut: vi.fn().mockResolvedValue({ error: null }) },
  }),
}))
vi.mock('@/lib/auth/rate-limit-durable', () => ({
  checkDurableRateLimit: vi.fn().mockResolvedValue({ ok: true }),
}))

import { createClient, createServiceClient } from '@/lib/supabase/server'
import { POST } from '../route'

const mockCreateClient = vi.mocked(createClient)
const mockCreateServiceClient = vi.mocked(createServiceClient)

type AuthMetadata = Record<string, unknown>

function mockUserClient(opts: {
  user: { id: string; app_metadata?: AuthMetadata } | null
  updateUserError?: { message: string; status?: number; code?: string } | null
  aal?: { currentLevel: string; nextLevel: string; currentAuthenticationMethods?: Array<{ method: string; timestamp: number }> }
  aalError?: { message: string } | null
}) {
  const updateUser = vi.fn().mockResolvedValue({
    data: {},
    error: opts.updateUserError ?? null,
  })

  mockCreateClient.mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: opts.user } }),
      getClaims: vi.fn().mockResolvedValue({ data: { claims: { session_id: 'sess-current' } } }),
      updateUser,
      // requireAuth() probes the assurance level whenever MFA is enforced.
      // Default to a session that needs no step-up so the existing cases are
      // unaffected; the MFA tests below override it.
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({
          data: opts.aal ?? { currentLevel: 'aal1', nextLevel: 'aal1' },
          error: opts.aalError ?? null,
        }),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)

  return { updateUser }
}

function mockService(opts: {
  priorAppMetadata?: AuthMetadata
  // Returned-error from admin.updateUserById when called with { password }
  passwordSetError?: { message: string; status?: number; code?: string } | null
  // Thrown error from admin.updateUserById when called with { app_metadata }
  flagFlipError?: Error | null
  signupActivationError?: { message: string } | null
}) {
  const updateUserById = vi
    .fn()
    .mockImplementation((_id: string, args: Record<string, unknown>) => {
      if ('password' in args) {
        return Promise.resolve({
          data: {},
          error: opts.passwordSetError ?? null,
        })
      }
      if (opts.flagFlipError) return Promise.reject(opts.flagFlipError)
      return Promise.resolve({ data: {}, error: null })
    })

  const getUserById = vi.fn().mockResolvedValue({
    data: { user: { app_metadata: opts.priorAppMetadata ?? {} } },
  })

  const rpc = vi.fn().mockResolvedValue({
    data: false,
    error: opts.signupActivationError ?? null,
  })

  mockCreateServiceClient.mockReturnValue({
    auth: { admin: { getUserById, updateUserById } },
    rpc,
    from: vi.fn(() => ({ insert: vi.fn().mockResolvedValue({ error: null }) })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)

  return { getUserById, updateUserById, rpc }
}

const STRONG_PASSWORD = 'StrongP@ssword1'

function flagFlipCall(updateUserById: ReturnType<typeof vi.fn>) {
  return updateUserById.mock.calls.find(
    ([, args]) => args && typeof args === 'object' && 'app_metadata' in args,
  )
}

function passwordSetCall(updateUserById: ReturnType<typeof vi.fn>) {
  return updateUserById.mock.calls.find(
    ([, args]) => args && typeof args === 'object' && 'password' in args,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  verifierSignIn.mockResolvedValue({ data: { session: {} }, error: null })
})

describe('POST /api/account/password', () => {
  it('returns 401 when unauthenticated', async () => {
    mockUserClient({ user: null })
    mockService({})

    const req = createMockRequest('/api/account/password', {
      method: 'POST',
      body: { password: STRONG_PASSWORD },
    })
    const { status } = await parseJsonResponse(await POST(req))
    expect(status).toBe(401)
  })

  it('returns 400 when password is too weak', async () => {
    mockUserClient({ user: { id: 'user-1', app_metadata: { has_password: true } } })
    mockService({ priorAppMetadata: { has_password: true } })

    const req = createMockRequest('/api/account/password', {
      method: 'POST',
      body: { password: 'weak' },
    })
    const { status } = await parseJsonResponse(await POST(req))
    expect(status).toBe(400)
  })

  describe('first-time set (has_password !== true)', () => {
    it('writes the password via admin API and flips the flag', async () => {
      const { updateUser } = mockUserClient({
        user: {
          id: 'user-1',
          app_metadata: { has_password: false, bankid_linked: true },
        },
      })
      const { updateUserById } = mockService({
        priorAppMetadata: { has_password: false, bankid_linked: true },
      })

      const req = createMockRequest('/api/account/password', {
        method: 'POST',
        body: { password: STRONG_PASSWORD },
      })
      const { status, body } = await parseJsonResponse<{
        data?: { ok: boolean }
      }>(await POST(req))

      expect(status).toBe(200)
      expect(body.data?.ok).toBe(true)
      // Did NOT go through the user session — that path would fail with AAL2.
      expect(updateUser).not.toHaveBeenCalled()
      // Password set via admin
      expect(passwordSetCall(updateUserById)).toEqual([
        'user-1',
        { password: STRONG_PASSWORD },
      ])
      // Flag flipped, siblings preserved
      expect(flagFlipCall(updateUserById)).toEqual([
        'user-1',
        {
          app_metadata: {
            has_password: true,
            bankid_linked: true,
          },
        },
      ])
    })

    it('treats unset has_password on a BankID-created account as first-time set', async () => {
      const { updateUser } = mockUserClient({
        user: { id: 'user-1', app_metadata: { bankid_linked: true } },
      })
      const { updateUserById } = mockService({ priorAppMetadata: { bankid_linked: true } })

      const req = createMockRequest('/api/account/password', {
        method: 'POST',
        body: { password: STRONG_PASSWORD },
      })
      const { status } = await parseJsonResponse(await POST(req))

      expect(status).toBe(200)
      expect(updateUser).not.toHaveBeenCalled()
      expect(passwordSetCall(updateUserById)).toBeDefined()
    })

    it('returns 400 and skips flag flip when the admin password set fails', async () => {
      const { updateUser } = mockUserClient({
        user: { id: 'user-1', app_metadata: { has_password: false } },
      })
      const { updateUserById } = mockService({
        priorAppMetadata: { has_password: false },
        passwordSetError: { message: 'Password too weak', status: 400 },
      })

      const req = createMockRequest('/api/account/password', {
        method: 'POST',
        body: { password: STRONG_PASSWORD },
      })
      const { status, body } = await parseJsonResponse<{ error?: string }>(
        await POST(req),
      )

      expect(status).toBe(400)
      expect(body.error).toContain('Password too weak')
      expect(updateUser).not.toHaveBeenCalled()
      expect(flagFlipCall(updateUserById)).toBeUndefined()
    })

    it('still returns success when the flag flip fails after admin password set', async () => {
      mockUserClient({
        user: { id: 'user-1', app_metadata: { has_password: false } },
      })
      mockService({
        priorAppMetadata: { has_password: false },
        flagFlipError: new Error('admin down'),
      })

      const req = createMockRequest('/api/account/password', {
        method: 'POST',
        body: { password: STRONG_PASSWORD },
      })
      const { status, body } = await parseJsonResponse<{
        data?: { ok: boolean }
      }>(await POST(req))

      expect(status).toBe(200)
      expect(body.data?.ok).toBe(true)
    })
  })

  describe('change-password (has_password === true)', () => {
    it('requires the current password', async () => {
      const { updateUser } = mockUserClient({ user: { id: 'user-1', email: 'u@example.se', app_metadata: { has_password: true } } as never })
      mockService({ priorAppMetadata: { has_password: true } })
      const req = createMockRequest('/api/account/password', { method: 'POST', body: { password: STRONG_PASSWORD } })
      const { status, body } = await parseJsonResponse<{ code?: string }>(await POST(req))
      expect(status).toBe(400)
      expect(body.code).toBe('current_password_required')
      expect(updateUser).not.toHaveBeenCalled()
    })

    it('treats an account without the flag (not BankID) as having a password', async () => {
      const { updateUser } = mockUserClient({ user: { id: 'user-1', app_metadata: {} } })
      mockService({})
      const req = createMockRequest('/api/account/password', { method: 'POST', body: { password: STRONG_PASSWORD } })
      const { status } = await parseJsonResponse(await POST(req))
      expect(status).toBe(400)
      expect(updateUser).not.toHaveBeenCalled()
    })

    it('refuses a wrong current password', async () => {
      verifierSignIn.mockResolvedValue({ data: null, error: { message: 'Invalid login credentials' } })
      const { updateUser } = mockUserClient({ user: { id: 'user-1', email: 'u@example.se', app_metadata: { has_password: true } } as never })
      mockService({ priorAppMetadata: { has_password: true } })
      const req = createMockRequest('/api/account/password', { method: 'POST', body: { password: STRONG_PASSWORD, currentPassword: 'wrong' } })
      const { status } = await parseJsonResponse(await POST(req))
      expect(status).toBe(403)
      expect(updateUser).not.toHaveBeenCalled()
    })

    it('lets a fresh reset-link session set a password without the old one', async () => {
      const { updateUser } = mockUserClient({
        user: { id: 'user-1', app_metadata: { has_password: true } },
        aal: { currentLevel: 'aal1', nextLevel: 'aal1', currentAuthenticationMethods: [{ method: 'recovery', timestamp: Math.floor(Date.now() / 1000) - 60 }] },
      })
      mockService({ priorAppMetadata: { has_password: true } })
      const req = createMockRequest('/api/account/password', { method: 'POST', body: { password: STRONG_PASSWORD } })
      const { status } = await parseJsonResponse(await POST(req))
      expect(status).toBe(200)
      expect(updateUser).toHaveBeenCalledWith({ password: STRONG_PASSWORD })
    })

    it('ends every other session after a change', async () => {
      mockUserClient({ user: { id: 'user-1', email: 'u@example.se', app_metadata: { has_password: true } } as never })
      const { rpc } = mockService({ priorAppMetadata: { has_password: true } })
      const req = createMockRequest('/api/account/password', { method: 'POST', body: { password: STRONG_PASSWORD, currentPassword: 'OldP@ssword1' } })
      const { status } = await parseJsonResponse(await POST(req))
      expect(status).toBe(200)
      expect(rpc).toHaveBeenCalledWith('revoke_user_sessions', { p_user_id: 'user-1', p_keep_session_id: 'sess-current' })
    })

    it('writes via the user session so Supabase enforces AAL2', async () => {
      const { updateUser } = mockUserClient({
        user: { id: 'user-1', app_metadata: { has_password: true } },
      })
      const { updateUserById } = mockService({
        priorAppMetadata: { has_password: true, provider: 'email' },
      })

      const req = createMockRequest('/api/account/password', {
        method: 'POST',
        body: { password: STRONG_PASSWORD, currentPassword: 'OldP@ssword1' },
      })
      const { status, body } = await parseJsonResponse<{
        data?: { ok: boolean }
      }>(await POST(req))

      expect(status).toBe(200)
      expect(body.data?.ok).toBe(true)
      // Used user session, NOT admin API for the password itself
      expect(updateUser).toHaveBeenCalledWith({ password: STRONG_PASSWORD })
      expect(passwordSetCall(updateUserById)).toBeUndefined()
      // Flag is still flipped (idempotent) with siblings preserved
      expect(flagFlipCall(updateUserById)).toEqual([
        'user-1',
        {
          app_metadata: {
            has_password: true,
            provider: 'email',
          },
        },
      ])
    })

    it('returns 400 and skips flag flip when Supabase rejects the password update', async () => {
      const { updateUser } = mockUserClient({
        user: { id: 'user-1', app_metadata: { has_password: true } },
        updateUserError: { message: 'Password too similar to old', status: 400 },
      })
      const { updateUserById } = mockService({
        priorAppMetadata: { has_password: true },
      })

      const req = createMockRequest('/api/account/password', {
        method: 'POST',
        body: { password: STRONG_PASSWORD, currentPassword: 'OldP@ssword1' },
      })
      const { status, body } = await parseJsonResponse<{ error?: string }>(
        await POST(req),
      )

      expect(status).toBe(400)
      expect(body.error).toContain('Password too similar')
      expect(updateUser).toHaveBeenCalledWith({ password: STRONG_PASSWORD })
      expect(flagFlipCall(updateUserById)).toBeUndefined()
    })

    it('surfaces the AAL2 error verbatim so the client can step up via /mfa/verify', async () => {
      mockUserClient({
        user: { id: 'user-1', app_metadata: { has_password: true } },
        updateUserError: {
          message:
            'AAL2 session is required to update email or password when MFA is enabled',
          status: 422,
        },
      })
      mockService({ priorAppMetadata: { has_password: true } })

      const req = createMockRequest('/api/account/password', {
        method: 'POST',
        body: { password: STRONG_PASSWORD, currentPassword: 'OldP@ssword1' },
      })
      const { status, body } = await parseJsonResponse<{ error?: string }>(
        await POST(req),
      )

      expect(status).toBe(400)
      expect(body.error).toContain('AAL2')
    })
  })

  describe('MFA enforcement (hosted)', () => {
    // The route sets a password without asking for the current one. For an
    // account that already has one, Supabase's own updateUser() refuses at
    // AAL1 — the test above pins that. The gap was the FIRST-TIME path: it
    // goes through the service-role admin API, which has no AAL check at all.
    //
    // A magic-link account (no password) that has enrolled TOTP is exactly
    // that case: shouldEnforceMfa() returns true because it is not
    // BankID-only, yet nothing in the route or in the admin API stopped an
    // AAL1 session from setting a password.
    it('refuses the first-time-set path from an AAL1 session', async () => {
      vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', '')
      const { updateUserById } = mockService({ priorAppMetadata: {} })
      mockUserClient({
        // has_password absent => isFirstTimeSet => service-role admin path
        user: { id: 'user-1', app_metadata: {} },
        aal: { currentLevel: 'aal1', nextLevel: 'aal2' },
      })

      const req = createMockRequest('/api/account/password', {
        method: 'POST',
        body: { password: STRONG_PASSWORD },
      })
      const { status } = await parseJsonResponse(await POST(req))

      expect(status).toBe(403)
      // The point of the fix: the admin API is never reached.
      expect(updateUserById).not.toHaveBeenCalled()
    })

    it('still lets a BankID-only account set its first password', async () => {
      // shouldEnforceMfa() exempts bankid_linked accounts with no password of
      // their own, so onboarding is not broken by the guard above.
      vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', '')
      const { updateUserById } = mockService({ priorAppMetadata: { bankid_linked: true } })
      mockUserClient({
        user: { id: 'user-1', app_metadata: { bankid_linked: true } },
        aal: { currentLevel: 'aal1', nextLevel: 'aal2' },
      })

      const req = createMockRequest('/api/account/password', {
        method: 'POST',
        body: { password: STRONG_PASSWORD },
      })
      const { status } = await parseJsonResponse(await POST(req))

      expect(status).not.toBe(403)
      expect(updateUserById).toHaveBeenCalled()
    })
  })
})
