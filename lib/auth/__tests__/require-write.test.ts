import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createMockSupabase } from '@/tests/helpers'

// The chainable mock only implements the query surface the helpers touch.
const asClient = (mock: unknown) => mock as SupabaseClient

/**
 * Row shape returned by the `resolve_company_access` RPC, which
 * requireWritePermission/getCompanyRole resolve access through.
 */
function accessRow(effectiveRole: string, canWrite: boolean) {
  return {
    company_id: 'company-1',
    access_source: 'direct',
    agency_id: null,
    effective_role: effectiveRole,
    can_read: true,
    can_write: canWrite,
    can_review: canWrite,
    can_manage_company: effectiveRole === 'company_owner' || effectiveRole === 'company_admin',
    can_manage_agency: false,
    can_manage_platform: false,
  }
}

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn(),
}))

import { requireWritePermission, getCompanyRole } from '../require-write'
import { getActiveCompanyId } from '@/lib/company/context'

describe('requireWritePermission', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns ok for owner', async () => {
    const { supabase, mockResult } = createMockSupabase()
    vi.mocked(getActiveCompanyId).mockResolvedValue('company-1')
    mockResult({ data: [accessRow('company_owner', true)] })

    const result = await requireWritePermission(asClient(supabase), 'user-1')
    expect(result.ok).toBe(true)
  })

  it('returns ok for admin', async () => {
    const { supabase, mockResult } = createMockSupabase()
    vi.mocked(getActiveCompanyId).mockResolvedValue('company-1')
    mockResult({ data: [accessRow('company_admin', true)] })

    const result = await requireWritePermission(asClient(supabase), 'user-1')
    expect(result.ok).toBe(true)
  })

  it('returns ok for member', async () => {
    const { supabase, mockResult } = createMockSupabase()
    vi.mocked(getActiveCompanyId).mockResolvedValue('company-1')
    mockResult({ data: [accessRow('client_user', true)] })

    const result = await requireWritePermission(asClient(supabase), 'user-1')
    expect(result.ok).toBe(true)
  })

  it('returns 403 for viewer', async () => {
    const { supabase, mockResult } = createMockSupabase()
    vi.mocked(getActiveCompanyId).mockResolvedValue('company-1')
    mockResult({ data: [accessRow('read_only', false)] })

    const result = await requireWritePermission(asClient(supabase), 'user-1')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(403)
      const body = await result.response.json()
      expect(body.error).toContain('inte behörighet att ändra')
    }
  })

  it('returns 403 when user has no membership', async () => {
    const { supabase, mockResult } = createMockSupabase()
    vi.mocked(getActiveCompanyId).mockResolvedValue('company-1')
    mockResult({ data: [] })

    const result = await requireWritePermission(asClient(supabase), 'user-1')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(403)
    }
  })

  it('returns 403 when there is no active company', async () => {
    const { supabase } = createMockSupabase()
    vi.mocked(getActiveCompanyId).mockResolvedValue(null)

    const result = await requireWritePermission(asClient(supabase), 'user-1')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(403)
      const body = await result.response.json()
      expect(body.error).toContain('aktivt företag')
    }
  })
})

describe('getCompanyRole', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns role and companyId for owner', async () => {
    const { supabase, mockResult } = createMockSupabase()
    vi.mocked(getActiveCompanyId).mockResolvedValue('company-1')
    mockResult({ data: [accessRow('company_owner', true)] })

    const result = await getCompanyRole(asClient(supabase), 'user-1')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.role).toBe('owner')
      expect(result.companyId).toBe('company-1')
    }
  })

  it('returns role for viewer (does not block)', async () => {
    const { supabase, mockResult } = createMockSupabase()
    vi.mocked(getActiveCompanyId).mockResolvedValue('company-1')
    mockResult({ data: [accessRow('read_only', false)] })

    const result = await getCompanyRole(asClient(supabase), 'user-1')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.role).toBe('viewer')
      expect(result.companyId).toBe('company-1')
    }
  })

  it('returns 403 when user has no membership', async () => {
    const { supabase, mockResult } = createMockSupabase()
    vi.mocked(getActiveCompanyId).mockResolvedValue('company-1')
    mockResult({ data: [] })

    const result = await getCompanyRole(asClient(supabase), 'user-1')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(403)
    }
  })

  it('returns 403 when there is no active company', async () => {
    const { supabase } = createMockSupabase()
    vi.mocked(getActiveCompanyId).mockResolvedValue(null)

    const result = await getCompanyRole(asClient(supabase), 'user-1')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(403)
      const body = await result.response.json()
      expect(body.error).toContain('aktivt företag')
    }
  })
})
