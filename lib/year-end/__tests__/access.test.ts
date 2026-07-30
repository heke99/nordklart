import { beforeEach, describe, expect, it, vi } from 'vitest'

const checkFeatureAccessMock = vi.fn()
vi.mock('@/lib/platform/entitlements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/entitlements')>()
  return { ...actual, checkFeatureAccess: (...args: unknown[]) => checkFeatureAccessMock(...args) }
})

let accessRow: Record<string, unknown> | null
let purchaseRow: Record<string, unknown> | null
let purchaseError: { message: string } | null
let platformRoleRow: Record<string, unknown> | null
let auditError: { message: string } | null
const purchaseFilters: Array<[string, unknown]> = []
const auditRows: Array<Record<string, unknown>> = []

function chainFor(table: string) {
  const chain: Record<string, unknown> = {}
  chain.select = () => chain
  chain.eq = (column: string, value: unknown) => {
    if (table === 'one_time_purchases') purchaseFilters.push([column, value])
    return chain
  }
  chain.is = () => chain
  chain.in = () => chain
  chain.order = () => chain
  chain.limit = () => chain
  chain.maybeSingle = async () => ({
    data: table === 'one_time_purchases' ? purchaseRow : table === 'platform_roles' ? platformRoleRow : null,
    error: table === 'one_time_purchases' ? purchaseError : null,
  })
  chain.insert = async (row: Record<string, unknown>) => {
    if (table === 'audit_log') auditRows.push(row)
    return { data: null, error: auditError }
  }
  return chain
}

const db = {
  rpc: vi.fn(async (name: string) => {
    if (name !== 'resolve_company_access_for_user') throw new Error(`unexpected rpc ${name}`)
    return { data: accessRow ? [accessRow] : [], error: null }
  }),
  from: (table: string) => chainFor(table),
}

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => db }))

import {
  requireYearEndAccess,
  requireYearEndReportAccess,
  resolveYearEndAccess,
} from '../access'

const companyAccess = {
  can_read: true,
  can_write: true,
  can_manage_platform: false,
  effective_role: 'company_admin',
}

describe('year-end period-scoped access', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    accessRow = companyAccess
    purchaseRow = null
    purchaseError = null
    platformRoleRow = null
    auditError = null
    purchaseFilters.length = 0
    auditRows.length = 0
    checkFeatureAccessMock.mockResolvedValue({ allowed: false, reason: 'missing_entitlement' })
  })

  it('allows a subscription for any period after canonical tenant access', async () => {
    checkFeatureAccessMock.mockResolvedValue({ allowed: true, sourceId: 'sub-1' })
    await expect(resolveYearEndAccess(db as never, 'company-1', 'period-1', 'user-1')).resolves.toMatchObject({
      allowed: true, source: 'feature_entitlement', sourceId: 'sub-1',
    })
  })

  it('allows an active one-time purchase only for the exact period', async () => {
    purchaseRow = { id: 'purchase-1', permanent_access: true, access_starts_at: null, access_expires_at: null }
    const decision = await resolveYearEndAccess(db as never, 'company-1', 'period-1', 'user-1')
    expect(decision).toMatchObject({ allowed: true, source: 'one_time_purchase' })
    expect(purchaseFilters).toEqual(expect.arrayContaining([
      ['company_id', 'company-1'], ['fiscal_period_id', 'period-1'], ['purchase_type', 'year_end'],
    ]))
  })

  it('allows a valid one-time purchase even if the company-wide feature resolver is unavailable', async () => {
    checkFeatureAccessMock.mockResolvedValue({ allowed: false, reason: 'database_error' })
    purchaseRow = { id: 'purchase-1', permanent_access: true, access_starts_at: null, access_expires_at: null }

    await expect(resolveYearEndAccess(db as never, 'company-1', 'period-1', 'user-1')).resolves.toMatchObject({
      allowed: true,
      source: 'one_time_purchase',
      sourceId: 'purchase-1',
    })
  })

  it('allows purchased-period reports without unlocking unrelated periods', async () => {
    purchaseRow = {
      id: 'purchase-1',
      permanent_access: true,
      access_starts_at: null,
      access_expires_at: null,
    }
    const decision = await requireYearEndReportAccess(
      db as never,
      'company-1',
      'user-1',
      'period-1',
    )
    expect(decision).toMatchObject({
      allowed: true,
      source: 'one_time_purchase',
      sourceId: 'purchase-1',
    })
    expect(purchaseFilters).toContainEqual(['fiscal_period_id', 'period-1'])
  })

  it('reports a technical failure instead of sending the customer to purchase', async () => {
    checkFeatureAccessMock.mockResolvedValue({ allowed: false, reason: 'database_error' })

    await expect(resolveYearEndAccess(db as never, 'company-1', 'period-1', 'user-1')).resolves.toMatchObject({
      allowed: false,
      reason: 'database_error',
    })
  })

  it('reports a one-time purchase query failure as a technical failure', async () => {
    purchaseError = { message: 'database unavailable' }

    await expect(resolveYearEndAccess(db as never, 'company-1', 'period-1', 'user-1')).resolves.toMatchObject({
      allowed: false,
      reason: 'database_error',
    })
  })

  it('denies another tenant before entitlement checks', async () => {
    accessRow = null
    await expect(resolveYearEndAccess(db as never, 'company-1', 'period-1', 'outsider')).resolves.toMatchObject({
      allowed: false, reason: 'unauthorized',
    })
    expect(checkFeatureAccessMock).not.toHaveBeenCalled()
  })

  it('does not let iXBRL-only access authorize an economic mutation', async () => {
    checkFeatureAccessMock.mockImplementation(async (_db, _company, feature) => ({
      allowed: feature === 'year_end.ixbrl', sourceId: 'ix-1',
    }))
    await expect(resolveYearEndAccess(db as never, 'company-1', 'period-1', 'user-1', {
      allowIxbrlFeature: false,
      requireWrite: true,
    })).resolves.toMatchObject({ allowed: false, reason: 'missing_entitlement' })
  })

  it('does not reopen canonical can_write=false through a role label', async () => {
    accessRow = {
      ...companyAccess,
      can_write: false,
      effective_role: 'client_user',
    }
    purchaseRow = {
      id: 'purchase-1',
      permanent_access: true,
      access_starts_at: null,
      access_expires_at: null,
    }

    await expect(resolveYearEndAccess(
      db as never,
      'company-1',
      'period-1',
      'user-1',
      { requireWrite: true },
    )).resolves.toMatchObject({
      allowed: false,
      reason: 'unauthorized',
    })
    expect(checkFeatureAccessMock).not.toHaveBeenCalled()
  })

  it('audits platform bypass with actor, target company and request id', async () => {
    accessRow = { ...companyAccess, effective_role: 'platform_admin', can_manage_platform: true }
    const decision = await requireYearEndAccess(db as never, 'company-1', 'admin-1', 'period-1', {
      operation: 'period.year_end', requestId: 'req-1', requireWrite: true,
    })
    expect(decision).toMatchObject({ allowed: true, source: 'platform_admin_bypass' })
    expect(auditRows[0]).toMatchObject({
      user_id: 'admin-1', record_id: 'period-1',
      new_state: expect.objectContaining({ company_id: 'company-1', request_id: 'req-1' }),
    })
  })

  it('fails closed when a platform bypass cannot be audited', async () => {
    accessRow = { ...companyAccess, effective_role: 'platform_admin', can_manage_platform: true }
    auditError = { message: 'rls denied' }
    await expect(requireYearEndAccess(db as never, 'company-1', 'admin-1', 'period-1')).rejects.toThrow(/audit_log insert failed/)
  })
})
