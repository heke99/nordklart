/**
 * Sysorg moms validate: feature-gated (skatteverket.submissions), write-only,
 * payload validation and missing-org-number handling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWritePermissionMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWritePermissionMock(...args),
}))

const checkFeatureAccessMock = vi.fn()
vi.mock('@/lib/platform/entitlements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/entitlements')>()
  return {
    ...actual,
    checkFeatureAccess: (...args: unknown[]) => checkFeatureAccessMock(...args),
  }
})

const kontrolleraMock = vi.fn()
vi.mock('@/lib/skatteverket/sysorg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/skatteverket/sysorg')>()
  return {
    ...actual,
    kontrolleraMomsdeklaration: (...args: unknown[]) => kontrolleraMock(...args),
  }
})

import { POST } from '../route'

const mockUser = { id: 'user-1', email: 'test@test.se' }
const validBody = {
  redovisningsperiod: '202605',
  momsuppgift: { summaMoms: 12500 },
}

describe('POST /api/skatteverket/sysorg/moms/validate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    requireWritePermissionMock.mockResolvedValue({ ok: true })
    checkFeatureAccessMock.mockResolvedValue({ allowed: true })
    kontrolleraMock.mockResolvedValue({ ok: true, status: 200, correlationId: 'corr-1', data: { status: 'OK' }, text: '', headers: {} })
  })

  it('returns 403 FEATURE_NOT_ENABLED without the skatteverket feature', async () => {
    checkFeatureAccessMock.mockResolvedValue({ allowed: false, reason: 'missing_entitlement' })

    const response = await POST(createMockRequest('/api/skatteverket/sysorg/moms/validate', { method: 'POST', body: validBody }), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(403)
    expect(body.error).toBe('FEATURE_NOT_ENABLED')
    expect(checkFeatureAccessMock).toHaveBeenCalledWith(expect.anything(), 'company-1', 'skatteverket.submissions')
    expect(kontrolleraMock).not.toHaveBeenCalled()
  })

  it('returns 403 for viewers (write required)', async () => {
    requireWritePermissionMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Du har endast läsbehörighet i detta företag.' }, { status: 403 }),
    })

    const response = await POST(createMockRequest('/api/skatteverket/sysorg/moms/validate', { method: 'POST', body: validBody }), { params: Promise.resolve({}) })
    expect(response.status).toBe(403)
    expect(kontrolleraMock).not.toHaveBeenCalled()
  })

  it('rejects an invalid payload with 400', async () => {
    const response = await POST(createMockRequest('/api/skatteverket/sysorg/moms/validate', { method: 'POST', body: { redovisningsperiod: '2026-05', momsuppgift: {} } }), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ error: string }>(response)
    expect(status).toBe(400)
    expect(body.error).toBe('Ogiltig payload')
  })

  it('returns 400 when the company has no org number', async () => {
    enqueue({ data: { org_number: null }, error: null }) // companies lookup

    const response = await POST(createMockRequest('/api/skatteverket/sysorg/moms/validate', { method: 'POST', body: validBody }), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ error: string }>(response)
    expect(status).toBe(400)
    expect(body.error).toContain('Organisationsnummer saknas')
  })

  it('validates against Skatteverket with the company org number as redovisare', async () => {
    enqueue({ data: { org_number: '556000-0167' }, error: null })

    const response = await POST(createMockRequest('/api/skatteverket/sysorg/moms/validate', { method: 'POST', body: validBody }), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ correlationId: string }>(response)

    expect(status).toBe(200)
    expect(body.correlationId).toBe('corr-1')
    expect(kontrolleraMock).toHaveBeenCalledWith(
      '165560000167',
      '202605',
      { summaMoms: 12500 },
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }),
    )
  })

  it('maps an upstream Skatteverket error to the upstream status without leaking internals', async () => {
    enqueue({ data: { org_number: '556000-0167' }, error: null })
    kontrolleraMock.mockResolvedValue({ ok: false, status: 422, correlationId: 'corr-2', data: { fel: [{ kod: 'X' }] }, text: '', headers: {} })

    const response = await POST(createMockRequest('/api/skatteverket/sysorg/moms/validate', { method: 'POST', body: validBody }), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ correlationId: string }>(response)
    expect(status).toBe(422)
    expect(body.correlationId).toBe('corr-2')
  })
})
