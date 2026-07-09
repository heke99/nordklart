/**
 * Commercial gate tests for recurring invoices.
 *
 * `recurring_invoice.*` maps to invoicing.core in featureForOperation, so
 * a company without the invoicing entitlement must get 403 FEATURE_NOT_ENABLED
 * from every recurring-invoice route, and a viewer must get 403 on mutations
 * even when the feature is enabled.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWritePermissionMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWritePermissionMock(...args),
}))

// Override the setup-level default-allow so we control the entitlement result.
const checkFeatureAccessMock = vi.fn()
vi.mock('@/lib/platform/entitlements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/entitlements')>()
  return {
    ...actual,
    checkFeatureAccess: (...args: unknown[]) => checkFeatureAccessMock(...args),
  }
})

import { GET, POST } from '../route'

const mockUser = { id: 'user-1', email: 'test@test.se' }

const validBody = {
  customer_id: '550e8400-e29b-41d4-a716-446655440000',
  name: 'Acme retainer',
  day_of_month: 15,
  payment_terms_days: 30,
  currency: 'SEK',
  auto_send: false,
  items: [{ description: 'Konsultarvode', quantity: 1, unit: 'st', unit_price: 1000 }],
}

describe('recurring invoices — entitlement gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    requireWritePermissionMock.mockResolvedValue({ ok: true })
  })

  it('POST returns 403 FEATURE_NOT_ENABLED without invoicing entitlement', async () => {
    checkFeatureAccessMock.mockResolvedValue({ allowed: false, reason: 'missing_entitlement' })

    const response = await POST(
      createMockRequest('/api/invoices/recurring', { method: 'POST', body: validBody }),
      { params: Promise.resolve({}) },
    )
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(403)
    expect(body.error).toBe('FEATURE_NOT_ENABLED')
    expect(checkFeatureAccessMock).toHaveBeenCalledWith(expect.anything(), 'company-1', 'invoicing.core')
  })

  it('GET returns 403 FEATURE_NOT_ENABLED without invoicing entitlement', async () => {
    checkFeatureAccessMock.mockResolvedValue({ allowed: false, reason: 'missing_entitlement' })

    const response = await GET(createMockRequest('/api/invoices/recurring'), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(403)
    expect(body.error).toBe('FEATURE_NOT_ENABLED')
  })

  it('POST returns 403 for viewer even with the feature enabled', async () => {
    checkFeatureAccessMock.mockResolvedValue({ allowed: true })
    requireWritePermissionMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Du har endast läsbehörighet i detta företag.' }, { status: 403 }),
    })

    const response = await POST(
      createMockRequest('/api/invoices/recurring', { method: 'POST', body: validBody }),
      { params: Promise.resolve({}) },
    )
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(403)
    expect(body.error).toContain('läsbehörighet')
  })
})
