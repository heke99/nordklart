import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  auditPlatformFiscalPeriodOperation,
  resolveFiscalPeriodAccess,
} from '../period-access'

type Config = {
  company?: { id: string } | null
  companyError?: { message: string } | null
  access?: Record<string, unknown> | null
  accessError?: { message: string } | null
  featureAllowed?: boolean
  purchases?: Array<Record<string, unknown>>
  purchasesError?: { message: string } | null
  auditError?: { message: string } | null
}

function dbFor(config: Config) {
  const auditInsert = vi.fn().mockResolvedValue({ error: config.auditError ?? null })
  const db = {
    rpc: vi.fn(async (name: string) => {
      if (name === 'resolve_company_access_for_user') {
        return { data: config.access ? [config.access] : [], error: config.accessError ?? null }
      }
      if (name === 'company_feature_access') {
        return { data: [{ allowed: config.featureAllowed ?? false }], error: null }
      }
      throw new Error(`unexpected rpc ${name}`)
    }),
    from: vi.fn((table: string) => {
      if (table === 'companies') {
        return {
          select: () => ({
            eq: () => ({
              is: () => ({
                maybeSingle: async () => ({
                  data: config.company === undefined ? { id: 'company-1' } : config.company,
                  error: config.companyError ?? null,
                }),
              }),
            }),
          }),
        }
      }
      if (table === 'one_time_purchases') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: async () => ({
                  data: config.purchases ?? [],
                  error: config.purchasesError ?? null,
                }),
              }),
            }),
          }),
        }
      }
      if (table === 'audit_log') return { insert: auditInsert }
      throw new Error(`unexpected table ${table}`)
    }),
  }
  return { db, auditInsert }
}

const directAccess = {
  company_id: 'company-1',
  access_source: 'direct',
  effective_role: 'company_admin',
  can_read: true,
  can_write: true,
  can_manage_platform: false,
}

describe('resolveFiscalPeriodAccess', () => {
  beforeEach(() => vi.clearAllMocks())

  it('allows a subscribed company without depending on bookkeeping.core', async () => {
    const { db } = dbFor({ access: directAccess, featureAllowed: true })
    await expect(resolveFiscalPeriodAccess(db as never, 'user-1', 'company-1')).resolves.toMatchObject({
      allowed: true,
      accessSource: 'feature_entitlement',
      allowedPeriodIds: null,
      canCreateFiscalYear: true,
    })
  })

  it('does not reopen fiscal-year writes when canonical access is read-only', async () => {
    const { db } = dbFor({
      access: { ...directAccess, can_write: false, effective_role: 'client_user' },
      purchases: [{
        id: 'purchase-1', fiscal_period_id: null, permanent_access: true,
        access_starts_at: null, access_expires_at: null, status: 'paid',
      }],
    })
    await expect(resolveFiscalPeriodAccess(db as never, 'user-1', 'company-1')).resolves.toMatchObject({
      allowed: true,
      accessSource: 'one_time_purchase',
      canWrite: false,
      canCreateFiscalYear: false,
      unassignedPurchaseId: 'purchase-1',
      allowedPeriodIds: [],
    })
  })

  it('limits one-off access to the purchased fiscal period', async () => {
    const { db } = dbFor({
      access: directAccess,
      purchases: [{
        id: 'purchase-1', fiscal_period_id: 'period-1', permanent_access: true,
        access_starts_at: null, access_expires_at: null, status: 'active',
      }],
    })
    const result = await resolveFiscalPeriodAccess(db as never, 'user-1', 'company-1')
    expect(result.allowedPeriodIds).toEqual(['period-1'])
    expect(result.canCreateFiscalYear).toBe(false)
  })

  it('allows platform admin explicitly with unrestricted period scope', async () => {
    const { db } = dbFor({
      access: { ...directAccess, effective_role: 'platform_admin', can_manage_platform: true },
    })
    await expect(resolveFiscalPeriodAccess(db as never, 'admin-1', 'company-1')).resolves.toMatchObject({
      allowed: true,
      accessSource: 'platform_admin',
      allowedPeriodIds: null,
    })
  })

  it('denies a user from another tenant', async () => {
    const { db } = dbFor({ access: null })
    await expect(resolveFiscalPeriodAccess(db as never, 'user-2', 'company-1')).resolves.toMatchObject({
      allowed: false,
      reason: 'permission_denied',
    })
  })

  it('fails closed on database errors', async () => {
    const { db } = dbFor({ access: directAccess, companyError: { message: 'db down' } })
    await expect(resolveFiscalPeriodAccess(db as never, 'user-1', 'company-1')).resolves.toMatchObject({
      allowed: false,
      reason: 'database_error',
      databaseError: 'db down',
    })
  })
})

describe('auditPlatformFiscalPeriodOperation', () => {
  it('writes the actor, target company and request id', async () => {
    const { db, auditInsert } = dbFor({})
    await auditPlatformFiscalPeriodOperation(db as never, {
      actorUserId: 'admin-1', companyId: 'company-1', operation: 'list', requestId: 'req-1',
    })
    expect(auditInsert).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 'admin-1',
      company_id: 'company-1',
      new_state: expect.objectContaining({ request_id: 'req-1' }),
    }))
  })

  it('fails closed when the audit row cannot be persisted', async () => {
    const { db } = dbFor({ auditError: { message: 'rls denied' } })
    await expect(auditPlatformFiscalPeriodOperation(db as never, {
      actorUserId: 'admin-1', companyId: 'company-1', operation: 'create',
    })).rejects.toThrow(/Audit log write failed/)
  })
})
