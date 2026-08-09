import { beforeEach, describe, expect, it, vi } from 'vitest'

const checkFeatureAccessMock = vi.fn()
vi.mock('@/lib/platform/entitlements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/entitlements')>()
  return { ...actual, checkFeatureAccess: (...args: unknown[]) => checkFeatureAccessMock(...args) }
})

let canonicalRow: Record<string, unknown> | null
let canonicalError: { message: string } | null
let platformRoleRow: Record<string, unknown> | null
let auditError: { message: string } | null
const auditRows: Array<Record<string, unknown>> = []

function chainFor(table: string) {
  const chain: Record<string, unknown> = {}
  chain.select = () => chain
  chain.eq = () => chain
  chain.is = () => chain
  chain.maybeSingle = async () => ({
    data: table === 'platform_roles' ? platformRoleRow : null,
    error: null,
  })
  chain.insert = async (row: Record<string, unknown>) => {
    if (table === 'audit_log') auditRows.push(row)
    return { data: null, error: auditError }
  }
  return chain
}

const db = {
  rpc: vi.fn(async (name: string) => {
    if (name !== 'resolve_year_end_period_capability_for_user') {
      throw new Error(`unexpected rpc ${name}`)
    }
    return { data: canonicalRow ? [canonicalRow] : [], error: canonicalError }
  }),
  from: (table: string) => chainFor(table),
}

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => db }))

import {
  requireYearEndAccess,
  requireYearEndReportAccess,
  resolveYearEndAccess,
} from '../access'

function allowed(source: 'feature_entitlement' | 'one_time_purchase' | 'platform_admin_bypass', sourceId: string | null = null) {
  return {
    allowed: true,
    code: 'YEAR_END_PERIOD_OPERATE_ALLOWED',
    access_source: source,
    access_source_id: sourceId,
    effective_role: source === 'platform_admin_bypass' ? 'platform_admin' : 'company_admin',
    purchase_id: source === 'one_time_purchase' ? sourceId : null,
    feature_access: source === 'feature_entitlement',
    one_time_access: source === 'one_time_purchase',
  }
}

function denied(code: string) {
  return {
    allowed: false,
    code,
    access_source: null,
    access_source_id: null,
    effective_role: 'company_admin',
    purchase_id: null,
    feature_access: false,
    one_time_access: false,
  }
}

describe('year-end period-scoped access', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    canonicalRow = denied('YEAR_END_PERIOD_PURCHASE_REQUIRED')
    canonicalError = null
    platformRoleRow = null
    auditError = null
    auditRows.length = 0
    checkFeatureAccessMock.mockResolvedValue({ allowed: false, reason: 'missing_entitlement' })
  })

  it('uses the canonical database capability for feature access', async () => {
    canonicalRow = allowed('feature_entitlement', 'feature-source-1')
    await expect(resolveYearEndAccess(db as never, 'company-1', 'period-1', 'user-1')).resolves.toMatchObject({
      allowed: true,
      source: 'feature_entitlement',
      sourceId: 'feature-source-1',
    })
    expect(db.rpc).toHaveBeenCalledWith('resolve_year_end_period_capability_for_user', {
      p_user_id: 'user-1',
      p_company_id: 'company-1',
      p_fiscal_period_id: 'period-1',
      p_require_write: false,
    })
  })

  it('uses a trusted service client instead of the authenticated caller client', async () => {
    canonicalRow = allowed('feature_entitlement', 'feature-source-1')
    const authenticatedDb = {
      ...db,
      rpc: vi.fn(async () => ({ data: null, error: { code: '42501', message: 'permission denied' } })),
    }

    await expect(resolveYearEndAccess(
      authenticatedDb as never,
      'company-1',
      'period-1',
      'user-1',
    )).resolves.toMatchObject({ allowed: true, source: 'feature_entitlement' })

    expect(authenticatedDb.rpc).not.toHaveBeenCalled()
    expect(db.rpc).toHaveBeenCalledOnce()
  })

  it('allows a one-time purchase only through the exact company and period RPC arguments', async () => {
    canonicalRow = allowed('one_time_purchase', 'purchase-1')
    await expect(resolveYearEndAccess(db as never, 'company-1', 'period-1', 'user-1')).resolves.toMatchObject({
      allowed: true,
      source: 'one_time_purchase',
      sourceId: 'purchase-1',
    })
    expect(db.rpc).toHaveBeenCalledWith('resolve_year_end_period_capability_for_user', expect.objectContaining({
      p_company_id: 'company-1',
      p_fiscal_period_id: 'period-1',
    }))
  })

  it('allows purchased-period reports without unlocking unrelated periods', async () => {
    canonicalRow = allowed('one_time_purchase', 'purchase-1')
    const decision = await requireYearEndReportAccess(db as never, 'company-1', 'user-1', 'period-1')
    expect(decision).toMatchObject({ allowed: true, source: 'one_time_purchase', sourceId: 'purchase-1' })
    expect(db.rpc).toHaveBeenCalledWith('resolve_year_end_period_capability_for_user', expect.objectContaining({
      p_fiscal_period_id: 'period-1',
    }))
  })

  it('reports a technical resolver failure instead of redirecting to purchase', async () => {
    canonicalError = { message: 'database unavailable' }
    await expect(resolveYearEndAccess(db as never, 'company-1', 'period-1', 'user-1')).resolves.toMatchObject({
      allowed: false,
      reason: 'database_error',
    })
  })

  it('denies another tenant before any application-side entitlement read', async () => {
    canonicalRow = denied('YEAR_END_COMPANY_ACCESS_FORBIDDEN')
    await expect(resolveYearEndAccess(db as never, 'company-1', 'period-1', 'outsider')).resolves.toMatchObject({
      allowed: false,
      reason: 'unauthorized',
    })
    expect(checkFeatureAccessMock).not.toHaveBeenCalled()
  })

  it('does not let iXBRL-only access authorize an operation unless explicitly requested', async () => {
    checkFeatureAccessMock.mockResolvedValue({ allowed: true, sourceId: 'ix-1' })
    canonicalRow = denied('YEAR_END_PERIOD_PURCHASE_REQUIRED')
    await expect(resolveYearEndAccess(db as never, 'company-1', 'period-1', 'user-1', {
      allowIxbrlFeature: false,
      requireWrite: true,
    })).resolves.toMatchObject({ allowed: false, reason: 'missing_entitlement' })
    expect(checkFeatureAccessMock).not.toHaveBeenCalled()
  })

  it('passes requireWrite to the canonical resolver and fails closed on write denial', async () => {
    canonicalRow = denied('YEAR_END_COMPANY_WRITE_FORBIDDEN')
    await expect(resolveYearEndAccess(db as never, 'company-1', 'period-1', 'user-1', {
      requireWrite: true,
    })).resolves.toMatchObject({ allowed: false, reason: 'unauthorized' })
    expect(db.rpc).toHaveBeenCalledWith('resolve_year_end_period_capability_for_user', expect.objectContaining({
      p_require_write: true,
    }))
  })

  it('still permits the explicitly requested iXBRL feature, but only after canonical access', async () => {
    checkFeatureAccessMock.mockResolvedValue({ allowed: true, sourceId: 'ix-1' })
    canonicalRow = denied('YEAR_END_PERIOD_PURCHASE_REQUIRED')
    await expect(resolveYearEndAccess(db as never, 'company-1', 'period-1', 'user-1', {
      allowIxbrlFeature: true,
    })).resolves.toMatchObject({
      allowed: true,
      source: 'ixbrl_feature_entitlement',
      sourceId: 'ix-1',
    })
    // Regression: the entitlement must never be resolved *instead of* the
    // canonical actor/company/period capability.
    expect(db.rpc).toHaveBeenCalledWith('resolve_year_end_period_capability_for_user', expect.objectContaining({
      p_company_id: 'company-1',
      p_fiscal_period_id: 'period-1',
      p_user_id: 'user-1',
    }))
  })

  // R-01 regression suite. The iXBRL grant is company-wide; before this it was
  // resolved *before* the canonical capability and returned access directly,
  // which let it stand in for authorization rather than for payment.
  describe('R-01 — iXBRL entitlement must not bypass authorization', () => {
    it('does not let the iXBRL feature grant write capability to a read-only member', async () => {
      checkFeatureAccessMock.mockResolvedValue({ allowed: true, sourceId: 'ix-1' })
      canonicalRow = denied('YEAR_END_COMPANY_WRITE_FORBIDDEN')

      await expect(resolveYearEndAccess(db as never, 'company-1', 'period-1', 'viewer-1', {
        allowIxbrlFeature: true,
        requireWrite: true,
      })).resolves.toMatchObject({ allowed: false, reason: 'unauthorized' })

      expect(db.rpc).toHaveBeenCalledWith('resolve_year_end_period_capability_for_user', expect.objectContaining({
        p_require_write: true,
      }))
      expect(checkFeatureAccessMock).not.toHaveBeenCalled()
    })

    it('does not let the iXBRL feature grant access to another tenant', async () => {
      checkFeatureAccessMock.mockResolvedValue({ allowed: true, sourceId: 'ix-1' })
      canonicalRow = denied('YEAR_END_COMPANY_ACCESS_FORBIDDEN')

      await expect(resolveYearEndAccess(db as never, 'company-b', 'period-b', 'user-of-company-a', {
        allowIxbrlFeature: true,
      })).resolves.toMatchObject({ allowed: false, reason: 'unauthorized' })
      expect(checkFeatureAccessMock).not.toHaveBeenCalled()
    })

    it('does not let the iXBRL feature unlock a period the actor may not use', async () => {
      checkFeatureAccessMock.mockResolvedValue({ allowed: true, sourceId: 'ix-1' })
      canonicalRow = denied('YEAR_END_PERIOD_FORBIDDEN')

      await expect(resolveYearEndAccess(db as never, 'company-1', 'other-period', 'user-1', {
        allowIxbrlFeature: true,
      })).resolves.toMatchObject({ allowed: false, reason: 'unauthorized' })
      expect(checkFeatureAccessMock).not.toHaveBeenCalled()
    })

    it('fails closed on a resolver error instead of falling back to the entitlement', async () => {
      checkFeatureAccessMock.mockResolvedValue({ allowed: true, sourceId: 'ix-1' })
      canonicalError = { message: 'database unavailable' }

      await expect(resolveYearEndAccess(db as never, 'company-1', 'period-1', 'user-1', {
        allowIxbrlFeature: true,
      })).resolves.toMatchObject({ allowed: false, reason: 'database_error' })
      expect(checkFeatureAccessMock).not.toHaveBeenCalled()
    })
  })

  describe('R-01 — reports.core must not bypass authorization', () => {
    it('denies a report for another tenant even with a reports.core entitlement', async () => {
      checkFeatureAccessMock.mockResolvedValue({ allowed: true, sourceId: 'rep-1' })
      canonicalRow = denied('YEAR_END_COMPANY_ACCESS_FORBIDDEN')

      await expect(
        requireYearEndReportAccess(db as never, 'company-b', 'user-of-company-a', 'period-b'),
      ).resolves.toMatchObject({ allowed: false, reason: 'unauthorized' })
      expect(checkFeatureAccessMock).not.toHaveBeenCalled()
    })

    it('still allows an authorized actor to read reports on reports.core alone', async () => {
      checkFeatureAccessMock.mockResolvedValue({ allowed: true, sourceId: 'rep-1' })
      canonicalRow = denied('YEAR_END_PERIOD_PURCHASE_REQUIRED')

      await expect(
        requireYearEndReportAccess(db as never, 'company-1', 'user-1', 'period-1'),
      ).resolves.toMatchObject({ allowed: true, source: 'feature_entitlement', sourceId: 'rep-1' })
      expect(checkFeatureAccessMock).toHaveBeenCalledWith(expect.anything(), 'company-1', 'reports.core')
    })

    it('fails closed on a resolver error instead of falling back to reports.core', async () => {
      checkFeatureAccessMock.mockResolvedValue({ allowed: true, sourceId: 'rep-1' })
      canonicalError = { message: 'database unavailable' }

      await expect(
        requireYearEndReportAccess(db as never, 'company-1', 'user-1', 'period-1'),
      ).resolves.toMatchObject({ allowed: false, reason: 'database_error' })
      expect(checkFeatureAccessMock).not.toHaveBeenCalled()
    })
  })

  it('audits platform bypass with actor, target company and request id', async () => {
    canonicalRow = allowed('platform_admin_bypass')
    const decision = await requireYearEndAccess(db as never, 'company-1', 'admin-1', 'period-1', {
      operation: 'period.year_end', requestId: 'req-1', requireWrite: true,
    })
    expect(decision).toMatchObject({ allowed: true, source: 'platform_admin_bypass' })
    expect(auditRows[0]).toMatchObject({
      user_id: 'admin-1',
      record_id: 'period-1',
      new_state: expect.objectContaining({ company_id: 'company-1', request_id: 'req-1' }),
    })
  })

  it('fails closed when a platform bypass cannot be audited', async () => {
    canonicalRow = allowed('platform_admin_bypass')
    auditError = { message: 'rls denied' }
    await expect(requireYearEndAccess(db as never, 'company-1', 'admin-1', 'period-1')).rejects.toThrow(/audit_log insert failed/)
  })
})
