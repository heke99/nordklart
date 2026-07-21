import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import {
  auditPlatformSieImportOperation,
  resolveSieImportAccess,
} from '@/lib/import/access'

type Setup = {
  company?: { id: string } | null
  companyError?: { message: string } | null
  access?: Record<string, unknown> | null
  accessError?: { message: string } | null
  bookkeepingFeature?: boolean
  yearEndFeature?: boolean
  ixbrlFeature?: boolean
  featureError?: { message: string } | null
  purchases?: Array<Record<string, unknown>>
  purchaseError?: { message: string } | null
  auditError?: { message: string } | null
}

function thenable<T>(value: T) {
  return {
    then(resolve: (result: T) => unknown, reject?: (reason: unknown) => unknown) {
      return Promise.resolve(value).then(resolve, reject)
    },
  }
}

function mockDb(setup: Setup = {}) {
  const auditRows: Record<string, unknown>[] = []
  const company = setup.company === undefined ? { id: 'company-1' } : setup.company
  const access = setup.access === undefined
    ? {
        effective_role: 'company_admin',
        can_read: true,
        can_write: true,
        can_manage_platform: false,
      }
    : setup.access

  const db = {
    auditRows,
    from: vi.fn((table: string) => {
      if (table === 'companies') {
        const chain: Record<string, unknown> = {}
        chain.select = vi.fn(() => chain)
        chain.eq = vi.fn(() => chain)
        chain.is = vi.fn(() => chain)
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: company, error: setup.companyError ?? null })
        return chain
      }
      if (table === 'one_time_purchases') {
        const chain: Record<string, unknown> = {}
        chain.select = vi.fn(() => chain)
        chain.eq = vi.fn(() => chain)
        chain.order = vi.fn(() => chain)
        chain.then = thenable({ data: setup.purchases ?? [], error: setup.purchaseError ?? null }).then
        return chain
      }
      if (table === 'audit_log') {
        return {
          insert: vi.fn((row: Record<string, unknown>) => {
            auditRows.push(row)
            return Promise.resolve({ error: setup.auditError ?? null })
          }),
        }
      }
      throw new Error(`Unexpected table ${table}`)
    }),
    rpc: vi.fn((name: string, args: Record<string, unknown>) => {
      if (name === 'resolve_company_access_for_user') {
        return Promise.resolve({ data: access ? [access] : [], error: setup.accessError ?? null })
      }
      if (name === 'company_feature_access') {
        const featureCode = args.p_feature_code
        const allowed = featureCode === 'bookkeeping.core'
          ? setup.bookkeepingFeature === true
          : featureCode === 'year_end.projects'
            ? setup.yearEndFeature === true
            : setup.ixbrlFeature === true
        return Promise.resolve({ data: [{ allowed }], error: setup.featureError ?? null })
      }
      throw new Error(`Unexpected RPC ${name}`)
    }),
  }
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('resolveSieImportAccess', () => {
  it('accepts ordinary bookkeeping access', async () => {
    const result = await resolveSieImportAccess(
      mockDb({ bookkeepingFeature: true }) as never,
      'user-1',
      'company-1',
    )
    expect(result).toMatchObject({
      allowed: true,
      canWrite: true,
      mode: 'bookkeeping',
      allowedPeriodIds: null,
    })
  })

  it('accepts year-end-only access without bookkeeping.core', async () => {
    const result = await resolveSieImportAccess(
      mockDb({ yearEndFeature: true }) as never,
      'accountant-1',
      'company-1',
    )
    expect(result).toMatchObject({
      allowed: true,
      mode: 'year_end',
      allowedPeriodIds: null,
    })
  })

  it('lets platform admin operate after canonical company access resolution', async () => {
    const result = await resolveSieImportAccess(mockDb({
      access: {
        effective_role: 'platform_admin',
        can_read: true,
        can_write: true,
        can_manage_platform: true,
      },
    }) as never, 'admin-1', 'company-1')
    expect(result).toMatchObject({
      allowed: true,
      canWrite: true,
      mode: 'platform',
      allowedPeriodIds: null,
    })
  })

  it('restricts an active one-off purchase to its purchased fiscal period', async () => {
    const result = await resolveSieImportAccess(mockDb({
      purchases: [{
        id: 'purchase-1',
        fiscal_period_id: 'period-1',
        permanent_access: false,
        access_starts_at: null,
        access_expires_at: null,
        status: 'paid',
      }],
    }) as never, 'owner-1', 'company-1')
    expect(result).toMatchObject({
      allowed: true,
      canWrite: true,
      mode: 'one_off',
      allowedPeriodIds: ['period-1'],
    })
  })

  it('does not activate a purchase before access_starts_at', async () => {
    const result = await resolveSieImportAccess(mockDb({
      purchases: [{
        id: 'purchase-future',
        fiscal_period_id: 'period-1',
        permanent_access: true,
        access_starts_at: '2999-01-01T00:00:00Z',
        access_expires_at: null,
        status: 'paid',
      }],
    }) as never, 'owner-1', 'company-1')
    expect(result).toMatchObject({ allowed: false, reason: 'one_off_expired' })
  })

  it('denies a user from another tenant before using service-role data', async () => {
    const result = await resolveSieImportAccess(
      mockDb({ access: null, bookkeepingFeature: true }) as never,
      'outsider-1',
      'company-1',
    )
    expect(result).toMatchObject({ allowed: false, reason: 'permission_denied' })
  })

  it('fails closed on entitlement database errors', async () => {
    const result = await resolveSieImportAccess(
      mockDb({ purchaseError: { message: 'database unavailable' } }) as never,
      'user-1',
      'company-1',
    )
    expect(result).toMatchObject({
      allowed: false,
      reason: 'database_error',
      databaseError: 'database unavailable',
    })
  })
})

describe('auditPlatformSieImportOperation', () => {
  it('writes a company-scoped security event', async () => {
    const db = mockDb()
    await auditPlatformSieImportOperation(db as never, {
      actorUserId: 'admin-1',
      companyId: 'company-1',
      operation: 'sie_import.execute',
      requestId: 'req-1',
    })
    expect(db.auditRows[0]).toMatchObject({
      user_id: 'admin-1',
      company_id: 'company-1',
      action: 'SECURITY_EVENT',
      new_state: expect.objectContaining({ request_id: 'req-1' }),
    })
  })

  it('fails closed when audit persistence fails', async () => {
    await expect(auditPlatformSieImportOperation(mockDb({
      auditError: { message: 'write denied' },
    }) as never, {
      actorUserId: 'admin-1',
      companyId: 'company-1',
      operation: 'sie_import.execute',
      requestId: 'req-1',
    })).rejects.toThrow('Audit log write failed: write denied')
  })
})
