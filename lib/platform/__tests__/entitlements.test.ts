import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('server-only', () => ({}))
vi.unmock('@/lib/platform/entitlements')

import { checkFeatureAccess, featureAccessError } from '@/lib/platform/entitlements'

const rpc = vi.fn()
const db = { rpc } as unknown as SupabaseClient

describe('canonical feature access resolution', () => {
  beforeEach(() => {
    rpc.mockReset()
  })

  it('does not misclassify an RPC failure as a missing entitlement', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'schema cache unavailable' } })

    await expect(checkFeatureAccess(db, 'company-1', 'bookkeeping.core')).resolves.toEqual({
      allowed: false,
      reason: 'database_error',
    })
  })

  it('preserves a real missing-entitlement decision from PostgreSQL', async () => {
    rpc.mockResolvedValue({
      data: [{
        allowed: false,
        reason: 'missing_entitlement',
        source_type: null,
        source_id: null,
        expires_at: null,
        limit_value: null,
        limit_unit: null,
      }],
      error: null,
    })

    await expect(checkFeatureAccess(db, 'company-1', 'bookkeeping.core')).resolves.toMatchObject({
      allowed: false,
      reason: 'missing_entitlement',
    })
  })

  it('returns a retryable 503 without an upgrade URL for technical failures', async () => {
    const response = featureAccessError('bookkeeping.core', 'database_error')
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(response.headers.get('Retry-After')).toBe('5')
    expect(body).toMatchObject({
      error: 'FEATURE_ACCESS_UNAVAILABLE',
      feature: 'bookkeeping.core',
      reason: 'database_error',
      retryable: true,
    })
    expect(body).not.toHaveProperty('upgrade_url')
  })

  it('keeps a genuine product denial on the upgrade flow', async () => {
    const response = featureAccessError('bookkeeping.core', 'missing_entitlement')
    const body = await response.json()

    expect(response.status).toBe(403)
    expect(body).toMatchObject({
      error: 'FEATURE_NOT_ENABLED',
      reason: 'missing_entitlement',
      upgrade_url: expect.stringContaining('/settings/billing'),
    })
  })
})
