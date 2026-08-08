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

describe('resolveSieImportAccess — entitlement never grants write', () => {
  /**
   * A commercial entitlement decides WHETHER a feature is available. It must
   * never decide WHO may write — that comes from the canonical resolver alone.
   *
   * This path used to compute `canWrite: access.can_write || roleCanOperateOneOff`,
   * where the second term re-derived write access from effective_role. The role
   * list matched the one can_write uses, so it looked equivalent, but it dropped
   * the membership_status condition: resolve_company_access_for_user computes
   *
   *     can_write = effective_role IN (...) AND membership_status = 'active'
   *
   * while company_member_is_active() admits 'active' AND 'active_limited'. An
   * `active_limited` owner therefore resolves with can_write = false, still
   * satisfies the role list, and was handed write access anyway.
   */
  const activeLimitedOwner = {
    effective_role: 'company_owner',
    can_read: true,
    // Exactly what the resolver returns for membership_status = 'active_limited'.
    can_write: false,
    can_manage_platform: false,
  }

  const activePurchase = {
    id: 'purchase-1',
    fiscal_period_id: 'period-1',
    permanent_access: true,
    access_starts_at: null,
    access_expires_at: null,
    status: 'active',
  }

  it('does not let a one-off purchase grant write to a reduced-capability member', async () => {
    const result = await resolveSieImportAccess(
      mockDb({ access: activeLimitedOwner, purchases: [activePurchase] }) as never,
      'user-1',
      'company-1',
    )

    // The purchase legitimately opens the feature…
    expect(result.allowed).toBe(true)
    expect(result.mode).toBe('one_off')
    // …but it must not confer write capability the resolver withheld.
    expect(result.canWrite).toBe(false)
  })

  it('still grants write to a fully active member with the same purchase', async () => {
    // Without this the fix could be "deny everyone", which would look identical.
    const result = await resolveSieImportAccess(
      mockDb({
        access: { ...activeLimitedOwner, can_write: true },
        purchases: [activePurchase],
      }) as never,
      'user-1',
      'company-1',
    )
    expect(result.allowed).toBe(true)
    expect(result.mode).toBe('one_off')
    expect(result.canWrite).toBe(true)
  })

  it('never reports canWrite for a member the resolver denies write, on any path', async () => {
    // The same invariant across every mode the resolver can return, so a future
    // branch cannot reintroduce the shortcut somewhere else.
    const modes: Array<{ label: string; setup: Record<string, unknown> }> = [
      { label: 'bookkeeping', setup: { bookkeepingFeature: true } },
      { label: 'year_end', setup: { yearEndFeature: true } },
      { label: 'one_off', setup: { purchases: [activePurchase] } },
    ]

    for (const mode of modes) {
      const result = await resolveSieImportAccess(
        mockDb({ access: activeLimitedOwner, ...mode.setup }) as never,
        'user-1',
        'company-1',
      )
      expect(result.canWrite, `${mode.label} granted write to a can_write=false member`).toBe(false)
    }
  })

  it('denies read entirely when the resolver denies read', async () => {
    // Entitlement must not substitute for membership either.
    const result = await resolveSieImportAccess(
      mockDb({
        access: { effective_role: 'read_only', can_read: false, can_write: false, can_manage_platform: false },
        purchases: [activePurchase],
        yearEndFeature: true,
      }) as never,
      'user-1',
      'company-1',
    )
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('permission_denied')
  })
})
