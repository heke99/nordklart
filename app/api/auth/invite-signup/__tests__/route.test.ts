import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest } from '@/tests/helpers'

const rpc = vi.fn()
const createUser = vi.fn()
const deleteUser = vi.fn()
const inviteRows: Record<string, unknown> = {}
const insert = vi.fn().mockResolvedValue({ error: null })

function tableQuery(table: string) {
  const q = {
    select: vi.fn(() => q),
    eq: vi.fn(() => q),
    maybeSingle: vi.fn(async () => ({ data: inviteRows[table] ?? null, error: null })),
    insert,
  }
  return q
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(() => ({
    rpc,
    from: vi.fn((table: string) => tableQuery(table)),
    auth: { admin: { createUser, deleteUser } },
  })),
}))
vi.mock('@/lib/auth/rate-limit-durable', () => ({
  checkDurableRateLimit: vi.fn().mockResolvedValue({ ok: true }),
}))

import { POST } from '../route'

const valid = {
  token: 'nordklart_inv_abcdefghijklmnop',
  firstName: 'Anna',
  lastName: 'Svensson',
  password: 'Str0ng!Passw0rd',
  acceptedTerms: true,
  acceptedPrivacy: true,
}

function post(body: unknown) {
  return POST(createMockRequest('/api/auth/invite-signup', { method: 'POST', body }) as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const key of Object.keys(inviteRows)) delete inviteRows[key]
  deleteUser.mockResolvedValue({ error: null })
})

describe('POST /api/auth/invite-signup', () => {
  it('rejects a weak password and missing terms', async () => {
    expect((await post({ ...valid, password: 'short' })).status).toBe(400)
    expect((await post({ ...valid, acceptedTerms: false })).status).toBe(400)
    expect(createUser).not.toHaveBeenCalled()
  })

  it('404s an unknown invitation', async () => {
    const res = await post(valid)
    expect(res.status).toBe(404)
    expect(createUser).not.toHaveBeenCalled()
  })

  it('410s an expired invitation', async () => {
    inviteRows.company_invitations = { email: 'anna@example.se', status: 'pending', expires_at: '2000-01-01T00:00:00Z' }
    expect((await post(valid)).status).toBe(410)
  })

  it('creates a confirmed account for the invited e-mail and accepts the invite', async () => {
    inviteRows.company_invitations = { email: 'Anna@Example.se', status: 'pending', expires_at: '2999-01-01T00:00:00Z' }
    createUser.mockResolvedValue({ data: { user: { id: 'new-user' } }, error: null })
    rpc.mockResolvedValue({ data: { ok: true, type: 'company', company_id: 'c1', role: 'member' }, error: null })

    const res = await post({ ...valid, email: 'attacker@example.se' })
    expect(res.status).toBe(201)
    expect(createUser).toHaveBeenCalledWith(expect.objectContaining({
      email: 'anna@example.se',
      email_confirm: true,
      app_metadata: { has_password: true },
    }))
    expect(rpc).toHaveBeenCalledWith('accept_invitation', expect.objectContaining({ p_user_id: 'new-user' }))
  })

  it('tells an existing account to log in instead', async () => {
    inviteRows.agency_invitations = { email: 'anna@example.se', status: 'pending', expires_at: '2999-01-01T00:00:00Z' }
    createUser.mockResolvedValue({ data: { user: null }, error: { code: 'email_exists' } })
    expect((await post(valid)).status).toBe(409)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('deletes the new account again when the accept fails', async () => {
    inviteRows.company_invitations = { email: 'anna@example.se', status: 'pending', expires_at: '2999-01-01T00:00:00Z' }
    createUser.mockResolvedValue({ data: { user: { id: 'new-user' } }, error: null })
    rpc.mockResolvedValue({ data: { ok: false, error: 'not_pending' }, error: null })
    expect((await post(valid)).status).toBe(409)
    expect(deleteUser).toHaveBeenCalledWith('new-user')
  })
})
