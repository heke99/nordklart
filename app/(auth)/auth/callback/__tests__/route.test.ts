import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  verifyOtp: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  markSignupDraftEmailVerified: vi.fn(),
}))

const { verifyOtp, exchangeCodeForSession, markSignupDraftEmailVerified } = mocks
let authUser: { id: string; email?: string; user_metadata?: Record<string, unknown> } | null = { id: 'user-1' }

vi.mock('server-only', () => ({}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(() => ({
    from: vi.fn(() => ({
      insert: vi.fn().mockResolvedValue({ error: null }),
    })),
    auth: {
      admin: {
        updateUserById: vi.fn().mockResolvedValue({ error: null }),
      },
    },
  })),
}))

vi.mock('@/lib/signup/provision', () => ({
  markSignupDraftEmailVerified: mocks.markSignupDraftEmailVerified,
}))

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    auth: {
      verifyOtp: mocks.verifyOtp,
      exchangeCodeForSession: mocks.exchangeCodeForSession,
      getUser: vi.fn().mockImplementation(() => Promise.resolve({ data: { user: authUser } })),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({ data: null }),
        listFactors: vi.fn().mockResolvedValue({ data: null }),
      },
    },
    from: vi.fn(),
    rpc: vi.fn(),
  })),
}))

vi.mock('@/lib/auth/invite-tokens', () => ({
  hashInviteToken: vi.fn(),
}))

import { GET } from '../route'

describe('GET /auth/callback — recovery flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authUser = { id: 'user-1' }
  })

  it('redirects to /reset-password after a successful recovery OTP (token-hash flow)', async () => {
    verifyOtp.mockResolvedValue({ error: null })

    const request = new NextRequest(
      'http://localhost:3000/auth/callback?token_hash=abc&type=recovery&next=/reset-password'
    )
    const response = await GET(request)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('http://localhost:3000/reset-password')
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'abc', type: 'recovery' })
  })

  it('redirects to /reset-password after a successful PKCE exchange when next=/reset-password (no type param)', async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null })

    const request = new NextRequest(
      'http://localhost:3000/auth/callback?code=xyz&next=/reset-password'
    )
    const response = await GET(request)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('http://localhost:3000/reset-password')
    expect(exchangeCodeForSession).toHaveBeenCalledWith('xyz')
  })

  it('redirects to the recovery-specific login error when the recovery OTP is expired or already consumed', async () => {
    verifyOtp.mockResolvedValue({ error: { message: 'Token has expired or is invalid' } })

    const request = new NextRequest(
      'http://localhost:3000/auth/callback?token_hash=expired&type=recovery&next=/reset-password'
    )
    const response = await GET(request)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('http://localhost:3000/login?auth_error=password_reset_failed')
  })


  it('redirects to the signup-specific error when an email confirmation token is invalid', async () => {
    verifyOtp.mockResolvedValue({ error: { message: 'Token has expired or is invalid' } })

    const request = new NextRequest(
      'http://localhost:3000/auth/callback?token_hash=expired&type=email&flow=signup&next=/onboarding'
    )
    const response = await GET(request)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/login?auth_error=signup_confirmation_failed'
    )
  })

  it('verifies a signup draft but redirects only to password creation', async () => {
    verifyOtp.mockResolvedValue({ error: null })
    markSignupDraftEmailVerified.mockResolvedValue(true)
    authUser = {
      id: 'user-1',
      email: 'owner@example.se',
      user_metadata: { signup_draft_id: 'draft-1', signup_draft_token: 'secret' },
    }

    const request = new NextRequest(
      'http://localhost:3000/auth/callback?token_hash=abc&type=email&flow=signup&next=/onboarding'
    )
    const response = await GET(request)

    expect(markSignupDraftEmailVerified).toHaveBeenCalledWith({
      draftId: 'draft-1', userId: 'user-1', token: 'secret',
    })
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/account/set-password?mode=signup'
    )
  })

})
