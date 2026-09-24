import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

import { createClient } from '@/lib/supabase/server'
import { requireAuth } from '../require-auth'

function mockClient(opts: {
  user?: { id: string; app_metadata?: Record<string, unknown> } | null
  aal?: { currentLevel: string; nextLevel: string }
  aalError?: unknown
  company?: { id: string } | null
}) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: opts.company ?? null, error: null })
  const query = { select: vi.fn(), is: vi.fn(), limit: vi.fn(), maybeSingle }
  query.select.mockReturnValue(query)
  query.is.mockReturnValue(query)
  query.limit.mockReturnValue(query)

  const client = {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: opts.user ?? null } }),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({
          data: opts.aal ?? null,
          error: opts.aalError ?? null,
        }),
      },
    },
    from: vi.fn().mockReturnValue(query),
  }
  vi.mocked(createClient).mockResolvedValue(client as never)
  return client
}

const USER = { id: 'user-1', app_metadata: {} }

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
  vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('requireAuth', () => {
  it('returns 401 without a user', async () => {
    mockClient({ user: null })
    const result = await requireAuth()
    expect(result.error?.status).toBe(401)
  })

  it('returns 403 when a factor is enrolled but this session is aal1', async () => {
    mockClient({ user: USER, aal: { currentLevel: 'aal1', nextLevel: 'aal2' } })
    const result = await requireAuth()
    expect(result.error?.status).toBe(403)
  })

  it('returns 403 mfa_enrollment_required when no factor is enrolled and the user has a company', async () => {
    mockClient({ user: USER, aal: { currentLevel: 'aal1', nextLevel: 'aal1' }, company: { id: 'c1' } })
    const result = await requireAuth()
    expect(result.error?.status).toBe(403)
    const body = await result.error!.json()
    expect(body.code).toBe('mfa_enrollment_required')
  })

  it('lets an onboarding user with no company through at aal1', async () => {
    mockClient({ user: USER, aal: { currentLevel: 'aal1', nextLevel: 'aal1' }, company: null })
    const result = await requireAuth()
    expect(result.error).toBeNull()
  })

  it('passes a verified aal2 session', async () => {
    const client = mockClient({ user: USER, aal: { currentLevel: 'aal2', nextLevel: 'aal2' } })
    const result = await requireAuth()
    expect(result.error).toBeNull()
    expect(client.from).not.toHaveBeenCalled()
  })

  it('does not enforce MFA on self-hosted', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    const client = mockClient({ user: USER, aal: { currentLevel: 'aal1', nextLevel: 'aal1' }, company: { id: 'c1' } })
    const result = await requireAuth()
    expect(result.error).toBeNull()
    expect(client.auth.mfa.getAuthenticatorAssuranceLevel).not.toHaveBeenCalled()
  })
})
